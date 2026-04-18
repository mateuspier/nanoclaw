import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from '../db.js';

import { upsertContact, optIn, optOut, getContact } from './contacts.js';
import { handleInboundWaitlist } from './inbound-waitlist.js';

beforeEach(() => {
  _initTestDatabase();
});

const BASE_INPUT = {
  businessSlug: 'biz-br-01',
  channel: 'whatsapp' as const,
  phone: '+5511911112222',
  waitlistTag: 'store-waitlist',
  businessName: 'MiauPop',
  productLabel: 'lista de espera da loja',
};

// ── Happy path ────────────────────────────────────────────────────────────

describe('handleInboundWaitlist — opt-in recorded', () => {
  it('tags an existing contact + returns pt-BR confirmation', () => {
    upsertContact({
      businessSlug: 'biz-br-01',
      channel: 'whatsapp',
      phone: '+5511911112222',
      language: 'pt-BR',
    });
    const r = handleInboundWaitlist({ ...BASE_INPUT, body: 'AVISAR' });
    expect(r.actedOn).toBe(true);
    expect(r.contact?.tags).toContain('store-waitlist');
    expect(r.contact?.optedInAt).not.toBeNull();
    expect(r.contact?.purposes).toContain('utility');
    expect(r.confirmationMessage).toMatch(/MiauPop/);
    expect(r.confirmationMessage).toMatch(/lista de espera da loja/);
  });

  it('creates the contact row if this is their first message', () => {
    const r = handleInboundWaitlist({ ...BASE_INPUT, body: 'AVISAR' });
    expect(r.actedOn).toBe(true);
    const stored = getContact('biz-br-01', 'whatsapp', '+5511911112222')!;
    expect(stored.tags).toContain('store-waitlist');
    expect(stored.optedInAt).not.toBeNull();
  });

  it('preserves prior purposes when adding utility via waitlist', () => {
    upsertContact({
      businessSlug: 'biz-br-01',
      channel: 'whatsapp',
      phone: '+5511911112222',
      language: 'pt-BR',
    });
    optIn({
      businessSlug: 'biz-br-01',
      channel: 'whatsapp',
      phone: '+5511911112222',
      source: 'website',
      purposes: ['marketing'],
    });
    const r = handleInboundWaitlist({ ...BASE_INPUT, body: 'AVISAR' });
    expect(r.actedOn).toBe(true);
    expect(r.contact?.purposes.sort()).toEqual(['marketing', 'utility']);
  });

  it('records the opt-in source as waitlist:<tag>', () => {
    const r = handleInboundWaitlist({ ...BASE_INPUT, body: 'AVISAR' });
    expect(r.actedOn).toBe(true);
    expect(r.contact?.optInSource).toBe('waitlist:store-waitlist');
  });

  it('prefers stored language over detected language', () => {
    upsertContact({
      businessSlug: 'biz-br-01',
      channel: 'whatsapp',
      phone: '+5511911112222',
      language: 'pt-BR',
    });
    // User sends English keyword but their language is pt-BR.
    const r = handleInboundWaitlist({ ...BASE_INPUT, body: 'notify' });
    expect(r.actedOn).toBe(true);
    expect(r.confirmationMessage).toMatch(/MiauPop/);
    // Portuguese template uses "avisar" — English template says "waitlist".
    expect(r.confirmationMessage).toMatch(/avisar/i);
  });
});

// ── Negative paths ────────────────────────────────────────────────────────

describe('handleInboundWaitlist — no action', () => {
  it('returns not-confirmation on a customer message', () => {
    const r = handleInboundWaitlist({
      ...BASE_INPUT,
      body: 'quanto custa o ingresso do show?',
    });
    expect(r.actedOn).toBe(false);
    expect(r.reason).toBe('not-confirmation');
    expect(r.confirmationMessage).toBeUndefined();
  });

  it('returns already-on-waitlist on repeat AVISAR and does NOT re-confirm', () => {
    // First call tags them.
    handleInboundWaitlist({ ...BASE_INPUT, body: 'AVISAR' });
    // Second call is a no-op.
    const second = handleInboundWaitlist({ ...BASE_INPUT, body: 'AVISAR' });
    expect(second.actedOn).toBe(false);
    expect(second.reason).toBe('already-on-waitlist');
    expect(second.confirmationMessage).toBeUndefined();
  });

  it('refuses to re-opt-in an opted-out contact', () => {
    upsertContact({
      businessSlug: 'biz-br-01',
      channel: 'whatsapp',
      phone: '+5511911112222',
    });
    optOut({
      businessSlug: 'biz-br-01',
      channel: 'whatsapp',
      phone: '+5511911112222',
      reason: 'STOP',
    });
    const r = handleInboundWaitlist({ ...BASE_INPUT, body: 'AVISAR' });
    expect(r.actedOn).toBe(false);
    expect(r.reason).toBe('opted-out');
    const stored = getContact('biz-br-01', 'whatsapp', '+5511911112222')!;
    expect(stored.tags).not.toContain('store-waitlist');
    expect(stored.optedOutAt).not.toBeNull();
  });

  it('long customer messages with embedded keyword are not tagged', () => {
    const r = handleInboundWaitlist({
      ...BASE_INPUT,
      body: 'oi pode avisar quando a nova temporada de stranger things estrear',
    });
    expect(r.actedOn).toBe(false);
    const stored = getContact('biz-br-01', 'whatsapp', '+5511911112222');
    expect(stored).toBeNull();
  });
});

// ── Cross-business isolation ──────────────────────────────────────────────

describe('handleInboundWaitlist — business isolation', () => {
  it('tag in one business does not appear in another business', () => {
    handleInboundWaitlist({
      ...BASE_INPUT,
      businessSlug: 'biz-br-01',
      body: 'AVISAR',
    });
    handleInboundWaitlist({
      ...BASE_INPUT,
      businessSlug: 'biz-ie-01',
      businessName: 'Sou da Irlanda',
      waitlistTag: 'services-waitlist',
      body: 'AVISAR',
    });

    const br = getContact('biz-br-01', 'whatsapp', '+5511911112222')!;
    const ie = getContact('biz-ie-01', 'whatsapp', '+5511911112222')!;
    expect(br.tags).toContain('store-waitlist');
    expect(br.tags).not.toContain('services-waitlist');
    expect(ie.tags).toContain('services-waitlist');
    expect(ie.tags).not.toContain('store-waitlist');
  });
});
