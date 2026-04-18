# Broadcast + contacts

The outbound-cadence primitive. Turns NanoClaw from a reactive helpline
(replies only) into a platform that can *initiate* conversations — weekly
digests, drop alerts, re-engagement messages — with opt-in compliance,
throttling, and crash-safe delivery tracking.

**Status:** modules + tests shipped, not auto-wired.

## Why this exists

Both active businesses were starved of outbound capability until now:

- **Sou da Irlanda** — 24 real inbound messages, all from cold users asking
  about Cork housing and visas. No way to *push* a weekly update of new
  listings + deadline reminders.
- **MiauPop** — 25+ editorial pieces sitting on miaupop.com with no bridge
  to a subscriber's WhatsApp / SMS for drop-window alerts.

A broadcast primitive closes that loop. It takes a segment + a template,
fans out sends through the already-existing `sendOutbound` (Twilio SMS /
WhatsApp), tracks every delivery in SQLite, and skips anyone who has
opted out since the broadcast was created.

## What's in

| File | Role |
|---|---|
| `contacts.ts` | Lightweight CRM — one row per (business_slug, channel, phone). Tracks opt-in/out, language, tags, conversation count, first_seen / last_seen. Segmentation via `findContacts({ businessSlug, channel, purpose, tagsAll?, tagsAny?, language? })`. Scoped strictly per business — nothing leaks across. |
| `broadcast.ts` | `createBroadcast(spec)` + `executeBroadcast(id, opts)` + `renderTemplate(tpl, contact)`. Idempotent on `broadcast_key`. Crash-safe: re-running `executeBroadcast` only processes `pending` deliveries, so a mid-run failure resumes cleanly. Throttles between sends (default 1 s). |
| `contacts.test.ts` | 31 vitest cases — upsert, opt-in/out flow, tag ops, segmentation filters, cross-business isolation. |
| `broadcast.test.ts` | 18 vitest cases — template rendering, idempotency, opt-out-between-create-and-execute skip, Twilio-error tracking, resumability, throttle, completed-broadcast no-op. |
| `../db.ts` | New tables: `contacts`, `broadcasts`, `broadcast_deliveries` + indexes. Additive migration via `IF NOT EXISTS`. |

49/49 tests pass. `npx tsc --noEmit` clean.

## Core concepts

**Contact** — a person in one business's audience on one channel.
Identified by (business_slug, channel, phone). Two businesses can each
have a row for the same phone without any cross-contamination.

**Purpose** — a WhatsApp-policy-aware opt-in category:
- `marketing` — promotional content (drop alerts, digests). Must be
  explicitly opted in; uses Meta-approved templates for >24 h window.
- `utility` — transactional updates tied to a user action
  (listing expiry, appointment reminder).
- `transactional` — e.g. order confirmation. Distinct from `utility` so
  segmentation can target one without the other.

The `service` category (customer-support reply within the 24 h customer-
care window) is *not* modeled here because it's already handled by the
existing `sendMessage` reply path in `TwilioChannel`.

**Segment** — a query describing which contacts to target:

```ts
{
  businessSlug: 'biz-ie-01',    // Sou da Irlanda
  channel: 'whatsapp',
  purpose: 'marketing',           // must be opted in for this
  tagsAll: ['cork', 'housing'],   // all tags present (AND)
  tagsAny: ['rent', 'buy'],       // any of these present (OR)
  language: 'pt-BR',
  limit: 500,
}
```

**Broadcast** — one campaign. Has a unique `broadcast_key` (idempotency),
a segment, a template, and a purpose. Resolves the segment at creation
time and materializes one `broadcast_deliveries` row per target. Execute
walks the pending rows and dispatches.

## Typical usage

```ts
import { initDatabase } from '../db.js';
import {
  upsertContact, optIn,
} from './contacts.js';
import {
  createBroadcast, executeBroadcast, buildBroadcastKey,
} from './broadcast.js';
import {
  createTwilioTransport,
} from '../channels/messaging/outbound-twilio.js';
import businesses from '../../data/businesses.json' with { type: 'json' };

initDatabase();

// 1. Ingest opt-ins (typically from a web form or SMS "JOIN" handler).
upsertContact({
  businessSlug: 'biz-ie-01',
  channel: 'whatsapp',
  phone: '+353851234567',
  firstName: 'Ana',
  language: 'pt-BR',
  tags: ['cork', 'housing'],
});
optIn({
  businessSlug: 'biz-ie-01',
  channel: 'whatsapp',
  phone: '+353851234567',
  source: 'website-form',
  purposes: ['marketing', 'utility'],
});

// 2. Create a broadcast.
const b = createBroadcast({
  broadcastKey: buildBroadcastKey('biz-ie-01', 'cork-weekly', '2026-04-20'),
  businessSlug: 'biz-ie-01',
  channel: 'whatsapp',
  purpose: 'marketing',
  template:
    'Olá {{first_name}}! Cork Weekly: 5 apartamentos novos em Douglas a partir de €1800. Detalhes: https://soudairlanda.com/cork-weekly',
  segment: {
    businessSlug: 'biz-ie-01',
    channel: 'whatsapp',
    purpose: 'marketing',
    tagsAll: ['cork'],
  },
});
console.log(`Broadcast ${b.id} will reach ${b.totalTargets} people.`);

// 3. Dispatch.
const transport = createTwilioTransport(
  process.env.TWILIO_ACCOUNT_SID!,
  process.env.TWILIO_AUTH_TOKEN!,
);
const summary = await executeBroadcast(b.id, {
  transport,
  twilioConfig: businesses.businesses['biz-ie-01'].channels.twilio,
  throttleMs: 1000,   // 1 send/sec — respects Twilio's SMS rate limit
});
console.log(summary);
```

## Crash safety

Every delivery row carries its own status (`pending` / `sent` / `skipped`
/ `failed`). If the process crashes mid-broadcast, re-running
`executeBroadcast(b.id, ...)` resumes from the first still-`pending` row.
`sent` rows are never re-sent. This is safer than "send to all, track
successes" because the source of truth is in the DB, not in memory.

`broadcastKey` is a caller-supplied unique string. Suggested shape:
`<business>:<campaign>:<yyyy-mm-dd>`. Use `buildBroadcastKey()` to
produce a normalized slug. Re-running `createBroadcast` with the same
key is a no-op — useful when a cron triggers the same broadcast twice
after a restart.

## Opt-in policy

The module **stores** opt-in records. It does not *prove* consent — the
caller must have captured it legitimately (website checkbox, SMS reply
"JOIN", in-conversation explicit yes). `opt_in_source` is a free-form
string; use it to document where the consent came from so you can defend
deliveries in a complaint or audit.

When a user replies `STOP` / `PARE` / `UNSUBSCRIBE` to any outbound, the
inbound webhook handler should call `optOut()` — detection + wiring
lives outside this module (future work).

## WhatsApp template approval

For WhatsApp marketing outside the 24 h customer-care window, Meta
requires **pre-approved message templates**. The template string passed
to `createBroadcast` must match a template that's been registered via
Twilio Console → Messaging → WhatsApp Templates. Keep a library of
approved templates under `docs/whatsapp-templates/` and reference them
by name in broadcast scripts. (We deliberately don't have a
template-approval helper in code — it's a manual workflow anyway.)

## Limits / not-yet-done

- **No DLQ** — failed deliveries stay as `failed`. Retry is a future
  enhancement; for now, operator decides whether to build a new
  broadcast with only the failures (the data is there via
  `getDeliveries(broadcastId)`).
- **No scheduling** — broadcasts are created and executed in the same
  process. Scheduling belongs in the existing `scheduled_tasks` layer
  (add a task-handler type `execute_broadcast`, pass `broadcastId`).
- **STOP keyword handler — code shipped, webhook wiring pending.**
  `src/broadcast/opt-out-detector.ts` + `src/broadcast/inbound-opt-out.ts`
  implement the detector and orchestrator (pt-BR / en / es, confidence-
  gated, idempotent, localized confirmation reply). Wiring into
  `src/channels/twilio.ts` is a ~15-line patch that calls
  `handleInboundOptOut` before routing to the agent and, on `actedOn=true`,
  sends the confirmation back through the existing reply path. Patch
  shown below in "Wiring the STOP handler".
- **No HTTP/MCP entrypoint for agents** — agents can't yet trigger
  broadcasts from their container. When the live-in-agent broadcast
  feature is useful, expose via MCP tool.
- **No breaker wrapping** — `executeBroadcast` will fail a delivery on
  Twilio 5xx but not trip a circuit. Simple follow-up: wrap
  `sendOutbound` in the existing `circuit-breaker` module's
  `twilio.sms` / `twilio.whatsapp` breakers.

## Running the tests

```bash
sudo -u nanoclaw -i
cd ~/nanoclaw-workspace/nanoclaw
npx vitest run src/broadcast/
```

Or from any user via the scratch env-override config pattern used by the
cache + circuit-breaker + saude modules.

Expected: **88 passing** (31 contacts + 18 broadcast + 29 opt-out +
10 inbound-opt-out wrapper).

## Wiring the STOP handler

Add this inside `src/channels/twilio.ts`, in the SMS + WhatsApp webhook
handler after `msg` has been parsed but before routing to the agent
(roughly between lines 560 and 570, just after `senderPhone` is known):

```ts
import { handleInboundOptOut } from '../broadcast/inbound-opt-out.js';

// …inside the inbound webhook handler…
const optOutResult = handleInboundOptOut({
  businessSlug: slug,
  channel: isWhatsApp ? 'whatsapp' : 'sms',
  phone: senderPhone,
  body: msg.Body ?? '',
});

if (optOutResult.actedOn && optOutResult.confirmationMessage) {
  // Send confirmation via the existing reply path. lastSender is set
  // naturally by the webhook a few lines earlier, so sendMessage replies
  // to the right person.
  await this.sendMessage(
    `tw:${slug}`,
    optOutResult.confirmationMessage,
  );
  logger.info(
    { slug, phone: senderPhone, keyword: optOutResult.detection.keyword },
    'opt-out: user unsubscribed',
  );
  // Swallow the message — do NOT forward to the agent.
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end('<Response/>');
  return;
}

if (!optOutResult.actedOn && optOutResult.reason === 'already-opted-out') {
  // User is already opted out and sent another STOP-shaped message —
  // don't reconfirm, but also don't forward to the agent (they don't
  // want messages from us).
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end('<Response/>');
  return;
}

// otherwise fall through to normal message handling…
```

Held for a separate reviewed commit because it touches the webhook hot
path. Apply it + `sudo systemctl restart nanoclaw` and the STOP
compliance loop is live.
