import { describe, it, expect } from 'vitest';

import { buildAlerts, formatReport } from './saude.js';

const BASE_TOTALS = {
  activeGroups: 2,
  messagesLast24h: 10,
  messagesLast7d: 50,
  dueTasks: 1,
  overdueTasks: 0,
};

const EMPTY_CACHE = {
  total: 0,
  activeEntries: 0,
  expiredEntries: 0,
  totalHits: 0,
  estimatedBytes: 0,
};

describe('buildAlerts', () => {
  it('warns on overdue tasks', () => {
    const a = buildAlerts({
      totals: { ...BASE_TOTALS, overdueTasks: 3 },
      cache: { ...EMPTY_CACHE, activeEntries: 1, total: 1 },
      breakers: [],
      groups: [],
    });
    expect(a.some((x) => /3 .*overdue/.test(x))).toBe(true);
  });

  it('warns on open breakers and names them', () => {
    const a = buildAlerts({
      totals: BASE_TOTALS,
      cache: { ...EMPTY_CACHE, activeEntries: 1, total: 1 },
      breakers: [
        {
          name: 'twilio.sms',
          state: 'open',
          consecutiveFailures: 5,
          lastFailureAt: null,
          lastSuccessAt: null,
          openedAt: null,
          totalCalls: 0,
          totalFailures: 0,
          shortCircuitedCalls: 0,
        },
      ],
      groups: [],
    });
    expect(a.some((x) => /breaker open.*twilio\.sms/.test(x))).toBe(true);
  });

  it('does not warn when all breakers are closed', () => {
    const a = buildAlerts({
      totals: BASE_TOTALS,
      cache: { ...EMPTY_CACHE, activeEntries: 1, total: 1 },
      breakers: [
        {
          name: 'twilio.sms',
          state: 'closed',
          consecutiveFailures: 0,
          lastFailureAt: null,
          lastSuccessAt: null,
          openedAt: null,
          totalCalls: 10,
          totalFailures: 0,
          shortCircuitedCalls: 0,
        },
      ],
      groups: [],
    });
    expect(a.some((x) => /breaker open/.test(x))).toBe(false);
  });

  it('flags groups dormant for >14 days', () => {
    const longAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
    const a = buildAlerts({
      totals: BASE_TOTALS,
      cache: { ...EMPTY_CACHE, activeEntries: 1, total: 1 },
      breakers: [],
      groups: [
        {
          folder: 'biz-ie-01',
          name: 'Sou da Irlanda',
          messagesLast24h: 0,
          messagesLast7d: 0,
          lastMessageAt: longAgo,
          dueTasks: 0,
          cacheActiveEntries: 0,
          cacheHits: 0,
          cacheEstimatedKB: 0,
        },
      ],
    });
    expect(a.some((x) => /biz-ie-01.*dormant/.test(x))).toBe(true);
  });

  it('does not flag recent activity', () => {
    const yesterday = new Date(Date.now() - 86400_000).toISOString();
    const a = buildAlerts({
      totals: BASE_TOTALS,
      cache: { ...EMPTY_CACHE, activeEntries: 1, total: 1 },
      breakers: [],
      groups: [
        {
          folder: 'biz-ie-01',
          name: 'Sou da Irlanda',
          messagesLast24h: 5,
          messagesLast7d: 20,
          lastMessageAt: yesterday,
          dueTasks: 0,
          cacheActiveEntries: 0,
          cacheHits: 0,
          cacheEstimatedKB: 0,
        },
      ],
    });
    expect(a.some((x) => /dormant/.test(x))).toBe(false);
  });

  it('flags an empty cache as "not wired yet"', () => {
    const a = buildAlerts({
      totals: BASE_TOTALS,
      cache: EMPTY_CACHE,
      breakers: [],
      groups: [],
    });
    expect(a.some((x) => /cache empty/.test(x))).toBe(true);
  });

  it('does not flag an active cache', () => {
    const a = buildAlerts({
      totals: BASE_TOTALS,
      cache: { ...EMPTY_CACHE, activeEntries: 12, total: 15, totalHits: 120 },
      breakers: [],
      groups: [],
    });
    expect(a.some((x) => /cache empty/.test(x))).toBe(false);
  });
});

describe('formatReport', () => {
  it('renders a compact single-screen block', () => {
    const out = formatReport({
      generatedAt: '2026-04-18T18:00:00Z',
      totals: BASE_TOTALS,
      cache: {
        total: 15,
        activeEntries: 12,
        expiredEntries: 3,
        totalHits: 40,
        estimatedBytes: 8192,
      },
      breakers: [],
      groups: [
        {
          folder: 'biz-ie-01',
          name: 'SDI',
          messagesLast24h: 3,
          messagesLast7d: 24,
          lastMessageAt: '2026-04-17T10:00:00Z',
          dueTasks: 0,
          cacheActiveEntries: 5,
          cacheHits: 20,
          cacheEstimatedKB: 2,
        },
      ],
      alerts: [],
    });
    expect(out).toContain('NanoClaw saude');
    expect(out).toContain('biz-ie-01');
    expect(out).toContain('3/24h');
    expect(out).toContain('cache:5e/20h');
    expect(out).toContain('(all): 12 active, 3 expired, 40 hits');
  });

  it('prints "(none registered)" when breakers is empty', () => {
    const out = formatReport({
      generatedAt: 'now',
      totals: BASE_TOTALS,
      cache: EMPTY_CACHE,
      breakers: [],
      groups: [],
      alerts: [],
    });
    expect(out).toContain('(none registered in this process)');
  });

  it('appends alerts when present', () => {
    const out = formatReport({
      generatedAt: 'now',
      totals: BASE_TOTALS,
      cache: EMPTY_CACHE,
      breakers: [],
      groups: [],
      alerts: ['something is wrong', 'another issue'],
    });
    expect(out).toContain('alerts:');
    expect(out).toContain('! something is wrong');
    expect(out).toContain('! another issue');
  });

  it('omits the alerts block entirely when there are none', () => {
    const out = formatReport({
      generatedAt: 'now',
      totals: BASE_TOTALS,
      cache: { ...EMPTY_CACHE, activeEntries: 1, total: 1 },
      breakers: [],
      groups: [],
      alerts: [],
    });
    expect(out).not.toContain('alerts:');
  });
});
