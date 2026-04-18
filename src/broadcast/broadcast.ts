/**
 * Broadcast engine — throttled, idempotent, opt-in-aware dispatch of a
 * templated message to every contact matching a segment.
 *
 * Three pieces:
 *   1. createBroadcast(spec) — resolves the segment, inserts a broadcasts
 *      row + one broadcast_deliveries row per targeted contact. Idempotent
 *      via broadcast_key (if you re-run with the same key, you get the same
 *      broadcast back, no duplicate deliveries).
 *   2. executeBroadcast(broadcastId, {transport, twilioConfig, throttleMs?}) —
 *      iterates pending deliveries in order, renders each template, calls
 *      sendOutbound, marks status. Respects the throttle between sends so
 *      Twilio doesn't rate-limit us.
 *   3. renderTemplate(template, contact) — deterministic Mustache-lite
 *      substitution of {{first_name}} / {{last_name}} / {{language}} / tags.
 *
 * Every primitive is synchronous except the dispatch loop itself, which
 * awaits each Twilio POST. Designed to be invoked from a CLI script first,
 * then later from a scheduled task once we have evidence it works.
 */
import crypto from 'crypto';

import { getDatabase } from '../db.js';
import { logger } from '../logger.js';
import {
  BusinessTwilioConfig,
  OutboundMessagingError,
  TwilioTransport,
  sendOutbound,
} from '../channels/messaging/outbound-twilio.js';

import {
  ContactChannel,
  ContactPurpose,
  ContactRecord,
  ContactSegment,
  findContacts,
  getContactById,
  isEligibleFor,
} from './contacts.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface BroadcastSpec {
  /**
   * A caller-supplied unique key for this broadcast. Re-running with the
   * same key returns the existing broadcast — enables safe retries after a
   * crash without double-delivery. Suggested shape:
   *   `${businessSlug}:${slugOfCampaign}:${yyyyMmDd}`
   */
  broadcastKey: string;
  businessSlug: string;
  channel: ContactChannel;
  purpose: ContactPurpose;
  /**
   * Template string — see `renderTemplate` for supported variables.
   * Must have been approved by Meta when used with WhatsApp + marketing.
   */
  template: string;
  segment: ContactSegment;
}

export interface BroadcastRecord {
  id: number;
  broadcastKey: string;
  businessSlug: string;
  channel: ContactChannel;
  purpose: ContactPurpose;
  template: string;
  segment: ContactSegment;
  status: 'queued' | 'running' | 'completed' | 'failed';
  totalTargets: number;
  totalSent: number;
  totalSkipped: number;
  totalFailed: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface BroadcastDelivery {
  id: number;
  broadcastId: number;
  contactId: number;
  status: 'pending' | 'sent' | 'skipped' | 'failed';
  renderedBody: string | null;
  twilioSid: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  attemptedAt: string | null;
}

export interface BroadcastExecutionSummary {
  broadcastId: number;
  sent: number;
  skipped: number;
  failed: number;
  elapsedMs: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

interface BroadcastRow {
  id: number;
  broadcast_key: string;
  business_slug: string;
  channel: string;
  purpose: string;
  template: string;
  segment_json: string;
  status: string;
  total_targets: number;
  total_sent: number;
  total_skipped: number;
  total_failed: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

function rowToBroadcast(row: BroadcastRow): BroadcastRecord {
  return {
    id: row.id,
    broadcastKey: row.broadcast_key,
    businessSlug: row.business_slug,
    channel: row.channel as ContactChannel,
    purpose: row.purpose as ContactPurpose,
    template: row.template,
    segment: JSON.parse(row.segment_json) as ContactSegment,
    status: row.status as BroadcastRecord['status'],
    totalTargets: row.total_targets,
    totalSent: row.total_sent,
    totalSkipped: row.total_skipped,
    totalFailed: row.total_failed,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

interface DeliveryRow {
  id: number;
  broadcast_id: number;
  contact_id: number;
  status: string;
  rendered_body: string | null;
  twilio_sid: string | null;
  error_code: string | null;
  error_message: string | null;
  attempted_at: string | null;
}

function rowToDelivery(row: DeliveryRow): BroadcastDelivery {
  return {
    id: row.id,
    broadcastId: row.broadcast_id,
    contactId: row.contact_id,
    status: row.status as BroadcastDelivery['status'],
    renderedBody: row.rendered_body,
    twilioSid: row.twilio_sid,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    attemptedAt: row.attempted_at,
  };
}

// ── Template rendering ────────────────────────────────────────────────────

const TEMPLATE_TOKEN_RE = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi;

/**
 * Render a Mustache-lite template against a contact. Supported variables:
 *
 *   {{first_name}}   — contact.firstName or '' when null
 *   {{last_name}}    — contact.lastName or ''
 *   {{language}}     — contact.language or ''
 *   {{business}}     — contact.businessSlug
 *   {{tag:<name>}}   — 'yes' when the contact has the tag, '' otherwise
 *
 * Unknown tokens are stripped from the output (empty string). Everything
 * else in the template is passed through untouched. Intentionally tiny —
 * we don't want template injection risks from user-editable content.
 */
export function renderTemplate(template: string, contact: ContactRecord): string {
  const rendered = template.replace(TEMPLATE_TOKEN_RE, (_match, varName: string) => {
    const lower = varName.toLowerCase();
    if (lower === 'first_name') return contact.firstName ?? '';
    if (lower === 'last_name') return contact.lastName ?? '';
    if (lower === 'language') return contact.language ?? '';
    if (lower === 'business') return contact.businessSlug;
    if (lower.startsWith('tag_')) {
      const tag = lower.slice(4);
      return contact.tags.map((t) => t.toLowerCase()).includes(tag) ? 'yes' : '';
    }
    return '';
  });
  return rendered.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

// ── Create ────────────────────────────────────────────────────────────────

/**
 * Resolve the segment and insert the broadcast + per-recipient delivery
 * rows. Idempotent: same broadcast_key returns the existing broadcast
 * without changing deliveries (so a retry after crash doesn't duplicate).
 */
export function createBroadcast(spec: BroadcastSpec): BroadcastRecord {
  validateSpec(spec);
  const db = getDatabase();

  // Reuse if the same key already exists.
  const existing = db
    .prepare(`SELECT * FROM broadcasts WHERE broadcast_key = ? LIMIT 1`)
    .get(spec.broadcastKey) as BroadcastRow | undefined;
  if (existing) {
    return rowToBroadcast(existing);
  }

  const targets = findContacts(spec.segment);
  const now = nowIso();

  const insertBroadcast = db.prepare(
    `INSERT INTO broadcasts
       (broadcast_key, business_slug, channel, purpose,
        template, segment_json,
        status, total_targets, total_sent, total_skipped, total_failed,
        created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 0, 0, 0, ?)`,
  );
  const insertDelivery = db.prepare(
    `INSERT INTO broadcast_deliveries (broadcast_id, contact_id, status)
     VALUES (?, ?, 'pending')`,
  );

  const txn = db.transaction(() => {
    const info = insertBroadcast.run(
      spec.broadcastKey,
      spec.businessSlug,
      spec.channel,
      spec.purpose,
      spec.template,
      JSON.stringify(spec.segment),
      targets.length,
      now,
    );
    const broadcastId = info.lastInsertRowid as number;
    for (const contact of targets) {
      insertDelivery.run(broadcastId, contact.id);
    }
    return broadcastId;
  });

  const broadcastId = txn();
  logger.info(
    {
      broadcastKey: spec.broadcastKey,
      businessSlug: spec.businessSlug,
      channel: spec.channel,
      purpose: spec.purpose,
      targets: targets.length,
    },
    'broadcast: created',
  );
  return getBroadcastById(broadcastId)!;
}

function validateSpec(spec: BroadcastSpec): void {
  if (!spec.broadcastKey || spec.broadcastKey.length < 3) {
    throw new Error('createBroadcast: broadcastKey must be at least 3 chars');
  }
  if (!spec.template || spec.template.trim().length === 0) {
    throw new Error('createBroadcast: template must be non-empty');
  }
  if (spec.segment.businessSlug !== spec.businessSlug) {
    throw new Error('createBroadcast: segment.businessSlug must match spec.businessSlug');
  }
  if (spec.segment.channel !== spec.channel) {
    throw new Error('createBroadcast: segment.channel must match spec.channel');
  }
  if (spec.segment.purpose !== spec.purpose) {
    throw new Error('createBroadcast: segment.purpose must match spec.purpose');
  }
}

// ── Fetch ────────────────────────────────────────────────────────────────

export function getBroadcastById(id: number): BroadcastRecord | null {
  const row = getDatabase()
    .prepare(`SELECT * FROM broadcasts WHERE id = ? LIMIT 1`)
    .get(id) as BroadcastRow | undefined;
  return row ? rowToBroadcast(row) : null;
}

export function getBroadcastByKey(key: string): BroadcastRecord | null {
  const row = getDatabase()
    .prepare(`SELECT * FROM broadcasts WHERE broadcast_key = ? LIMIT 1`)
    .get(key) as BroadcastRow | undefined;
  return row ? rowToBroadcast(row) : null;
}

export function getDeliveries(broadcastId: number): BroadcastDelivery[] {
  const rows = getDatabase()
    .prepare(
      `SELECT * FROM broadcast_deliveries WHERE broadcast_id = ? ORDER BY id`,
    )
    .all(broadcastId) as DeliveryRow[];
  return rows.map(rowToDelivery);
}

// ── Execute ──────────────────────────────────────────────────────────────

export interface ExecuteOptions {
  /** Twilio transport — inject from createTwilioTransport() or a stub in tests. */
  transport: TwilioTransport;
  /** Business's channels.twilio block from businesses.json. */
  twilioConfig: BusinessTwilioConfig;
  /**
   * Minimum gap between sends, in ms. Twilio's hard SMS limit is ~1/sec per
   * number; WhatsApp is higher but still bounded. Default 1000 ms.
   */
  throttleMs?: number;
  /**
   * Max pending deliveries to process in this call. Default 10000 (effectively
   * unbounded). Use to cap a single run when dispatching is chunked.
   */
  maxPerRun?: number;
  /**
   * Hook called between each send. Lets tests advance fake timers and lets
   * real callers abort mid-flight. Return false to stop the loop.
   */
  tick?: (delivery: BroadcastDelivery) => void | Promise<void>;
  /** Sleep implementation — inject a stub in tests. Defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_THROTTLE_MS = 1000;

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Dispatch pending deliveries for a broadcast. Safe to re-run: deliveries
 * already marked 'sent' or 'failed' are skipped; only 'pending' rows are
 * processed.
 *
 * For each pending delivery: re-fetches the contact (opt-out may have
 * happened since creation), renders the template, calls sendOutbound,
 * updates the delivery row + the rolled-up counters on the broadcast row.
 * Short-circuits a row to 'skipped' when the contact has become ineligible.
 */
export async function executeBroadcast(
  broadcastId: number,
  opts: ExecuteOptions,
): Promise<BroadcastExecutionSummary> {
  const db = getDatabase();
  const broadcast = getBroadcastById(broadcastId);
  if (!broadcast) {
    throw new Error(`executeBroadcast: broadcast ${broadcastId} not found`);
  }
  if (broadcast.status === 'completed') {
    return {
      broadcastId,
      sent: broadcast.totalSent,
      skipped: broadcast.totalSkipped,
      failed: broadcast.totalFailed,
      elapsedMs: 0,
    };
  }

  const throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS;
  const maxPerRun = opts.maxPerRun ?? 10000;
  const sleep = opts.sleep ?? realSleep;

  // Mark as running on first execution.
  if (broadcast.status === 'queued') {
    db.prepare(
      `UPDATE broadcasts SET status = 'running', started_at = ? WHERE id = ?`,
    ).run(nowIso(), broadcastId);
  }

  const pending = db
    .prepare(
      `SELECT * FROM broadcast_deliveries
        WHERE broadcast_id = ? AND status = 'pending'
        ORDER BY id
        LIMIT ?`,
    )
    .all(broadcastId, maxPerRun) as DeliveryRow[];

  const markDelivery = db.prepare(
    `UPDATE broadcast_deliveries
        SET status = ?, rendered_body = ?, twilio_sid = ?,
            error_code = ?, error_message = ?, attempted_at = ?
      WHERE id = ?`,
  );

  const start = Date.now();
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const now = () => nowIso();

  for (let i = 0; i < pending.length; i++) {
    const row = pending[i];
    const delivery = rowToDelivery(row);
    const contact = getContactById(row.contact_id);

    if (!contact || !isEligibleFor(contact, broadcast.purpose)) {
      markDelivery.run(
        'skipped',
        null,
        null,
        'ineligible',
        'contact opted out or purpose not permitted',
        now(),
        row.id,
      );
      skipped += 1;
      await opts.tick?.(delivery);
      continue;
    }

    const rendered = renderTemplate(broadcast.template, contact);
    if (rendered.length === 0) {
      markDelivery.run(
        'skipped',
        rendered,
        null,
        'empty-render',
        'template rendered to empty body',
        now(),
        row.id,
      );
      skipped += 1;
      await opts.tick?.(delivery);
      continue;
    }

    try {
      const result = await sendOutbound({
        config: opts.twilioConfig,
        message: {
          businessSlug: broadcast.businessSlug,
          channel: broadcast.channel === 'whatsapp' ? 'whatsapp' : 'sms',
          toPhone: contact.phone,
          body: rendered,
        },
        transport: opts.transport,
      });
      markDelivery.run('sent', rendered, result.sid, null, null, now(), row.id);
      sent += 1;
    } catch (err) {
      const code =
        err instanceof OutboundMessagingError ? err.code : 'unknown';
      const message = err instanceof Error ? err.message : String(err);
      markDelivery.run('failed', rendered, null, code, message, now(), row.id);
      failed += 1;
      logger.warn(
        { broadcastId, contactId: contact.id, code, err: message },
        'broadcast: delivery failed',
      );
    }

    await opts.tick?.(delivery);

    // Throttle between sends (not after the final one).
    if (i < pending.length - 1 && throttleMs > 0) {
      await sleep(throttleMs);
    }
  }

  // Update rollups + status.
  const totals = db
    .prepare(
      `SELECT
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
          SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
        FROM broadcast_deliveries WHERE broadcast_id = ?`,
    )
    .get(broadcastId) as {
    pending: number;
    sent: number;
    skipped: number;
    failed: number;
  };
  const nextStatus: BroadcastRecord['status'] =
    totals.pending === 0 ? 'completed' : 'running';
  db.prepare(
    `UPDATE broadcasts
        SET total_sent = ?, total_skipped = ?, total_failed = ?,
            status = ?, completed_at = ?
      WHERE id = ?`,
  ).run(
    totals.sent ?? 0,
    totals.skipped ?? 0,
    totals.failed ?? 0,
    nextStatus,
    nextStatus === 'completed' ? nowIso() : null,
    broadcastId,
  );

  return {
    broadcastId,
    sent,
    skipped,
    failed,
    elapsedMs: Date.now() - start,
  };
}

// ── Convenience: deterministic key helpers ────────────────────────────────

/**
 * Produce a deterministic broadcast_key for a campaign on a specific date.
 * Example: buildBroadcastKey('biz-ie-01', 'cork-weekly', '2026-04-20')
 *       → 'biz-ie-01:cork-weekly:2026-04-20'
 */
export function buildBroadcastKey(
  businessSlug: string,
  campaign: string,
  datePart: string,
): string {
  const normalized = campaign.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  return `${businessSlug}:${normalized}:${datePart}`;
}

/**
 * Hash of the full template — useful when a campaign's wording changes
 * mid-week. Included in broadcast_key ensures a new template = new
 * broadcast, not a retry of the old one.
 */
export function templateDigest(template: string): string {
  return crypto.createHash('sha1').update(template).digest('hex').slice(0, 8);
}
