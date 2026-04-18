import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from '../db.js';

import {
  upsertContact,
  getContact,
  getContactById,
  optIn,
  optOut,
  isEligibleFor,
  addTag,
  removeTag,
  findContacts,
  countContacts,
} from './contacts.js';

beforeEach(() => {
  _initTestDatabase();
});

// ── upsertContact + getContact ────────────────────────────────────────────

describe('upsertContact', () => {
  it('creates a new contact with defaults', () => {
    const c = upsertContact({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+353851234567',
      firstName: 'Ana',
      language: 'pt-BR',
    });
    expect(c.id).toBeGreaterThan(0);
    expect(c.businessSlug).toBe('biz-ie-01');
    expect(c.firstName).toBe('Ana');
    expect(c.tags).toEqual([]);
    expect(c.purposes).toEqual([]);
    expect(c.optedInAt).toBeNull();
    expect(c.conversationCount).toBe(0);
  });

  it('updates provided fields and leaves undefined ones alone', () => {
    upsertContact({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+353851234567',
      firstName: 'Ana',
      language: 'pt-BR',
    });
    const updated = upsertContact({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+353851234567',
      lastName: 'Silva',
      // firstName omitted — should remain 'Ana'
    });
    expect(updated.firstName).toBe('Ana');
    expect(updated.lastName).toBe('Silva');
    expect(updated.language).toBe('pt-BR');
  });

  it('allows explicit null to clear a field', () => {
    upsertContact({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+1',
      firstName: 'Ana',
    });
    const updated = upsertContact({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+1',
      firstName: null,
    });
    expect(updated.firstName).toBeNull();
  });

  it('replaces tags when provided', () => {
    upsertContact({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+1',
      tags: ['cork', 'housing'],
    });
    const updated = upsertContact({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+1',
      tags: ['dublin'],
    });
    expect(updated.tags).toEqual(['dublin']);
  });

  it('touch:true increments conversation_count on update', () => {
    upsertContact({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+1',
    });
    upsertContact({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+1',
      touch: true,
    });
    upsertContact({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+1',
      touch: true,
    });
    const c = getContact('biz-ie-01', 'whatsapp', '+1')!;
    expect(c.conversationCount).toBe(2);
  });

  it('isolates contacts across businesses with the same phone', () => {
    upsertContact({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+353851234567',
      firstName: 'IE',
    });
    upsertContact({
      businessSlug: 'biz-br-01',
      channel: 'whatsapp',
      phone: '+353851234567',
      firstName: 'BR',
    });
    expect(getContact('biz-ie-01', 'whatsapp', '+353851234567')!.firstName).toBe('IE');
    expect(getContact('biz-br-01', 'whatsapp', '+353851234567')!.firstName).toBe('BR');
  });

  it('distinguishes (biz, channel, phone) uniquely — same phone, different channel = different rows', () => {
    const sms = upsertContact({
      businessSlug: 'biz-ie-01',
      channel: 'sms',
      phone: '+1',
    });
    const wa = upsertContact({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+1',
    });
    expect(sms.id).not.toBe(wa.id);
  });
});

// ── optIn / optOut / isEligibleFor ───────────────────────────────────────

describe('optIn + optOut', () => {
  function seed() {
    return upsertContact({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+353851234567',
    });
  }

  it('records opt-in with source and purposes', () => {
    seed();
    const c = optIn({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+353851234567',
      source: 'website-form',
      purposes: ['marketing', 'utility'],
    });
    expect(c.optedInAt).not.toBeNull();
    expect(c.optInSource).toBe('website-form');
    expect(c.purposes).toEqual(['marketing', 'utility']);
    expect(c.optedOutAt).toBeNull();
  });

  it('optOut clears opt-in state but keeps the contact', () => {
    seed();
    optIn({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+353851234567',
      source: 'x',
      purposes: ['marketing'],
    });
    const c = optOut({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+353851234567',
      reason: 'STOP',
    });
    expect(c.optedOutAt).not.toBeNull();
    expect(c.optedOutReason).toBe('STOP');
    expect(c.optedInAt).toBeNull();
    expect(c.purposes).toEqual([]);
  });

  it('optIn after optOut lifts the block', () => {
    seed();
    optIn({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+353851234567',
      source: 'x',
      purposes: ['marketing'],
    });
    optOut({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+353851234567',
      reason: 'STOP',
    });
    const c = optIn({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+353851234567',
      source: 'resubscribe',
      purposes: ['marketing'],
    });
    expect(c.optedOutAt).toBeNull();
    expect(c.optedInAt).not.toBeNull();
    expect(c.optInSource).toBe('resubscribe');
  });

  it('optIn dedupes duplicate purposes', () => {
    seed();
    const c = optIn({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+353851234567',
      source: 'x',
      purposes: ['marketing', 'marketing', 'utility'],
    });
    expect(c.purposes.sort()).toEqual(['marketing', 'utility'].sort());
  });

  it('throws when opt-in is called on a nonexistent contact', () => {
    expect(() =>
      optIn({
        businessSlug: 'biz-ie-01',
        channel: 'whatsapp',
        phone: '+notfound',
        source: 'x',
        purposes: ['marketing'],
      }),
    ).toThrow(/not found/);
  });

  it('throws when opt-in has no purposes', () => {
    seed();
    expect(() =>
      optIn({
        businessSlug: 'biz-ie-01',
        channel: 'whatsapp',
        phone: '+353851234567',
        source: 'x',
        purposes: [],
      }),
    ).toThrow(/at least one purpose/);
  });
});

describe('isEligibleFor', () => {
  function seedOptedIn(purposes: ('marketing' | 'utility' | 'transactional')[]) {
    upsertContact({ businessSlug: 'b', channel: 'whatsapp', phone: '+1' });
    return optIn({
      businessSlug: 'b',
      channel: 'whatsapp',
      phone: '+1',
      source: 'x',
      purposes,
    });
  }

  it('true when opted in for the purpose', () => {
    const c = seedOptedIn(['marketing']);
    expect(isEligibleFor(c, 'marketing')).toBe(true);
  });

  it('false when not opted in for the purpose', () => {
    const c = seedOptedIn(['utility']);
    expect(isEligibleFor(c, 'marketing')).toBe(false);
  });

  it('false when opted out', () => {
    seedOptedIn(['marketing']);
    const c = optOut({
      businessSlug: 'b',
      channel: 'whatsapp',
      phone: '+1',
      reason: 'STOP',
    });
    expect(isEligibleFor(c, 'marketing')).toBe(false);
  });

  it('false when never opted in', () => {
    const c = upsertContact({
      businessSlug: 'b',
      channel: 'whatsapp',
      phone: '+1',
    });
    expect(isEligibleFor(c, 'marketing')).toBe(false);
  });
});

// ── Tags ─────────────────────────────────────────────────────────────────

describe('addTag + removeTag', () => {
  beforeEach(() => {
    upsertContact({ businessSlug: 'b', channel: 'whatsapp', phone: '+1' });
  });

  it('adds a new tag', () => {
    const c = addTag('b', 'whatsapp', '+1', 'cork');
    expect(c.tags).toContain('cork');
  });

  it('does not duplicate existing tags', () => {
    addTag('b', 'whatsapp', '+1', 'cork');
    const c = addTag('b', 'whatsapp', '+1', 'cork');
    expect(c.tags.filter((t) => t === 'cork')).toHaveLength(1);
  });

  it('removes a tag', () => {
    addTag('b', 'whatsapp', '+1', 'cork');
    addTag('b', 'whatsapp', '+1', 'housing');
    const c = removeTag('b', 'whatsapp', '+1', 'cork');
    expect(c.tags).toEqual(['housing']);
  });

  it('removeTag is a no-op when the tag is absent', () => {
    addTag('b', 'whatsapp', '+1', 'housing');
    const c = removeTag('b', 'whatsapp', '+1', 'cork');
    expect(c.tags).toEqual(['housing']);
  });
});

// ── findContacts + countContacts ──────────────────────────────────────────

describe('findContacts', () => {
  function seedEligible(
    biz: string,
    phone: string,
    tags: string[],
    language: string | null,
    purposes: ('marketing' | 'utility')[],
  ) {
    upsertContact({
      businessSlug: biz,
      channel: 'whatsapp',
      phone,
      language,
      tags,
    });
    optIn({
      businessSlug: biz,
      channel: 'whatsapp',
      phone,
      source: 'x',
      purposes,
    });
  }

  beforeEach(() => {
    // 3 opted-in marketing contacts in biz-ie-01 with different tags
    seedEligible('biz-ie-01', '+1', ['cork', 'housing'], 'pt-BR', ['marketing']);
    seedEligible('biz-ie-01', '+2', ['dublin'], 'pt-BR', ['marketing']);
    seedEligible('biz-ie-01', '+3', ['cork'], 'en', ['marketing']);
    // 1 opted in for utility only
    seedEligible('biz-ie-01', '+4', ['cork'], 'pt-BR', ['utility']);
    // 1 opted out
    upsertContact({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+5',
      tags: ['cork'],
      language: 'pt-BR',
    });
    optIn({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+5',
      source: 'x',
      purposes: ['marketing'],
    });
    optOut({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      phone: '+5',
      reason: 'STOP',
    });
    // 1 in another business
    seedEligible('biz-br-01', '+6', ['cork'], 'pt-BR', ['marketing']);
  });

  it('returns only contacts in the target business + channel', () => {
    const found = findContacts({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      purpose: 'marketing',
    });
    expect(found.map((c) => c.phone).sort()).toEqual(['+1', '+2', '+3']);
  });

  it('filters by purpose: marketing vs utility', () => {
    const marketing = findContacts({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      purpose: 'marketing',
    });
    const utility = findContacts({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      purpose: 'utility',
    });
    expect(marketing).toHaveLength(3);
    expect(utility).toHaveLength(1);
    expect(utility[0].phone).toBe('+4');
  });

  it('excludes opted-out contacts', () => {
    const found = findContacts({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      purpose: 'marketing',
    });
    expect(found.find((c) => c.phone === '+5')).toBeUndefined();
  });

  it('filters by language', () => {
    const found = findContacts({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      purpose: 'marketing',
      language: 'en',
    });
    expect(found).toHaveLength(1);
    expect(found[0].phone).toBe('+3');
  });

  it('tagsAll requires every tag to be present', () => {
    const found = findContacts({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      purpose: 'marketing',
      tagsAll: ['cork', 'housing'],
    });
    expect(found).toHaveLength(1);
    expect(found[0].phone).toBe('+1');
  });

  it('tagsAny returns contacts with any of the tags', () => {
    const found = findContacts({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      purpose: 'marketing',
      tagsAny: ['cork', 'dublin'],
    });
    expect(found.map((c) => c.phone).sort()).toEqual(['+1', '+2', '+3']);
  });

  it('countContacts returns the length of findContacts', () => {
    const segment = {
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp' as const,
      purpose: 'marketing' as const,
    };
    expect(countContacts(segment)).toBe(findContacts(segment).length);
  });

  it('respects limit', () => {
    const found = findContacts({
      businessSlug: 'biz-ie-01',
      channel: 'whatsapp',
      purpose: 'marketing',
      limit: 2,
    });
    expect(found.length).toBeLessThanOrEqual(2);
  });
});

// ── getContactById ────────────────────────────────────────────────────────

describe('getContactById', () => {
  it('fetches by primary key', () => {
    const a = upsertContact({
      businessSlug: 'b',
      channel: 'whatsapp',
      phone: '+1',
      firstName: 'Ana',
    });
    expect(getContactById(a.id)!.firstName).toBe('Ana');
  });

  it('returns null when not found', () => {
    expect(getContactById(9999)).toBeNull();
  });
});
