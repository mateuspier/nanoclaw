/**
 * Circuit breaker — per-dependency failure isolation.
 *
 * Wraps an async call to an external dependency (Twilio, Claude API, Gemini,
 * outbound HTTP) and trips open when failures exceed a threshold. Open breakers
 * fail fast without hitting the dependency, protecting the rest of the agent
 * runtime from cascading slowdowns.
 *
 * In-memory only by design. State does not persist across restarts — on boot,
 * every breaker starts CLOSED. For our scale (single-node, restart-tolerant
 * systemd service) that's simpler and sufficient.
 *
 * Not auto-wired. See src/circuit-breaker/README.md for adoption pattern.
 */
import { logger } from '../logger.js';

// ── Types ────────────────────────────────────────────────────────────────

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  /** Unique name, used for logs and the registry. */
  name: string;
  /** Consecutive failures before opening. Default 5. */
  failureThreshold?: number;
  /** How long to stay open before allowing a probe call. Default 30 s. */
  cooldownMs?: number;
  /**
   * If a half-open probe hasn't returned in this many ms, treat as failure and
   * reopen. Default 10 s. (This is a budget on the probe itself; it does NOT
   * bound the wrapped function's timeout — that's the caller's job.)
   */
  halfOpenTimeoutMs?: number;
  /**
   * Which errors count as failures. Default: any throw counts. Provide to
   * ignore "expected" errors (e.g. 4xx from Twilio, which aren't infra
   * failures and shouldn't trip the breaker).
   */
  isFailure?: (err: unknown) => boolean;
}

export interface CircuitBreakerStats {
  name: string;
  state: BreakerState;
  consecutiveFailures: number;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  openedAt: string | null;
  /** Total calls since process start. */
  totalCalls: number;
  totalFailures: number;
  /** Calls short-circuited (returned CircuitOpenError without invoking fn). */
  shortCircuitedCalls: number;
}

export class CircuitOpenError extends Error {
  public readonly code = 'CIRCUIT_OPEN';
  constructor(
    public readonly breakerName: string,
    public readonly retryAfterMs: number,
  ) {
    super(
      `Circuit "${breakerName}" is open. Retry after ${Math.ceil(retryAfterMs / 1000)}s.`,
    );
    this.name = 'CircuitOpenError';
  }
}

// ── Defaults ──────────────────────────────────────────────────────────────

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_HALF_OPEN_TIMEOUT_MS = 10_000;

// ── Implementation ────────────────────────────────────────────────────────

class CircuitBreakerImpl {
  readonly name: string;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly halfOpenTimeoutMs: number;
  private readonly isFailure: (err: unknown) => boolean;

  private state: BreakerState = 'closed';
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private lastFailureAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private totalCalls = 0;
  private totalFailures = 0;
  private shortCircuitedCalls = 0;
  /** Serializes half-open probes — only one in-flight at a time. */
  private probeInFlight: Promise<unknown> | null = null;

  constructor(config: CircuitBreakerConfig) {
    this.name = config.name;
    this.failureThreshold = config.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.halfOpenTimeoutMs = config.halfOpenTimeoutMs ?? DEFAULT_HALF_OPEN_TIMEOUT_MS;
    this.isFailure = config.isFailure ?? (() => true);
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.totalCalls += 1;

    // Transition open → half-open if cooldown has elapsed.
    if (this.state === 'open' && this.openedAt !== null) {
      if (Date.now() - this.openedAt >= this.cooldownMs) {
        this.transitionTo('half-open');
      }
    }

    if (this.state === 'open') {
      this.shortCircuitedCalls += 1;
      const retryAfterMs = Math.max(
        0,
        this.cooldownMs - (Date.now() - (this.openedAt ?? Date.now())),
      );
      throw new CircuitOpenError(this.name, retryAfterMs);
    }

    if (this.state === 'half-open') {
      // Only one probe at a time.
      if (this.probeInFlight) {
        this.shortCircuitedCalls += 1;
        throw new CircuitOpenError(this.name, this.halfOpenTimeoutMs);
      }
      const probe = this.runProbe(fn);
      this.probeInFlight = probe;
      try {
        return (await probe) as T;
      } finally {
        this.probeInFlight = null;
      }
    }

    // state === 'closed'
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure(err);
      throw err;
    }
  }

  private async runProbe<T>(fn: () => Promise<T>): Promise<T> {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`probe-timeout:${this.halfOpenTimeoutMs}ms`));
      }, this.halfOpenTimeoutMs);
    });

    try {
      const result = await Promise.race([fn(), timeoutPromise]);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.onSuccess();
      return result;
    } catch (err) {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.onFailure(err);
      throw err;
    }
  }

  private onSuccess(): void {
    this.lastSuccessAt = Date.now();
    this.consecutiveFailures = 0;
    if (this.state !== 'closed') {
      this.transitionTo('closed');
    }
  }

  private onFailure(err: unknown): void {
    this.lastFailureAt = Date.now();
    if (!this.isFailure(err)) {
      return; // expected error; don't count toward threshold
    }
    this.totalFailures += 1;
    this.consecutiveFailures += 1;

    if (this.state === 'half-open') {
      this.transitionTo('open');
      return;
    }

    if (this.state === 'closed' && this.consecutiveFailures >= this.failureThreshold) {
      this.transitionTo('open');
    }
  }

  private transitionTo(next: BreakerState): void {
    const prev = this.state;
    if (prev === next) return;

    this.state = next;
    if (next === 'open') {
      this.openedAt = Date.now();
    }
    if (next === 'closed') {
      this.consecutiveFailures = 0;
      this.openedAt = null;
    }
    logger.warn(
      { breaker: this.name, from: prev, to: next, consecutiveFailures: this.consecutiveFailures },
      'circuit-breaker: state change',
    );
  }

  getState(): BreakerState {
    return this.state;
  }

  /**
   * True when the breaker is `open` and the cooldown has elapsed — meaning the
   * next `execute()` call will flip to `half-open` and run a probe. Surface
   * this from dashboards that want to show "about to retry" rather than a
   * raw "open".
   */
  isEligibleForProbe(): boolean {
    return (
      this.state === 'open' &&
      this.openedAt !== null &&
      Date.now() - this.openedAt >= this.cooldownMs
    );
  }

  getStats(): CircuitBreakerStats {
    return {
      name: this.name,
      state: this.getState(),
      consecutiveFailures: this.consecutiveFailures,
      lastFailureAt: this.lastFailureAt ? new Date(this.lastFailureAt).toISOString() : null,
      lastSuccessAt: this.lastSuccessAt ? new Date(this.lastSuccessAt).toISOString() : null,
      openedAt: this.openedAt ? new Date(this.openedAt).toISOString() : null,
      totalCalls: this.totalCalls,
      totalFailures: this.totalFailures,
      shortCircuitedCalls: this.shortCircuitedCalls,
    };
  }

  /** Force state — only for tests + ops tooling. Not for production flow. */
  _forceState(state: BreakerState): void {
    this.transitionTo(state);
  }

  /** Reset to a fresh CLOSED state. Use after a known-good recovery. */
  reset(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.probeInFlight = null;
    if (this.state !== 'closed') {
      this.transitionTo('closed');
    }
  }
}

export type CircuitBreaker = Pick<
  CircuitBreakerImpl,
  'name' | 'execute' | 'getState' | 'getStats' | 'reset' | 'isEligibleForProbe'
>;

// ── Registry ──────────────────────────────────────────────────────────────

const registry = new Map<string, CircuitBreakerImpl>();

/**
 * Return a named breaker. Creating a new breaker with a name that already
 * exists returns the existing instance — config is fixed at first creation.
 *
 * This is how callers should acquire breakers: `getBreaker('twilio.sms', {...})`.
 * Call once per name at module-init time, or whenever convenient — retrieval is
 * O(1) after that.
 */
export function getBreaker(
  name: string,
  config?: Omit<CircuitBreakerConfig, 'name'>,
): CircuitBreaker {
  const existing = registry.get(name);
  if (existing) return existing;
  const impl = new CircuitBreakerImpl({ name, ...(config ?? {}) });
  registry.set(name, impl);
  return impl;
}

/** All breakers, for dashboard / health surfaces. */
export function getAllBreakerStats(): CircuitBreakerStats[] {
  return Array.from(registry.values()).map((b) => b.getStats());
}

/** Reset every breaker. Tests only. */
export function _resetRegistry(): void {
  registry.clear();
}
