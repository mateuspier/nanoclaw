import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from '../db.js';

import { upsertContact, optIn, getContact } from './contacts.js';
import { handleInboundOptOut } from './inbound-opt-out.js';

beforeEach(() => {
  _initTestDatabase();
});

// ── Happy path ────────────────────────────────────────────────────────────

describe('handleInboundOptOut — opt-out recorded', () => {
  it('records opt-out and returns a pt-BR confirmation when the body is PARE and contact lang is pt-BR', () => {
    upsertContact({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+353851234567',
      language: 'pt-BR',
    });
    optIn({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+353851234567',
      source: 'seed',
      purposes: ['marketing'],
    });

    const result = handleInboundOptOut({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+353851234567',
      body: 'PARE',
    });

    expect(result.actedOn).toBe(true);
    expect(result.contact?.optedOutAt).not.toBeNull();
    expect(result.contact?.optedOutReason).toBe('inbound:pare');
    expect(result.confirmationMessage).toMatch(/descadastrado/i);
  });

  it('records opt-out for STOP on a contact with en language', () => {
    upsertContact({
      businessSlug: 'biz-ie-01',
      channel: 'sms',
      phone: '+353851234567',
      language: 'en',
    });
    optIn({
      businessSlug: 'biz-ie-01',
      channel: 'sms',
      phone: '+353851234567',
      source: 'seed',
      purposes: ['marketing'],
    });

    const result = handleInboundOptOut({
      businessSlug: 'biz-ie-01',
      channel: 'sms',
      phone: '+353851234567',
      body: 'STOP',
    });
    expect(result.actedOn).toBe(true);
    expect(result.confirmationMessage).toMatch(/unsubscribed/i);
  });

  it('creates the contact on the fly if the opt-out message is the very first contact', () => {
    const result = handleInboundOptOut({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+353850000000',
      body: 'STOP',
    });
    expect(result.actedOn).toBe(true);
    const stored = getContact('biz-ie-01', 'whatsapp', '+353850000000')!;
    expect(stored.optedOutAt).not.toBeNull();
    // Language unknown → falls back to detected (en from STOP)
    expect(result.confirmationMessage).toMatch(/unsubscribed/i);
  });

  it('uses stored language over detected language when both known', () => {
    upsertContact({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+1',
      language: 'pt-BR',
    });
    optIn({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+1',
      source: 'seed',
      purposes: ['marketing'],
    });
    // User sends STOP (english keyword) but their language is pt-BR.
    const result = handleInboundOptOut({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+1',
      body: 'STOP',
    });
    expect(result.actedOn).toBe(true);
    expect(result.confirmationMessage).toMatch(/descadastrado/i);
  });
});

// ── Negative paths ────────────────────────────────────────────────────────

describe('handleInboundOptOut — no action', () => {
  it('returns actedOn:false for a normal customer message', () => {
    upsertContact({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+353851234567',
    });
    const result = handleInboundOptOut({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+353851234567',
      body: 'Quanto custa morar em Cork?',
    });
    expect(result.actedOn).toBe(false);
    expect(result.reason).toBe('not-opt-out');
    expect(result.confirmationMessage).toBeUndefined();
  });

  it('returns already-opted-out and DOES NOT re-confirm if already opted out', () => {
    upsertContact({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+353851234567',
    });
    // First STOP: confirmed.
    handleInboundOptOut({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+353851234567',
      body: 'STOP',
    });
    // Second STOP: idempotent, no confirmation.
    const result = handleInboundOptOut({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+353851234567',
      body: 'STOP',
    });
    expect(result.actedOn).toBe(false);
    expect(result.reason).toBe('already-opted-out');
    expect(result.confirmationMessage).toBeUndefined();
  });

  it('long messages with embedded keywords do not trigger', () => {
    upsertContact({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+1',
    });
    const result = handleInboundOptOut({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+1',
      body: 'please help us stop the war in the region',
    });
    expect(result.actedOn).toBe(false);
    const stored = getContact('biz-ie-01', 'whatsapp', '+1')!;
    expect(stored.optedOutAt).toBeNull();
  });
});

// ── Cross-business isolation ──────────────────────────────────────────────

describe('handleInboundOptOut — business isolation', () => {
  it('opts out in one business does not affect the same phone in another', () => {
    upsertContact({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+353851234567',
    });
    optIn({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+353851234567',
      source: 'seed',
      purposes: ['marketing'],
    });
    upsertContact({
      businessSlug: 'biz-br-01',
      channel: 'whatsapp',
      phone: '+353851234567',
    });
    optIn({
      businessSlug: 'biz-br-01',
      channel: 'whatsapp',
      phone: '+353851234567',
      source: 'seed',
      purposes: ['marketing'],
    });

    handleInboundOptOut({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+353851234567',
      body: 'STOP',
    });

    const ie = getContact('biz-ie-01', 'whatsapp', '+353851234567')!;
    const br = getContact('biz-br-01', 'whatsapp', '+353851234567')!;
    expect(ie.optedOutAt).not.toBeNull();
    expect(br.optedOutAt).toBeNull();
  });
});
