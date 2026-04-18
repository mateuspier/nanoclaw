import { describe, it, expect, beforeEach, vi } from 'vitest';

import { _initTestDatabase } from '../db.js';

import { upsertContact, optIn, optOut } from './contacts.js';
import {
  createBroadcast,
  executeBroadcast,
  renderTemplate,
  getBroadcastById,
  getDeliveries,
  buildBroadcastKey,
  templateDigest,
} from './broadcast.js';
import { TwilioTransport } from '../channels/messaging/outbound-twilio.js';

beforeEach(() => {
  _initTestDatabase();
});

function twilioConfig() {
  return {
    phone_number: '+12762623230',
    sms: true,
    whatsapp: true,
  };
}

function stubTransportOk(): TwilioTransport {
  return {
    post: vi.fn(async () => ({
      status: 201,
      text: JSON.stringify({ sid: `SM_${Math.random().toString(36).slice(2, 8)}` }),
    })),
  };
}

async function noSleep() {
  // no-op
}

function seedOptedIn(
  biz: string,
  phone: string,
  firstName: string,
  tags: string[] = [],
  language: string | null = 'pt-BR',
  purposes: Array<'marketing' | 'utility'> = ['marketing'],
) {
  upsertContact({
    businessSlug: biz,
    channel: 'whatsapp',
    phone,
    firstName,
    language,
    tags,
  });
  optIn({ businessSlug: biz, channel: 'whatsapp', phone, source: 't', purposes });
}

// ── renderTemplate ────────────────────────────────────────────────────────

describe('renderTemplate', () => {
  it('replaces known variables', () => {
    upsertContact({
      businessSlug: 'b',
      channel: 'whatsapp',
      phone: '+1',
      firstName: 'Ana',
      language: 'pt-BR',
      tags: ['cork'],
    });
    const c = optIn({
      businessSlug: 'b',
      channel: 'whatsapp',
      phone: '+1',
      source: 't',
      purposes: ['marketing'],
    });
    const out = renderTemplate(
      'Olá {{first_name}}! Idioma: {{language}}. Biz: {{business}}.',
      c,
    );
    expect(out).toBe('Olá Ana! Idioma: pt-BR. Biz: b.');
  });

  it('replaces tag_<name> with yes/empty', () => {
    upsertContact({
      businessSlug: 'b',
      channel: 'whatsapp',
      phone: '+1',
      tags: ['cork', 'housing'],
    });
    const c = optIn({
      businessSlug: 'b',
      channel: 'whatsapp',
      phone: '+1',
      source: 't',
      purposes: ['marketing'],
    });
    expect(renderTemplate('cork={{tag_cork}} dublin={{tag_dublin}}', c)).toBe(
      'cork=yes dublin=',
    );
  });

  it('strips unknown tokens and trims whitespace', () => {
    const c = upsertContact({
      businessSlug: 'b',
      channel: 'whatsapp',
      phone: '+1',
      firstName: null,
    });
    const out = renderTemplate(
      'Hi {{first_name}}{{unknown}}!   \n\n\n\nBye.',
      c,
    );
    // trailing spaces per line trimmed, 3+ newlines collapsed to 2
    expect(out).toBe('Hi !\n\nBye.');
  });

  it('handles contacts with null firstName gracefully', () => {
    const c = upsertContact({
      businessSlug: 'b',
      channel: 'whatsapp',
      phone: '+1',
      firstName: null,
    });
    expect(renderTemplate('Olá {{first_name}}!', c)).toBe('Olá !');
  });
});

// ── createBroadcast ───────────────────────────────────────────────────────

describe('createBroadcast', () => {
  it('materializes one delivery row per matched contact', () => {
    seedOptedIn('biz-ie-01', '+1', 'Ana', ['cork']);
    seedOptedIn('biz-ie-01', '+2', 'Bea', ['dublin']);

    const b = createBroadcast({
      broadcastKey: 'biz-ie-01:test:2026-04-18',
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      purpose: 'marketing',
      template: 'Olá {{first_name}}',
      segment: {
        businessSlug: 'biz-ie-01',
        channel: 'whatsapp',
        purpose: 'marketing',
      },
    });

    expect(b.totalTargets).toBe(2);
    expect(b.status).toBe('queued');
    expect(getDeliveries(b.id)).toHaveLength(2);
  });

  it('is idempotent on broadcast_key', () => {
    seedOptedIn('biz-ie-01', '+1', 'Ana');

    const a = createBroadcast({
      broadcastKey: 'biz-ie-01:idem:2026-04-18',
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      purpose: 'marketing',
      template: 'Olá {{first_name}}',
      segment: {
        businessSlug: 'biz-ie-01',
        channel: 'whatsapp',
        purpose: 'marketing',
      },
    });
    const b = createBroadcast({
      broadcastKey: 'biz-ie-01:idem:2026-04-18',
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      purpose: 'marketing',
      template: 'Olá {{first_name}}',
      segment: {
        businessSlug: 'biz-ie-01',
        channel: 'whatsapp',
        purpose: 'marketing',
      },
    });

    expect(b.id).toBe(a.id);
    expect(getDeliveries(a.id)).toHaveLength(1);
  });

  it('respects tag filters when resolving the segment', () => {
    seedOptedIn('biz-ie-01', '+1', 'Ana', ['cork']);
    seedOptedIn('biz-ie-01', '+2', 'Bea', ['dublin']);

    const b = createBroadcast({
      broadcastKey: 'biz-ie-01:cork-only:2026-04-18',
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      purpose: 'marketing',
      template: 'x',
      segment: {
        businessSlug: 'biz-ie-01',
        channel: 'whatsapp',
        purpose: 'marketing',
        tagsAll: ['cork'],
      },
    });
    expect(b.totalTargets).toBe(1);
    const ds = getDeliveries(b.id);
    expect(ds).toHaveLength(1);
  });

  it('rejects empty templates', () => {
    expect(() =>
      createBroadcast({
        broadcastKey: 'key-empty-template',
        businessSlug: 'b',
        channel: 'whatsapp',
        purpose: 'marketing',
        template: '   ',
        segment: { businessSlug: 'b', channel: 'whatsapp', purpose: 'marketing' },
      }),
    ).toThrow(/template must be non-empty/);
  });

  it('rejects short broadcast keys', () => {
    expect(() =>
      createBroadcast({
        broadcastKey: 'k',
        businessSlug: 'b',
        channel: 'whatsapp',
        purpose: 'marketing',
        template: 'hi',
        segment: { businessSlug: 'b', channel: 'whatsapp', purpose: 'marketing' },
      }),
    ).toThrow(/broadcastKey must be at least/);
  });

  it('rejects segment mismatch (businessSlug, channel, purpose)', () => {
    expect(() =>
      createBroadcast({
        broadcastKey: 'key-biz-mismatch',
        businessSlug: 'biz-ie-01',
        channel: 'whatsapp',
        purpose: 'marketing',
        template: 'x',
        segment: { businessSlug: 'biz-br-01', channel: 'whatsapp', purpose: 'marketing' },
      }),
    ).toThrow(/segment.businessSlug/);
    expect(() =>
      createBroadcast({
        broadcastKey: 'key-ch-mismatch',
        businessSlug: 'biz-ie-01',
        channel: 'whatsapp',
        purpose: 'marketing',
        template: 'x',
        segment: { businessSlug: 'biz-ie-01', channel: 'sms', purpose: 'marketing' },
      }),
    ).toThrow(/segment.channel/);
    expect(() =>
      createBroadcast({
        broadcastKey: 'key-purp-mismatch',
        businessSlug: 'biz-ie-01',
        channel: 'whatsapp',
        purpose: 'marketing',
        template: 'x',
        segment: { businessSlug: 'biz-ie-01', channel: 'whatsapp', purpose: 'utility' },
      }),
    ).toThrow(/segment.purpose/);
  });
});

// ── executeBroadcast ─────────────────────────────────────────────────────

describe('executeBroadcast', () => {
  it('sends to all eligible contacts and marks rows sent', async () => {
    seedOptedIn('biz-ie-01', '+353851111111', 'Ana');
    seedOptedIn('biz-ie-01', '+353852222222', 'Bea');

    const b = createBroadcast({
      broadcastKey: 'biz-ie-01:go:2026-04-18',
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      purpose: 'marketing',
      template: 'Oi {{first_name}}!',
      segment: {
        businessSlug: 'biz-ie-01',
        channel: 'whatsapp',
        purpose: 'marketing',
      },
    });
    const transport = stubTransportOk();
    const summary = await executeBroadcast(b.id, {
      transport,
      twilioConfig: twilioConfig(),
      throttleMs: 0,
      sleep: noSleep,
    });
    expect(summary.sent).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(transport.post).toHaveBeenCalledTimes(2);

    const deliveries = getDeliveries(b.id);
    expect(deliveries.every((d) => d.status === 'sent')).toBe(true);
    expect(deliveries[0].renderedBody).toBe('Oi Ana!');
    expect(deliveries[1].renderedBody).toBe('Oi Bea!');
    expect(deliveries.every((d) => d.twilioSid?.startsWith('SM_'))).toBe(true);

    const final = getBroadcastById(b.id)!;
    expect(final.status).toBe('completed');
    expect(final.totalSent).toBe(2);
    expect(final.completedAt).not.toBeNull();
  });

  it('skips contacts that opted out between create and execute', async () => {
    seedOptedIn('biz-ie-01', '+353851111111', 'Ana');
    seedOptedIn('biz-ie-01', '+353852222222', 'Bea');

    const b = createBroadcast({
      broadcastKey: 'biz-ie-01:race:2026-04-18',
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      purpose: 'marketing',
      template: 'Oi {{first_name}}',
      segment: {
        businessSlug: 'biz-ie-01',
        channel: 'whatsapp',
        purpose: 'marketing',
      },
    });

    // One user opts out mid-campaign.
    optOut({ businessSlug: 'biz-ie-01', channel: 'whatsapp', phone: '+353852222222', reason: 'STOP' });

    const transport = stubTransportOk();
    const summary = await executeBroadcast(b.id, {
      transport,
      twilioConfig: twilioConfig(),
      throttleMs: 0,
      sleep: noSleep,
    });

    expect(summary.sent).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(transport.post).toHaveBeenCalledTimes(1);
    const deliveries = getDeliveries(b.id);
    const skippedContactId = deliveries.find((d) => d.status === 'skipped')?.contactId;
    expect(skippedContactId).toBeDefined();
    expect(deliveries.find((d) => d.status === 'sent')?.renderedBody).toBe('Oi Ana');
  });

  it('marks Twilio errors as failed and continues', async () => {
    seedOptedIn('biz-ie-01', '+353851111111', 'Ana');
    seedOptedIn('biz-ie-01', '+353852222222', 'Bea');

    const b = createBroadcast({
      broadcastKey: 'biz-ie-01:partial:2026-04-18',
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      purpose: 'marketing',
      template: 'Oi',
      segment: {
        businessSlug: 'biz-ie-01',
        channel: 'whatsapp',
        purpose: 'marketing',
      },
    });

    // First send fails, second succeeds.
    const post = vi
      .fn()
      .mockResolvedValueOnce({
        status: 400,
        text: '{"message":"Invalid \'To\'"}',
      })
      .mockResolvedValueOnce({ status: 201, text: '{"sid":"SM_ok"}' });

    const summary = await executeBroadcast(b.id, {
      transport: { post },
      twilioConfig: twilioConfig(),
      throttleMs: 0,
      sleep: noSleep,
    });

    expect(summary.failed).toBe(1);
    expect(summary.sent).toBe(1);

    const deliveries = getDeliveries(b.id);
    const failed = deliveries.find((d) => d.status === 'failed');
    expect(failed?.errorCode).toBe('twilio-api');
    expect(failed?.errorMessage).toMatch(/Twilio API 400/);
  });

  it('is resumable after a crash — re-running only processes pending rows', async () => {
    seedOptedIn('biz-ie-01', '+353851111111', 'A');
    seedOptedIn('biz-ie-01', '+353852222222', 'B');
    seedOptedIn('biz-ie-01', '+353853333333', 'C');

    const b = createBroadcast({
      broadcastKey: 'biz-ie-01:resume:2026-04-18',
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      purpose: 'marketing',
      template: 'x',
      segment: {
        businessSlug: 'biz-ie-01',
        channel: 'whatsapp',
        purpose: 'marketing',
      },
    });

    // Process only the first row in the first run.
    const post1 = vi
      .fn()
      .mockResolvedValue({ status: 201, text: '{"sid":"SM_1"}' });
    await executeBroadcast(b.id, {
      transport: { post: post1 },
      twilioConfig: twilioConfig(),
      throttleMs: 0,
      sleep: noSleep,
      maxPerRun: 1,
    });
    expect(post1).toHaveBeenCalledTimes(1);
    const mid = getBroadcastById(b.id)!;
    expect(mid.status).toBe('running');
    expect(mid.totalSent).toBe(1);

    // Resume — should send the remaining two.
    const post2 = vi
      .fn()
      .mockResolvedValue({ status: 201, text: '{"sid":"SM_2"}' });
    const summary = await executeBroadcast(b.id, {
      transport: { post: post2 },
      twilioConfig: twilioConfig(),
      throttleMs: 0,
      sleep: noSleep,
    });
    expect(post2).toHaveBeenCalledTimes(2);
    expect(summary.sent).toBe(2);

    const final = getBroadcastById(b.id)!;
    expect(final.status).toBe('completed');
    expect(final.totalSent).toBe(3);
  });

  it('throttles between sends', async () => {
    seedOptedIn('biz-ie-01', '+353851111111', 'A');
    seedOptedIn('biz-ie-01', '+353852222222', 'B');
    seedOptedIn('biz-ie-01', '+353853333333', 'C');

    const b = createBroadcast({
      broadcastKey: 'biz-ie-01:throttle:2026-04-18',
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      purpose: 'marketing',
      template: 'x',
      segment: {
        businessSlug: 'biz-ie-01',
        channel: 'whatsapp',
        purpose: 'marketing',
      },
    });

    const sleep = vi.fn(async () => {});
    await executeBroadcast(b.id, {
      transport: stubTransportOk(),
      twilioConfig: twilioConfig(),
      throttleMs: 100,
      sleep,
    });
    // 3 sends → 2 sleeps (no sleep after final)
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it('a completed broadcast is a no-op on re-execute', async () => {
    seedOptedIn('biz-ie-01', '+353851111111', 'A');
    const b = createBroadcast({
      broadcastKey: 'biz-ie-01:done:2026-04-18',
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      purpose: 'marketing',
      template: 'x',
      segment: {
        businessSlug: 'biz-ie-01',
        channel: 'whatsapp',
        purpose: 'marketing',
      },
    });
    await executeBroadcast(b.id, {
      transport: stubTransportOk(),
      twilioConfig: twilioConfig(),
      throttleMs: 0,
      sleep: noSleep,
    });

    const post2 = vi.fn();
    const summary = await executeBroadcast(b.id, {
      transport: { post: post2 },
      twilioConfig: twilioConfig(),
      throttleMs: 0,
      sleep: noSleep,
    });
    expect(post2).not.toHaveBeenCalled();
    expect(summary.sent).toBe(1);
  });
});

// ── key helpers ──────────────────────────────────────────────────────────

describe('key helpers', () => {
  it('buildBroadcastKey normalizes the campaign slug', () => {
    expect(buildBroadcastKey('biz-ie-01', 'Cork Weekly!', '2026-04-20')).toBe(
      'biz-ie-01:cork-weekly-:2026-04-20',
    );
  });

  it('templateDigest is deterministic and short', () => {
    const a = templateDigest('Olá {{first_name}}');
    const b = templateDigest('Olá {{first_name}}');
    const c = templateDigest('Olá {{first_name}}!');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(8);
  });
});
