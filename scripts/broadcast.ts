#!/usr/bin/env tsx
/**
 * scripts/broadcast.ts — fire a broadcast campaign from the command line.
 *
 * Reads a campaign spec from a JSON file and either previews (dry-run) or
 * dispatches through the live Twilio transport. Preview mode is safe to run
 * anywhere; dispatch needs TWILIO_* env vars + the nanoclaw user's DB write
 * access.
 *
 * Usage:
 *   npx tsx scripts/broadcast.ts --preview <spec.json>
 *   npx tsx scripts/broadcast.ts --send    <spec.json>
 *   npx tsx scripts/broadcast.ts --status  <broadcastKey>
 *
 * Spec shape (JSON):
 *   {
 *     "broadcastKey": "biz-ie-01:cork-weekly:2026-04-20",
 *     "businessSlug": "biz-ie-01",
 *     "channel": "whatsapp",
 *     "purpose": "marketing",
 *     "template": "Olá {{first_name}}! Cork Weekly: ...",
 *     "segment": {
 *       "businessSlug": "biz-ie-01",
 *       "channel": "whatsapp",
 *       "purpose": "marketing",
 *       "tagsAll": ["cork"]
 *     },
 *     "throttleMs": 1000
 *   }
 *
 * `--preview` resolves the segment, shows how many people would be reached,
 * prints the rendered template for the first 3 contacts, but does NOT create
 * the broadcast row. Safe.
 */
import fs from 'fs';
import path from 'path';

import { initDatabase, initReadOnlyDatabase } from '../src/db.js';
import {
  findContacts,
  ContactSegment,
  ContactPurpose,
  ContactChannel,
} from '../src/broadcast/contacts.js';
import {
  createBroadcast,
  executeBroadcast,
  renderTemplate,
  getBroadcastById,
  getBroadcastByKey,
  getDeliveries,
} from '../src/broadcast/broadcast.js';
import { createTwilioTransport } from '../src/channels/messaging/outbound-twilio.js';

interface CampaignSpec {
  broadcastKey: string;
  businessSlug: string;
  channel: ContactChannel;
  purpose: ContactPurpose;
  template: string;
  segment: ContactSegment;
  throttleMs?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function loadSpec(filePath: string): CampaignSpec {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) {
    throw new Error(`spec file not found: ${absolute}`);
  }
  const parsed = JSON.parse(fs.readFileSync(absolute, 'utf-8')) as CampaignSpec;
  // Minimal shape guard — the broadcast module does the rest.
  const required: (keyof CampaignSpec)[] = [
    'broadcastKey',
    'businessSlug',
    'channel',
    'purpose',
    'template',
    'segment',
  ];
  for (const key of required) {
    if (parsed[key] === undefined) {
      throw new Error(`spec missing required field: ${String(key)}`);
    }
  }
  return parsed;
}

function loadBusinessesJson(): Record<string, unknown> {
  const p = path.resolve(process.cwd(), 'data/businesses.json');
  if (!fs.existsSync(p)) {
    throw new Error(`data/businesses.json not found at ${p}`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function resolveTwilioConfig(businessSlug: string) {
  const doc = loadBusinessesJson() as {
    businesses: Record<
      string,
      { channels?: { twilio?: unknown } } | undefined
    >;
  };
  const biz = doc.businesses?.[businessSlug];
  if (!biz) {
    throw new Error(`business ${businessSlug} not in data/businesses.json`);
  }
  const cfg = biz.channels?.twilio;
  if (!cfg) {
    throw new Error(`business ${businessSlug} has no twilio block`);
  }
  return cfg as Parameters<typeof createTwilioTransport>[0] extends string
    ? never
    : Record<string, unknown>;
}

// ── Modes ─────────────────────────────────────────────────────────────────

function preview(spec: CampaignSpec): void {
  initReadOnlyDatabase();
  const contacts = findContacts(spec.segment);
  console.log('━━ PREVIEW — no writes, no sends ━━');
  console.log(`broadcastKey: ${spec.broadcastKey}`);
  console.log(`business:     ${spec.businessSlug}`);
  console.log(`channel:      ${spec.channel}`);
  console.log(`purpose:      ${spec.purpose}`);
  console.log(`targets:      ${contacts.length}`);
  if (contacts.length === 0) {
    console.log('');
    console.log('no eligible contacts match this segment.');
    return;
  }
  console.log('');
  console.log('first 3 rendered messages:');
  for (const c of contacts.slice(0, 3)) {
    const rendered = renderTemplate(spec.template, c);
    console.log(`  → ${c.phone} (${c.firstName ?? '—'})`);
    for (const line of rendered.split('\n')) console.log(`       ${line}`);
    console.log('');
  }
  if (contacts.length > 3) {
    console.log(`   …and ${contacts.length - 3} more.`);
  }
}

async function send(spec: CampaignSpec): Promise<void> {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    throw new Error(
      '--send requires TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN env vars',
    );
  }
  initDatabase();

  const twilioConfig = resolveTwilioConfig(spec.businessSlug);
  const transport = createTwilioTransport(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN,
  );

  const broadcast = createBroadcast({
    broadcastKey: spec.broadcastKey,
    businessSlug: spec.businessSlug,
    channel: spec.channel,
    purpose: spec.purpose,
    template: spec.template,
    segment: spec.segment,
  });

  console.log(`broadcast #${broadcast.id} (${broadcast.broadcastKey})`);
  console.log(`  status:  ${broadcast.status}`);
  console.log(`  targets: ${broadcast.totalTargets}`);
  console.log(`  already sent: ${broadcast.totalSent}`);
  console.log(`dispatching...`);

  const summary = await executeBroadcast(broadcast.id, {
    transport,
    // biome / prettier-safe: indexed into
    twilioConfig: twilioConfig as Parameters<typeof executeBroadcast>[1]['twilioConfig'],
    throttleMs: spec.throttleMs ?? 1000,
  });

  console.log('');
  console.log(`done in ${summary.elapsedMs}ms`);
  console.log(`  sent:    ${summary.sent}`);
  console.log(`  skipped: ${summary.skipped}`);
  console.log(`  failed:  ${summary.failed}`);
}

function status(broadcastKey: string): void {
  initReadOnlyDatabase();
  const broadcast = getBroadcastByKey(broadcastKey);
  if (!broadcast) {
    console.log(`no broadcast with key ${broadcastKey}`);
    return;
  }
  console.log(`broadcast #${broadcast.id}`);
  console.log(`  key:        ${broadcast.broadcastKey}`);
  console.log(`  business:   ${broadcast.businessSlug}`);
  console.log(`  channel:    ${broadcast.channel}`);
  console.log(`  purpose:    ${broadcast.purpose}`);
  console.log(`  status:     ${broadcast.status}`);
  console.log(`  targets:    ${broadcast.totalTargets}`);
  console.log(`  sent:       ${broadcast.totalSent}`);
  console.log(`  skipped:    ${broadcast.totalSkipped}`);
  console.log(`  failed:     ${broadcast.totalFailed}`);
  console.log(`  created:    ${broadcast.createdAt}`);
  if (broadcast.completedAt) console.log(`  completed:  ${broadcast.completedAt}`);

  const deliveries = getDeliveries(broadcast.id);
  const byStatus = deliveries.reduce<Record<string, number>>((acc, d) => {
    acc[d.status] = (acc[d.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log('');
  console.log('delivery breakdown:', byStatus);
}

// ── CLI ──────────────────────────────────────────────────────────────────

function usage(): never {
  console.error(
    'Usage:\n' +
      '  npx tsx scripts/broadcast.ts --preview <spec.json>\n' +
      '  npx tsx scripts/broadcast.ts --send    <spec.json>\n' +
      '  npx tsx scripts/broadcast.ts --status  <broadcastKey>',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();

  const mode = args[0];
  const arg = args[1];
  if (!arg) usage();

  if (mode === '--preview') {
    preview(loadSpec(arg));
  } else if (mode === '--send') {
    await send(loadSpec(arg));
  } else if (mode === '--status') {
    status(arg);
  } else {
    usage();
  }
}

const invokedDirectly =
  typeof import.meta !== 'undefined' &&
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
