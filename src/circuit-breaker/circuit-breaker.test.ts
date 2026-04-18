import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import {
  getBreaker,
  getAllBreakerStats,
  CircuitOpenError,
  _resetRegistry,
} from './circuit-breaker.js';

beforeEach(() => {
  _resetRegistry();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Registry ─────────────────────────────────────────────────────────────

describe('registry', () => {
  it('returns the same instance for the same name', () => {
    const a = getBreaker('dep-a');
    const b = getBreaker('dep-a');
    expect(a).toBe(b);
  });

  it('returns different instances for different names', () => {
    expect(getBreaker('dep-a')).not.toBe(getBreaker('dep-b'));
  });

  it('ignores config on second call (first-creation wins)', () => {
    const a = getBreaker('dep-a', { failureThreshold: 1 });
    const b = getBreaker('dep-a', { failureThreshold: 999 });
    expect(a).toBe(b);
  });

  it('surfaces all breakers via getAllBreakerStats', () => {
    getBreaker('twilio');
    getBreaker('claude');
    getBreaker('gemini');
    expect(getAllBreakerStats().map((s) => s.name).sort()).toEqual([
      'claude',
      'gemini',
      'twilio',
    ]);
  });
});

// ── Closed state — happy path ─────────────────────────────────────────────

describe('state: closed (happy path)', () => {
  it('passes through successful calls', async () => {
    const b = getBreaker('dep');
    const result = await b.execute(async () => 42);
    expect(result).toBe(42);
    expect(b.getState()).toBe('closed');
  });

  it('counts successes in stats', async () => {
    const b = getBreaker('dep');
    await b.execute(async () => 1);
    await b.execute(async () => 2);
    const stats = b.getStats();
    expect(stats.totalCalls).toBe(2);
    expect(stats.totalFailures).toBe(0);
    expect(stats.lastSuccessAt).not.toBeNull();
  });

  it('propagates errors without tripping below threshold', async () => {
    const b = getBreaker('dep', { failureThreshold: 5 });
    for (let i = 0; i < 4; i++) {
      await expect(b.execute(async () => { throw new Error('x'); })).rejects.toThrow('x');
    }
    expect(b.getState()).toBe('closed');
  });

  it('resets consecutive-failure counter on success', async () => {
    const b = getBreaker('dep', { failureThreshold: 3 });
    await expect(b.execute(async () => { throw new Error('x'); })).rejects.toThrow();
    await expect(b.execute(async () => { throw new Error('x'); })).rejects.toThrow();
    await b.execute(async () => 'ok');
    // consecutive counter reset; need 3 more failures to open
    await expect(b.execute(async () => { throw new Error('x'); })).rejects.toThrow();
    await expect(b.execute(async () => { throw new Error('x'); })).rejects.toThrow();
    expect(b.getState()).toBe('closed');
  });
});

// ── Opening ──────────────────────────────────────────────────────────────

describe('opening', () => {
  it('opens after N consecutive failures', async () => {
    const b = getBreaker('dep', { failureThreshold: 3 });
    for (let i = 0; i < 3; i++) {
      await expect(b.execute(async () => { throw new Error('x'); })).rejects.toThrow('x');
    }
    expect(b.getState()).toBe('open');
  });

  it('short-circuits calls when open — does not invoke fn', async () => {
    const b = getBreaker('dep', { failureThreshold: 1, cooldownMs: 60_000 });
    await expect(b.execute(async () => { throw new Error('boom'); })).rejects.toThrow();
    expect(b.getState()).toBe('open');

    const spy = vi.fn(async () => 'should-not-run');
    await expect(b.execute(spy)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('CircuitOpenError carries retryAfterMs', async () => {
    const b = getBreaker('dep', { failureThreshold: 1, cooldownMs: 30_000 });
    await expect(b.execute(async () => { throw new Error(); })).rejects.toThrow();

    try {
      await b.execute(async () => 'x');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitOpenError);
      const e = err as CircuitOpenError;
      expect(e.breakerName).toBe('dep');
      expect(e.retryAfterMs).toBeGreaterThan(0);
      expect(e.retryAfterMs).toBeLessThanOrEqual(30_000);
    }
  });

  it('counts short-circuited calls in stats', async () => {
    const b = getBreaker('dep', { failureThreshold: 1, cooldownMs: 60_000 });
    await expect(b.execute(async () => { throw new Error(); })).rejects.toThrow();
    await expect(b.execute(async () => 'x')).rejects.toThrow();
    await expect(b.execute(async () => 'x')).rejects.toThrow();
    const stats = b.getStats();
    expect(stats.shortCircuitedCalls).toBe(2);
  });
});

// ── Half-open probe ───────────────────────────────────────────────────────

describe('half-open probe', () => {
  it('becomes eligible-for-probe after cooldown and transitions on next execute', async () => {
    vi.useFakeTimers();
    const b = getBreaker('dep', { failureThreshold: 1, cooldownMs: 1000 });

    // Trip it open.
    await expect(b.execute(async () => { throw new Error(); })).rejects.toThrow();
    expect(b.getState()).toBe('open');
    expect(b.isEligibleForProbe()).toBe(false);

    // Advance past cooldown — still OPEN until something calls execute again.
    await vi.advanceTimersByTimeAsync(1100);
    expect(b.getState()).toBe('open');
    expect(b.isEligibleForProbe()).toBe(true);

    // Next execute triggers the probe.
    const probe = b.execute(async () => 'ok');
    await expect(probe).resolves.toBe('ok');
    expect(b.getState()).toBe('closed');
  });

  it('closes the breaker when the probe succeeds', async () => {
    vi.useFakeTimers();
    const b = getBreaker('dep', { failureThreshold: 1, cooldownMs: 100 });

    await expect(b.execute(async () => { throw new Error(); })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(150);

    const result = await b.execute(async () => 'recovered');
    expect(result).toBe('recovered');
    expect(b.getState()).toBe('closed');
  });

  it('reopens the breaker when the probe fails', async () => {
    vi.useFakeTimers();
    const b = getBreaker('dep', { failureThreshold: 1, cooldownMs: 100 });

    await expect(b.execute(async () => { throw new Error(); })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(150);

    await expect(b.execute(async () => { throw new Error('still bad'); })).rejects.toThrow('still bad');
    expect(b.getState()).toBe('open');
  });

  it('serializes half-open probes — second concurrent call short-circuits', async () => {
    vi.useFakeTimers();
    const b = getBreaker('dep', { failureThreshold: 1, cooldownMs: 100, halfOpenTimeoutMs: 5000 });

    await expect(b.execute(async () => { throw new Error(); })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(150);

    // First probe: slow-running
    const slowPromise = b.execute(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return 'slow-ok';
    });

    // Second call while probe is in flight
    await expect(b.execute(async () => 'should-short-circuit')).rejects.toBeInstanceOf(
      CircuitOpenError,
    );

    // Let the probe finish
    await vi.advanceTimersByTimeAsync(250);
    await expect(slowPromise).resolves.toBe('slow-ok');
    expect(b.getState()).toBe('closed');
  });

  it('reopens if probe exceeds halfOpenTimeoutMs', async () => {
    vi.useFakeTimers();
    const b = getBreaker('dep', {
      failureThreshold: 1,
      cooldownMs: 100,
      halfOpenTimeoutMs: 500,
    });

    await expect(b.execute(async () => { throw new Error(); })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(150);

    const neverResolves = new Promise((_resolve) => {});
    const probePromise = b.execute(() => neverResolves as Promise<string>);

    await vi.advanceTimersByTimeAsync(600);
    await expect(probePromise).rejects.toThrow(/probe-timeout/);
    expect(b.getState()).toBe('open');
  });
});

// ── isFailure filter ──────────────────────────────────────────────────────

describe('isFailure filter', () => {
  it('ignores errors that isFailure returns false for', async () => {
    const b = getBreaker('dep', {
      failureThreshold: 2,
      isFailure: (err) => {
        const msg = (err as Error).message;
        return !msg.startsWith('expected-');
      },
    });

    // These are "expected" and must NOT count toward the threshold
    for (let i = 0; i < 10; i++) {
      await expect(b.execute(async () => { throw new Error('expected-bad-input'); })).rejects.toThrow();
    }
    expect(b.getState()).toBe('closed');

    // These DO count
    for (let i = 0; i < 2; i++) {
      await expect(b.execute(async () => { throw new Error('infra-boom'); })).rejects.toThrow();
    }
    expect(b.getState()).toBe('open');
  });
});

// ── reset ────────────────────────────────────────────────────────────────

describe('reset', () => {
  it('returns an open breaker to closed and clears counters', async () => {
    const b = getBreaker('dep', { failureThreshold: 1 });
    await expect(b.execute(async () => { throw new Error(); })).rejects.toThrow();
    expect(b.getState()).toBe('open');
    b.reset();
    expect(b.getState()).toBe('closed');
    expect(b.getStats().consecutiveFailures).toBe(0);
    expect(b.getStats().openedAt).toBeNull();
  });
});

// ── Isolation between breakers ────────────────────────────────────────────

describe('isolation', () => {
  it('one breaker opening does not affect another', async () => {
    const a = getBreaker('a', { failureThreshold: 1 });
    const b = getBreaker('b', { failureThreshold: 1 });

    await expect(a.execute(async () => { throw new Error(); })).rejects.toThrow();
    expect(a.getState()).toBe('open');
    expect(b.getState()).toBe('closed');

    // b still works
    const v = await b.execute(async () => 'fine');
    expect(v).toBe('fine');
  });
});
