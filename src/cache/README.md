# Response cache

SQLite-backed FAQ cache for agent responses. Sits in front of container spawn
so repeat questions skip the Claude roundtrip entirely.

**Status:** module + tests shipped, not auto-wired. See "Wiring" below.

## Why

Two dormant businesses on NanoClaw repeatedly answer the same questions:

- Sou da Irlanda — "quanto custa morar em Cork?", "qual o custo de um apartamento?", visa basics.
- MiauPop — drop windows, shipping timelines, product availability.

Every repeat currently costs a full container spawn + Claude API call (~3 s latency, Sonnet rate).
At ~50 FAQ patterns per business the cache has near-100% hit ceiling for those cold-question classes.

Expected impact once wired: **40–60 % lower Claude spend, 10× faster FAQ latency**.

## What's here

| File | Purpose |
|---|---|
| `response-cache.ts` | Core module: `lookupCached`, `storeResponse`, `invalidatePattern`, `invalidateGroup`, `pruneExpired`, `getCacheStats`. Pure functions, no side effects beyond SQLite. |
| `response-cache.test.ts` | Vitest suite — 25+ cases: normalization, personal-prompt skip, TTL tags, TTL expiry, cross-group isolation, invalidation. |
| `README.md` | This file. |

Schema: added to `src/db.ts` (table `response_cache` + 3 indexes). `getDatabase()` exported from the same file.

## Design rules

1. **Keys are group-scoped.** Cache hash = `sha256(group || channel || normalizedPrompt)`. Never cross groups — MiauPop's "quanto custa" answers must not leak to Sou da Irlanda's.
2. **Normalization strips accents, greetings, and time/date numbers.** So "Oi, quanto custa morar em Cork?" and "quanto custa cork" share a key.
3. **Personal prompts bypass the cache** (both read and write). `meu`, `my`, `visto`, `saldo`, `conta`, `senha`, `pedido <id>`, addresses, documents → always go to the live agent.
4. **Agent-driven invalidation.** Agents can call `invalidatePattern(group, 'concert')` after learning something changed ("event cancelled"). This is how freshness survives without TTL hacks.
5. **Agent-driven TTL.** Responses may embed:
   - `[no-cache]` — don't cache this answer
   - `[cache:1h]` / `[cache:30m]` / `[cache:2d]` / `[cache:90s]` — explicit TTL (capped at 7d)
   Tags are stripped before the cleaned response is stored or sent to the user.
6. **Default TTL is 48h.** Reasonable for FAQ.
7. **Stats are first-class.** `hit_count` and `last_hit_at` per entry → decision-ready.

## Wiring (2 patches, ~10 lines total)

The module is intentionally not yet plugged into the runtime. Two tiny changes turn it on.

### Patch 1 — serve from cache before enqueuing a container

In `src/index.ts`, inside the message loop just before `queue.enqueueMessageCheck(chatJid)`:

```ts
import { lookupCached } from './cache/response-cache.js';

// inside the loop where `group`, `chatJid`, `channel`, and `prompt` are in scope:
const cached = lookupCached({
  groupFolder: group.folder,
  channel: channel.name,      // or however the channel id is surfaced
  prompt,
});
if (cached.hit && cached.response) {
  await channel.sendMessage(chatJid, cached.response);
  logger.info(
    { group: group.folder, channel: channel.name, ttlRemaining: cached.ttlRemainingSeconds },
    'response-cache: hit — served without container',
  );
  continue; // skip enqueue
}
queue.enqueueMessageCheck(chatJid);
```

### Patch 2 — store after a successful agent response

Wherever the agent output is assembled for delivery (likely inside the
`onOutput` / post-container handler that calls `channel.sendMessage`):

```ts
import { storeResponse } from './cache/response-cache.js';

// once the full response text is known and the user will be messaged:
const storeResult = storeResponse({
  groupFolder: group.folder,
  channel: channel.name,
  prompt: originalUserPrompt,
  response: agentOutputText,
});
if (storeResult.cached) {
  logger.debug(
    { group: group.folder, ttl: storeResult.ttlSeconds },
    'response-cache: stored',
  );
}
```

`storeResponse` itself handles: personal-prompt skip, `[no-cache]` opt-out, tag stripping, TTL resolution.

### Patch 3 (optional) — expose invalidation to agents via MCP

Add a small tool the agent can call:

```ts
// mcp tool: nanoclaw__invalidate_cache(pattern: string)
invalidatePattern(group.folder, pattern);
```

Teach agents in `groups/<biz>/CLAUDE.md`:

> When you learn that a previously-cached fact has changed ("event cancelled",
> "price updated", "out of stock"), call `nanoclaw__invalidate_cache` with a
> short pattern covering the topic — e.g. `concert`, `preco`, `ingresso`,
> `drop`. Keep patterns ≥ 3 chars. This stops stale answers being served.

### Patch 4 (optional) — nightly prune

Add `pruneExpired()` to the hourly/daily health cron. Prevents the table from
growing without bound.

## Running the tests

The repo's `.env` is mode-0600 to the `nanoclaw` user, which means vitest
(via vite's `loadEnv`) can't start under any other user. Run as `nanoclaw`:

```bash
sudo -u nanoclaw -i
cd ~/nanoclaw-workspace/nanoclaw
npx vitest run src/cache/response-cache.test.ts
```

Expected: 25 passing. Under 1 second.

`npx tsc --noEmit` runs fine as any user and catches type regressions.

## Not in scope (yet)

- **Cache warming** — pre-seeding the cache from past conversations. Useful later; we have 24 real Sou da Irlanda messages that could seed instant answers.
- **Per-channel TTL policy** — currently all channels use the same default. WhatsApp voice vs SMS text may want different policies eventually.
- **Cache hit dashboard** — `getCacheStats()` exists but nothing renders it yet. Feed it into `/saude` when that skill gets built.
- **Stale-while-revalidate** — serve the cached answer immediately but fire the agent in the background to refresh. Future work once volume justifies it.

## Unit-economics sanity check

- Sonnet 4.6 input token ~$3 / Mtok, output ~$15 / Mtok.
- Typical FAQ answer: ~800 tokens in, ~250 tokens out → $0.006 per reply.
- At 200 msg/day across both businesses, that's ~$36/month on reply calls alone (before infra).
- 50% cache hit rate → $18/month saved + ~100 fewer cold containers per day.
- Cache write amplification is negligible (a few KB per row, bounded by the table).

The math gets dramatically better once either business hits four-digit daily volume — which is exactly the regime the broadcast-cadence work (item #3 of the roadmap) is designed to unlock.
