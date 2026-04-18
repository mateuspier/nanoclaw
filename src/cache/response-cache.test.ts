import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { _initTestDatabase } from '../db.js';

import {
  normalizePrompt,
  cacheKey,
  isPersonalPrompt,
  extractCacheDirectives,
  lookupCached,
  storeResponse,
  invalidatePattern,
  invalidateGroup,
  pruneExpired,
  getCacheStats,
  DEFAULT_TTL_SECONDS,
  MAX_TTL_SECONDS,
} from './response-cache.js';

beforeEach(() => {
  _initTestDatabase();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── normalizePrompt ───────────────────────────────────────────────────────

describe('normalizePrompt', () => {
  it('lowercases, trims, and collapses whitespace', () => {
    expect(normalizePrompt('  Quanto  Custa? ')).toBe('quanto custa');
  });

  it('strips Portuguese diacritics so accented/unaccented collide', () => {
    expect(normalizePrompt('Não sei')).toBe(normalizePrompt('Nao sei'));
    expect(normalizePrompt('Olá, visto')).toBe(normalizePrompt('Ola, visto'));
  });

  it('strips leading greetings in both pt and en', () => {
    expect(normalizePrompt('Oi, quanto custa Cork?')).toBe('quanto custa cork');
    expect(normalizePrompt('bom dia, tem anime?')).toBe('tem anime');
    expect(normalizePrompt('Hello, what time is the drop?')).toBe(
      'what time is the drop',
    );
  });

  it('removes time/date-looking numbers', () => {
    expect(normalizePrompt('horario 14:30')).not.toMatch(/14/);
    expect(normalizePrompt('dia 15/04')).not.toMatch(/15/);
  });

  it('strips trailing punctuation', () => {
    expect(normalizePrompt('tem anime?!!')).toBe('tem anime');
  });
});

// ── cacheKey ──────────────────────────────────────────────────────────────

describe('cacheKey', () => {
  it('is stable for the same inputs', () => {
    expect(cacheKey('biz-ie-01', 'whatsapp', 'quanto custa cork')).toBe(
      cacheKey('biz-ie-01', 'whatsapp', 'quanto custa cork'),
    );
  });

  it('differs when the group differs', () => {
    expect(cacheKey('biz-ie-01', 'sms', 'x')).not.toBe(
      cacheKey('biz-br-01', 'sms', 'x'),
    );
  });

  it('differs when the channel differs', () => {
    expect(cacheKey('g', 'sms', 'x')).not.toBe(cacheKey('g', 'whatsapp', 'x'));
  });
});

// ── isPersonalPrompt ──────────────────────────────────────────────────────

describe('isPersonalPrompt', () => {
  it('blocks short prompts', () => {
    expect(isPersonalPrompt('ok')).toBe(true);
    expect(isPersonalPrompt('sim')).toBe(true);
  });

  it('blocks possessive pronouns (pt + en)', () => {
    expect(isPersonalPrompt('meu pedido chegou')).toBe(true);
    expect(isPersonalPrompt('my order hasnt arrived')).toBe(true);
    expect(isPersonalPrompt('minha conta bloqueada')).toBe(true);
  });

  it('blocks immigration-personal questions', () => {
    expect(isPersonalPrompt('como esta meu visto irlanda')).toBe(true);
  });

  it('blocks balance / password / account mentions', () => {
    expect(isPersonalPrompt('qual o saldo da conta')).toBe(true);
    expect(isPersonalPrompt('esqueci a senha')).toBe(true);
  });

  it('allows generic factual questions', () => {
    expect(isPersonalPrompt('quanto custa alugar em cork')).toBe(false);
    expect(isPersonalPrompt('qual o horario do drop')).toBe(false);
    expect(isPersonalPrompt('tem envio internacional')).toBe(false);
  });

  it('blocks prompts with order IDs', () => {
    expect(isPersonalPrompt('pedido 123456 nao chegou')).toBe(true);
  });
});

// ── extractCacheDirectives ────────────────────────────────────────────────

describe('extractCacheDirectives', () => {
  it('returns the response unchanged when no tags are present', () => {
    const r = extractCacheDirectives('Aluguel em Cork: 1500-2000 EUR/mes.');
    expect(r.cleaned).toBe('Aluguel em Cork: 1500-2000 EUR/mes.');
    expect(r.noCache).toBe(false);
    expect(r.ttlSeconds).toBeUndefined();
  });

  it('detects [no-cache] and strips it', () => {
    const r = extractCacheDirectives('Resposta. [no-cache]');
    expect(r.noCache).toBe(true);
    expect(r.cleaned).toBe('Resposta.');
  });

  it('parses [cache:1h] into seconds', () => {
    expect(extractCacheDirectives('x [cache:1h]').ttlSeconds).toBe(3600);
    expect(extractCacheDirectives('x [cache:30m]').ttlSeconds).toBe(1800);
    expect(extractCacheDirectives('x [cache:2d]').ttlSeconds).toBe(172800);
    expect(extractCacheDirectives('x [cache:90s]').ttlSeconds).toBe(90);
  });

  it('caps [cache:...] at MAX_TTL_SECONDS', () => {
    // 30d requested, 7d cap
    expect(extractCacheDirectives('x [cache:30d]').ttlSeconds).toBe(
      MAX_TTL_SECONDS,
    );
  });

  it('is case-insensitive', () => {
    expect(extractCacheDirectives('x [NO-CACHE]').noCache).toBe(true);
    expect(extractCacheDirectives('x [Cache:1H]').ttlSeconds).toBe(3600);
  });
});

// ── lookup / store round-trip ─────────────────────────────────────────────

describe('lookupCached + storeResponse', () => {
  it('returns hit:false on empty cache', () => {
    expect(
      lookupCached({
        groupFolder: 'biz-ie-01',
        channel: 'sms',
        prompt: 'quanto custa cork',
      }).hit,
    ).toBe(false);
  });

  it('stores and retrieves a response', () => {
    const store = storeResponse({
      groupFolder: 'biz-ie-01',
      channel: 'sms',
      prompt: 'Quanto custa morar em Cork?',
      response: '1500 a 2000 euros/mes.',
    });
    expect(store.cached).toBe(true);
    expect(store.ttlSeconds).toBe(DEFAULT_TTL_SECONDS);

    const hit = lookupCached({
      groupFolder: 'biz-ie-01',
      channel: 'sms',
      // greeting + different punctuation; normalization must still hit
      prompt: 'Oi, quanto custa morar em Cork!',
    });
    expect(hit.hit).toBe(true);
    expect(hit.response).toBe('1500 a 2000 euros/mes.');
    expect(hit.ttlRemainingSeconds).toBeGreaterThan(0);
  });

  it('refuses to cache personal prompts', () => {
    const r = storeResponse({
      groupFolder: 'biz-ie-01',
      channel: 'sms',
      prompt: 'quando chega meu visto',
      response: 'Depende.',
    });
    expect(r.cached).toBe(false);
    expect(r.reason).toBe('personal-or-too-short');
  });

  it('honors [no-cache] tag from the agent', () => {
    const r = storeResponse({
      groupFolder: 'biz-ie-01',
      channel: 'sms',
      prompt: 'qual feriado hoje',
      response: 'Hoje nao tem feriado. [no-cache]',
    });
    expect(r.cached).toBe(false);
    expect(r.reason).toBe('agent-opt-out');
  });

  it('strips [cache:Xh] from the stored response', () => {
    storeResponse({
      groupFolder: 'biz-ie-01',
      channel: 'sms',
      prompt: 'qual horario da loja',
      response: 'Das 9 as 18h. [cache:6h]',
    });
    const hit = lookupCached({
      groupFolder: 'biz-ie-01',
      channel: 'sms',
      prompt: 'qual horario da loja',
    });
    expect(hit.hit).toBe(true);
    expect(hit.response).toBe('Das 9 as 18h.');
  });

  it('honors [cache:30m] TTL override', () => {
    const r = storeResponse({
      groupFolder: 'biz-ie-01',
      channel: 'sms',
      prompt: 'qual a temperatura agora em dublin',
      response: '14 graus. [cache:30m]',
    });
    expect(r.ttlSeconds).toBe(1800);
  });

  it('rejects empty responses', () => {
    const r = storeResponse({
      groupFolder: 'biz-ie-01',
      channel: 'sms',
      prompt: 'hello world qual horario',
      response: '   ',
    });
    expect(r.cached).toBe(false);
  });

  it('isolates cache entries across groups', () => {
    storeResponse({
      groupFolder: 'biz-ie-01',
      channel: 'sms',
      prompt: 'quanto custa morar',
      response: 'IE: 1500 euros.',
    });
    storeResponse({
      groupFolder: 'biz-br-01',
      channel: 'sms',
      prompt: 'quanto custa morar',
      response: 'BR: 2000 reais.',
    });

    const ie = lookupCached({
      groupFolder: 'biz-ie-01',
      channel: 'sms',
      prompt: 'quanto custa morar',
    });
    const br = lookupCached({
      groupFolder: 'biz-br-01',
      channel: 'sms',
      prompt: 'quanto custa morar',
    });
    expect(ie.response).toBe('IE: 1500 euros.');
    expect(br.response).toBe('BR: 2000 reais.');
  });

  it('upserts: a later store for the same key replaces the response', () => {
    storeResponse({
      groupFolder: 'g',
      channel: 'sms',
      prompt: 'qual preco do produto',
      response: 'A',
    });
    storeResponse({
      groupFolder: 'g',
      channel: 'sms',
      prompt: 'qual preco do produto',
      response: 'B',
    });
    expect(
      lookupCached({
        groupFolder: 'g',
        channel: 'sms',
        prompt: 'qual preco do produto',
      }).response,
    ).toBe('B');
  });
});

// ── expiry ────────────────────────────────────────────────────────────────

describe('expiry', () => {
  it('returns hit:false on expired entries', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T10:00:00Z'));
    storeResponse({
      groupFolder: 'g',
      channel: 'sms',
      prompt: 'qual horario da loja',
      response: 'Das 9 as 18h. [cache:1h]',
    });

    // 30 min later: hit
    vi.setSystemTime(new Date('2026-04-18T10:30:00Z'));
    expect(
      lookupCached({
        groupFolder: 'g',
        channel: 'sms',
        prompt: 'qual horario da loja',
      }).hit,
    ).toBe(true);

    // 2h later: expired
    vi.setSystemTime(new Date('2026-04-18T12:00:00Z'));
    expect(
      lookupCached({
        groupFolder: 'g',
        channel: 'sms',
        prompt: 'qual horario da loja',
      }).hit,
    ).toBe(false);
  });

  it('pruneExpired removes only expired rows', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T10:00:00Z'));
    storeResponse({
      groupFolder: 'g',
      channel: 'sms',
      prompt: 'qual horario da loja',
      response: 'A [cache:1h]',
    });
    storeResponse({
      groupFolder: 'g',
      channel: 'sms',
      prompt: 'qual horario do drop',
      response: 'B [cache:48h]',
    });

    vi.setSystemTime(new Date('2026-04-18T12:00:00Z'));
    expect(pruneExpired()).toBe(1);
    expect(getCacheStats('g').total).toBe(1);
  });
});

// ── invalidation ──────────────────────────────────────────────────────────

describe('invalidation', () => {
  beforeEach(() => {
    storeResponse({
      groupFolder: 'biz-ie-01',
      channel: 'sms',
      prompt: 'quando eh o show de bts',
      response: 'Dia 20/06.',
    });
    storeResponse({
      groupFolder: 'biz-ie-01',
      channel: 'sms',
      prompt: 'qual ingresso para o show',
      response: 'A partir de 200eur.',
    });
    storeResponse({
      groupFolder: 'biz-ie-01',
      channel: 'sms',
      prompt: 'qual horario de funcionamento',
      response: '9-18.',
    });
  });

  it('invalidatePattern removes matching entries only', () => {
    const removed = invalidatePattern('biz-ie-01', 'show');
    expect(removed).toBe(2);
    expect(
      lookupCached({
        groupFolder: 'biz-ie-01',
        channel: 'sms',
        prompt: 'qual horario de funcionamento',
      }).hit,
    ).toBe(true);
  });

  it('invalidatePattern rejects patterns shorter than 2 chars', () => {
    expect(() => invalidatePattern('biz-ie-01', 'x')).toThrow();
  });

  it('invalidateGroup wipes all entries for one group', () => {
    storeResponse({
      groupFolder: 'biz-br-01',
      channel: 'sms',
      prompt: 'qual horario de loja brasil',
      response: 'X',
    });
    const removed = invalidateGroup('biz-ie-01');
    expect(removed).toBe(3);
    expect(getCacheStats('biz-br-01').total).toBe(1);
  });
});

// ── hit tracking + stats ──────────────────────────────────────────────────

describe('hit tracking', () => {
  it('counts hits on lookup', () => {
    storeResponse({
      groupFolder: 'g',
      channel: 'sms',
      prompt: 'qual preco do produto',
      response: 'R$10.',
    });
    lookupCached({
      groupFolder: 'g',
      channel: 'sms',
      prompt: 'qual preco do produto',
    });
    lookupCached({
      groupFolder: 'g',
      channel: 'sms',
      prompt: 'qual preco do produto',
    });
    expect(getCacheStats('g').totalHits).toBe(2);
  });

  it('reports stats scoped to a group', () => {
    storeResponse({
      groupFolder: 'a',
      channel: 'sms',
      prompt: 'qual horario da loja',
      response: 'x',
    });
    storeResponse({
      groupFolder: 'b',
      channel: 'sms',
      prompt: 'qual horario da loja',
      response: 'y',
    });
    expect(getCacheStats('a').total).toBe(1);
    expect(getCacheStats().total).toBe(2);
  });
});
