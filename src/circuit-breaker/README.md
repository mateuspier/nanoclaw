# Circuit breaker

Per-dependency failure isolation. Wraps outbound calls so one flaky external
service (Twilio, Claude, Gemini, Fal.ai, webhook) doesn't cascade into agent
timeouts across every group.

**Status:** module + tests shipped, not auto-wired. See "Adoption" below.

## Why

Current behavior when Twilio's SMS API has a bad minute:

1. Message arrives → agent runs → response drafted.
2. `channel.sendMessage()` hits Twilio, hangs for 30 s, times out.
3. Next message arrives → same dance, same 30 s.
4. Queue fills up. Every group stalls behind the one bad dependency.

With a breaker around Twilio:

1. Five consecutive failures → breaker opens.
2. For the next 30 s, `sendMessage` fails fast with `CircuitOpenError`.
3. The channel can retry later, queue a DLQ, or fall back to another channel.
4. Agent runtime stays responsive for every other group.

Same logic for Claude (drafts fail fast → we retry on next message), Gemini,
Fal.ai, or any outbound webhook.

## What's here

| File | Purpose |
|---|---|
| `circuit-breaker.ts` | In-memory breaker + registry. `getBreaker(name, config)`, `CircuitOpenError`, `getAllBreakerStats()`. |
| `circuit-breaker.test.ts` | 20+ vitest cases: state transitions, serialized probes, timeout handling, `isFailure` filter, cross-breaker isolation. |
| `README.md` | This file. |

## State machine

```
    ┌─────────────┐   N failures  ┌──────┐   cooldown elapsed   ┌───────────┐
    │   closed    │ ────────────► │ open │ ──────────────────► │ half-open │
    │  (normal)   │               │(fail │                     │  (probe)  │
    └─────────────┘ ◄──── success │ fast)│ ◄──── probe failed  └──────┬────┘
           ▲                      └──────┘                             │
           │                                                           │
           └───────────────── probe succeeded ─────────────────────────┘
```

- **closed**: calls pass through. Failures increment `consecutiveFailures`. Success zeros it.
- **open**: calls return `CircuitOpenError` without invoking the wrapped fn.
  After `cooldownMs`, next call triggers a probe.
- **half-open**: exactly one probe in flight at a time. Success → closed. Failure or timeout → open again.

## Adoption

### Example: wrap Twilio SMS sends

```ts
// src/channels/twilio.ts
import { getBreaker, CircuitOpenError } from '../circuit-breaker/circuit-breaker.js';

const twilioBreaker = getBreaker('twilio.sms', {
  failureThreshold: 5,
  cooldownMs: 30_000,
  // 4xx from Twilio (bad phone, opt-out) is the *caller's* problem, not infra.
  // Don't trip the breaker on those.
  isFailure: (err) => {
    const status = (err as { status?: number }).status;
    return status === undefined || status >= 500 || status === 429;
  },
});

async function sendViaTwilio(to: string, body: string) {
  return twilioBreaker.execute(async () => {
    return await twilioClient.messages.create({ to, body, from: TWILIO_NUMBER });
  });
}

// Caller:
try {
  await sendViaTwilio(to, body);
} catch (err) {
  if (err instanceof CircuitOpenError) {
    logger.warn({ retryAfterMs: err.retryAfterMs }, 'twilio breaker open — deferring');
    // enqueue for retry, or fall back to WhatsApp
  } else {
    throw err;
  }
}
```

### Example: wrap Claude API calls

```ts
// before the container spawn / inside container-runner.ts
const claudeBreaker = getBreaker('claude.api', {
  failureThreshold: 3,
  cooldownMs: 60_000,
});
const output = await claudeBreaker.execute(() => runContainerAgent(...));
```

### Suggested named breakers

- `twilio.sms` — Twilio SMS `messages.create`
- `twilio.whatsapp` — Twilio WhatsApp (same API, different product)
- `claude.api` — Claude Messages API (container agent)
- `gemini.api` — Gemini content API (if used)
- `fal.ai` — Fal.ai image generation
- `http.outbound.<host>` — for generic webhooks / fetches

One breaker per dependency. Don't share across dependencies or you mask issues.

## Config reference

| Option | Default | Meaning |
|---|---|---|
| `failureThreshold` | 5 | Consecutive failures that trip the breaker to `open`. |
| `cooldownMs` | 30 000 | Time in `open` before a probe is allowed. |
| `halfOpenTimeoutMs` | 10 000 | If the probe hasn't resolved in this many ms, treat as failure. Also used as retry-after for calls that queue behind an in-flight probe. |
| `isFailure` | `() => true` | Return `false` for errors that *should not* count toward the threshold (bad input, 4xx, domain errors). |

## Operations

- `getAllBreakerStats()` → array of `{ name, state, consecutiveFailures, totalCalls, totalFailures, shortCircuitedCalls, ... }`. Feed this into `/saude` once that skill is built.
- `breaker.reset()` → force-return to closed. Use after manual verification the dependency is healthy (e.g. a config flip).
- State **does not persist** across process restarts. On `systemctl restart nanoclaw`, every breaker starts `closed`. This is intentional — restart is our healing primitive, and we don't want a pre-restart open state to silently block the first post-restart call.

## Running the tests

```bash
sudo -u nanoclaw -i
cd ~/nanoclaw-workspace/nanoclaw
npx vitest run src/circuit-breaker/circuit-breaker.test.ts
```

Or from any user via the scratch env-override config pattern (see cache module).

Expected: 20+ passing. Under 1 second (fake timers used for cooldown / timeout paths).

## Not in scope (yet)

- **Jittered cooldown** — fixed cooldown works for our traffic; add jitter if multiple nodes ever share a backend.
- **Exponential backoff on repeated opens** — when a dependency flaps (close → open → close → open), we re-open immediately at the same cooldown. A step-up could be added.
- **Observability export** — `prom-client` metrics or OpenTelemetry spans. Plumb when a metrics backend exists.
