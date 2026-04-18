/**
 * Lightweight CRM for NanoClaw businesses.
 *
 * One row per (business_slug, channel, phone). Stores opt-in state,
 * language, tags, and basic profile fields needed for segmentation and
 * templated broadcasts.
 *
 * Scope is deliberately minimal:
 *  - No merging across businesses (each biz has its own view of a phone).
 *  - No history beyond first_seen_at / last_seen_at / conversation_count.
 *  - No PII beyond name and language. Use contacts for routing + opt-in
 *    compliance, not for CRM-as-a-product.
 *
 * All functions are synchronous (better-sqlite3 is sync). Pure DB I/O; no
 * side effects to filesystem, network, or external state.
 */
import { getDatabase } from '../db.js';

// ── Types ────────────────────────────────────────────────────────────────

export type ContactChannel = 'sms' | 'whatsapp' | 'telegram' | 'other';

/**
 * Message purposes a contact has opted into. Maps to WhatsApp's category
 * model: marketing, utility, authentication, service. 'service' is always
 * allowed within the 24-h customer-reply window regardless of this field.
 */
export type ContactPurpose = 'marketing' | 'utility' | 'transactional';

export interface ContactRecord {
  id: number;
  businessSlug: string;
  channel: ContactChannel;
  phone: string;
  firstName: string | null;
  lastName: string | null;
  language: string | null;
  tags: string[];
  purposes: ContactPurpose[];
  optedInAt: string | null;
  optInSource: string | null;
  optedOutAt: string | null;
  optedOutReason: string | null;
  conversationCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface UpsertContactInput {
  businessSlug: string;
  channel: ContactChannel;
  phone: string;
  firstName?: string | null;
  lastName?: string | null;
  language?: string | null;
  tags?: string[];
  /** If true, increments conversation_count on upsert (use for inbound touches). */
  touch?: boolean;
}

export interface ContactSegment {
  businessSlug: string;
  channel: ContactChannel;
  /** All these tags must be present on the contact (AND). */
  tagsAll?: string[];
  /** Any of these tags present (OR). */
  tagsAny?: string[];
  /** Language filter (exact match on the language field). */
  language?: string;
  /** Only contacts opted in to this purpose. */
  purpose: ContactPurpose;
  /** Max contacts to return. Default 10000 (effectively unbounded). */
  limit?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

function parseJsonArray<T = string>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

interface ContactRow {
  id: number;
  business_slug: string;
  channel: string;
  phone: string;
  first_name: string | null;
  last_name: string | null;
  language: string | null;
  tags_json: string;
  purposes_json: string;
  opted_in_at: string | null;
  opt_in_source: string | null;
  opted_out_at: string | null;
  opted_out_reason: string | null;
  conversation_count: number;
  first_seen_at: string;
  last_seen_at: string;
}

function rowToContact(row: ContactRow): ContactRecord {
  return {
    id: row.id,
    businessSlug: row.business_slug,
    channel: row.channel as ContactChannel,
    phone: row.phone,
    firstName: row.first_name,
    lastName: row.last_name,
    language: row.language,
    tags: parseJsonArray<string>(row.tags_json),
    purposes: parseJsonArray<ContactPurpose>(row.purposes_json),
    optedInAt: row.opted_in_at,
    optInSource: row.opt_in_source,
    optedOutAt: row.opted_out_at,
    optedOutReason: row.opted_out_reason,
    conversationCount: row.conversation_count,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

// ── Upsert + fetch ────────────────────────────────────────────────────────

/**
 * Create or update a contact. Returns the stored row after the upsert.
 *
 * Fields that are explicitly `null` in the input overwrite existing values.
 * Fields that are `undefined` are left alone. Tags, if provided, replace
 * the existing tag set — use `addTag` / `removeTag` for incremental edits.
 *
 * When `touch: true`, `last_seen_at` + `conversation_count` are updated.
 * Default touch behavior on upsert is to update last_seen_at but NOT
 * bump conversation_count (so the CRM layer doesn't inflate counts on
 * internal edits).
 */
export function upsertContact(input: UpsertContactInput): ContactRecord {
  const db = getDatabase();
  const now = nowIso();
  const existing = db
    .prepare(
      `SELECT * FROM contacts
        WHERE business_slug = ? AND channel = ? AND phone = ?`,
    )
    .get(input.businessSlug, input.channel, input.phone) as
    | ContactRow
    | undefined;

  if (!existing) {
    db.prepare(
      `INSERT INTO contacts
         (business_slug, channel, phone, first_name, last_name, language,
          tags_json, purposes_json,
          conversation_count, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)`,
    ).run(
      input.businessSlug,
      input.channel,
      input.phone,
      input.firstName ?? null,
      input.lastName ?? null,
      input.language ?? null,
      JSON.stringify(input.tags ?? []),
      input.touch ? 1 : 0,
      now,
      now,
    );
  } else {
    // Merge updates — undefined = keep existing, anything else = write.
    const next = {
      first_name:
        input.firstName === undefined ? existing.first_name : input.firstName,
      last_name:
        input.lastName === undefined ? existing.last_name : input.lastName,
      language:
        input.language === undefined ? existing.language : input.language,
      tags_json:
        input.tags === undefined
          ? existing.tags_json
          : JSON.stringify(input.tags),
      last_seen_at: now,
      conversation_count: input.touch
        ? existing.conversation_count + 1
        : existing.conversation_count,
    };
    db.prepare(
      `UPDATE contacts
          SET first_name = ?, last_name = ?, language = ?,
              tags_json = ?, last_seen_at = ?, conversation_count = ?
        WHERE id = ?`,
    ).run(
      next.first_name,
      next.last_name,
      next.language,
      next.tags_json,
      next.last_seen_at,
      next.conversation_count,
      existing.id,
    );
  }

  return getContact(input.businessSlug, input.channel, input.phone)!;
}

export function getContact(
  businessSlug: string,
  channel: ContactChannel,
  phone: string,
): ContactRecord | null {
  const row = getDatabase()
    .prepare(
      `SELECT * FROM contacts
        WHERE business_slug = ? AND channel = ? AND phone = ?
        LIMIT 1`,
    )
    .get(businessSlug, channel, phone) as ContactRow | undefined;
  return row ? rowToContact(row) : null;
}

export function getContactById(id: number): ContactRecord | null {
  const row = getDatabase()
    .prepare(`SELECT * FROM contacts WHERE id = ? LIMIT 1`)
    .get(id) as ContactRow | undefined;
  return row ? rowToContact(row) : null;
}

// ── Opt-in / opt-out ──────────────────────────────────────────────────────

/**
 * Record opt-in. Overwrites any previous opt-out state (so an opt-in after
 * an opt-out lifts the block) but logs the new source + purposes. Caller is
 * responsible for having captured legal consent — this only *records* that
 * consent exists.
 */
export function optIn(params: {
  businessSlug: string;
  channel: ContactChannel;
  phone: string;
  source: string;
  purposes: ContactPurpose[];
}): ContactRecord {
  const contact = getContact(params.businessSlug, params.channel, params.phone);
  if (!contact) {
    throw new Error(
      `optIn: contact not found (${params.businessSlug}/${params.channel}/${params.phone}). Call upsertContact first.`,
    );
  }
  if (!params.purposes || params.purposes.length === 0) {
    throw new Error('optIn: must specify at least one purpose');
  }
  const now = nowIso();
  getDatabase()
    .prepare(
      `UPDATE contacts
          SET opted_in_at = ?, opt_in_source = ?, purposes_json = ?,
              opted_out_at = NULL, opted_out_reason = NULL,
              last_seen_at = ?
        WHERE id = ?`,
    )
    .run(
      now,
      params.source,
      JSON.stringify(Array.from(new Set(params.purposes))),
      now,
      contact.id,
    );
  return getContactById(contact.id)!;
}

/**
 * Record opt-out. Keeps the contact row (for suppression) but clears opt-in
 * timestamps and purposes so future segments skip them.
 */
export function optOut(params: {
  businessSlug: string;
  channel: ContactChannel;
  phone: string;
  reason: string;
}): ContactRecord {
  const contact = getContact(params.businessSlug, params.channel, params.phone);
  if (!contact) {
    throw new Error(
      `optOut: contact not found (${params.businessSlug}/${params.channel}/${params.phone})`,
    );
  }
  const now = nowIso();
  getDatabase()
    .prepare(
      `UPDATE contacts
          SET opted_out_at = ?, opted_out_reason = ?,
              opted_in_at = NULL, purposes_json = '[]',
              last_seen_at = ?
        WHERE id = ?`,
    )
    .run(now, params.reason, now, contact.id);
  return getContactById(contact.id)!;
}

/**
 * True when the contact is eligible to receive outbound of the given
 * purpose on the given channel. Encapsulates the opt-in + opt-out + purpose
 * gate so callers don't reimplement it.
 */
export function isEligibleFor(
  contact: ContactRecord,
  purpose: ContactPurpose,
): boolean {
  if (contact.optedOutAt) return false;
  if (!contact.optedInAt) return false;
  return contact.purposes.includes(purpose);
}

// ── Tags ─────────────────────────────────────────────────────────────────

export function addTag(
  businessSlug: string,
  channel: ContactChannel,
  phone: string,
  tag: string,
): ContactRecord {
  const contact = getContact(businessSlug, channel, phone);
  if (!contact) {
    throw new Error(
      `addTag: contact not found (${businessSlug}/${channel}/${phone})`,
    );
  }
  if (!contact.tags.includes(tag)) {
    const nextTags = [...contact.tags, tag];
    getDatabase()
      .prepare(
        `UPDATE contacts SET tags_json = ?, last_seen_at = ? WHERE id = ?`,
      )
      .run(JSON.stringify(nextTags), nowIso(), contact.id);
  }
  return getContactById(contact.id)!;
}

export function removeTag(
  businessSlug: string,
  channel: ContactChannel,
  phone: string,
  tag: string,
): ContactRecord {
  const contact = getContact(businessSlug, channel, phone);
  if (!contact) {
    throw new Error(`removeTag: contact not found`);
  }
  const nextTags = contact.tags.filter((t) => t !== tag);
  if (nextTags.length !== contact.tags.length) {
    getDatabase()
      .prepare(
        `UPDATE contacts SET tags_json = ?, last_seen_at = ? WHERE id = ?`,
      )
      .run(JSON.stringify(nextTags), nowIso(), contact.id);
  }
  return getContactById(contact.id)!;
}

// ── Segmentation ──────────────────────────────────────────────────────────

/**
 * Return every contact in the given business + channel that matches the
 * segment. Filters are AND-composed; tagsAll and tagsAny are AND/OR within
 * the tags JSON; opt-in and purpose are mandatory gates (a contact who is
 * opted out or not opted in for this purpose never comes through).
 *
 * Important: this is scoped strictly by `businessSlug` — a contact in
 * biz-ie-01 will never leak into a biz-br-01 segment even if the phone is
 * the same.
 */
export function findContacts(segment: ContactSegment): ContactRecord[] {
  const db = getDatabase();
  const limit = segment.limit ?? 10000;
  const rows = db
    .prepare(
      `SELECT * FROM contacts
        WHERE business_slug = ? AND channel = ?
          AND opted_out_at IS NULL
          AND opted_in_at IS NOT NULL
        LIMIT ?`,
    )
    .all(segment.businessSlug, segment.channel, limit) as ContactRow[];

  return rows
    .map(rowToContact)
    .filter((c) => c.purposes.includes(segment.purpose))
    .filter((c) => (segment.language ? c.language === segment.language : true))
    .filter((c) =>
      segment.tagsAll && segment.tagsAll.length
        ? segment.tagsAll.every((t) => c.tags.includes(t))
        : true,
    )
    .filter((c) =>
      segment.tagsAny && segment.tagsAny.length
        ? segment.tagsAny.some((t) => c.tags.includes(t))
        : true,
    );
}

/**
 * Count contacts matching a segment. Useful for "this broadcast will reach N
 * people" previews before firing.
 */
export function countContacts(segment: ContactSegment): number {
  return findContacts(segment).length;
}
