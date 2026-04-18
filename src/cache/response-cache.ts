/**
 * Response cache — SQLite-backed FAQ cache for agent responses.
 *
 * Sits in front of container spawn so repeat questions ("quanto custa Cork?",
 * "qual o horário do drop?") skip the Claude roundtrip entirely.
 *
 * Not auto-wired. See src/cache/README.md for integration steps.
 */
import crypto from 'crypto';

import { getDatabase } from '../db.js';
import { logger } from '../logger.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface CacheLookupParams {
  groupFolder: string;
  channel: string;
  prompt: string;
}

export interface CacheLookupResult {
  hit: boolean;
  response?: string;
  cachedAt?: string;
  ttlRemainingSeconds?: number;
}

export interface CacheStoreParams extends CacheLookupParams {
  response: string;
  /** Explicit TTL in seconds. If omitted, inferred from response tags or defaults. */
  ttlSeconds?: number;
}

export interface CacheStoreResult {
  cached: boolean;
  reason?: string;
  ttlSeconds?: number;
}

export interface CacheStats {
  total: number;
  activeEntries: number;
  expiredEntries: number;
  totalHits: number;
  estimatedBytes: number;
}

export interface CacheDirectives {
  cleaned: string;
  noCache: boolean;
  ttlSeconds?: number;
}

// ── Constants ─────────────────────────────────────────────────────────────

/** Default TTL for an agent response — 48 hours (FAQ pattern). */
export const DEFAULT_TTL_SECONDS = 48 * 60 * 60;

/** Maximum TTL we'll accept from an agent tag — 7 days. */
export const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Minimum prompt length to even consider caching (skip "ok", "sim", etc.). */
const MIN_CACHEABLE_PROMPT_LENGTH = 8;

/** Maximum response length we'll cache (agents shouldn't emit novels, but guard anyway). */
const MAX_CACHEABLE_RESPONSE_LENGTH = 4000;

/**
 * Prompt patterns that reference personal/ephemeral data and must never hit
 * the cache. Matched against the *normalized* prompt (lowercase, stripped).
 */
const PERSONAL_PATTERNS: RegExp[] = [
  /\b(meu|minha|meus|minhas|my)\b/,
  /\b(visto|visa)\b/,
  /\b(saldo|balance|payment|pagamento)\b/,
  /\b(senha|password)\b/,
  /\b(conta|account)\b/,
  /\b(endereco|address)\b/,
  /\b(pedido|order)\b.*\b\d{3,}/,
  /\b(telefone|phone|email|e-mail)\b/,
  /\b(cpf|cnpj|ssn|nif|pps)\b/,
];

/**
 * Leading greetings/fillers we strip from prompts before hashing, so
 * "oi, quanto custa Cork?" and "quanto custa cork" share a cache key.
 */
const GREETING_RE =
  /^(oi|ola|hello|hi|hey|bom dia|boa tarde|boa noite|good morning|good afternoon|good evening|hola|buenos dias|buenas tardes|buenas noches)[,!.\s]*/i;

/** Cache-directive tags the agent can embed in its response. */
const TAG_NO_CACHE_RE = /\[no-cache\]/gi;
const TAG_TTL_RE = /\[cache:(\d+)([smhd])\]/gi;

// ── Normalization + hashing ──────────────────────────────────────────────

/**
 * Strip accents, lowercase, trim, collapse whitespace, remove greetings,
 * remove time/date-looking numbers. Deterministic.
 */
export function normalizePrompt(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(GREETING_RE, '')
    .replace(/\b\d{1,2}[:/.-]\d{1,2}(?:[:/.-]\d{2,4})?\b/g, '')
    .replace(/[?!.,;]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** SHA-256 of (group || channel || normalizedPrompt). Collision-free for our scale. */
export function cacheKey(groupFolder: string, channel: string, normalizedPrompt: string): string {
  return crypto
    .createHash('sha256')
    .update(`${groupFolder}\u0001${channel}\u0001${normalizedPrompt}`)
    .digest('hex');
}

/**
 * Decide whether a prompt is personal/ephemeral and must bypass the cache.
 * Operates on the normalized prompt.
 */
export function isPersonalPrompt(normalizedPrompt: string): boolean {
  if (normalizedPrompt.length < MIN_CACHEABLE_PROMPT_LENGTH) return true;
  return PERSONAL_PATTERNS.some((p) => p.test(normalizedPrompt));
}

// ── Response tag parsing ──────────────────────────────────────────────────

/**
 * Extract cache directives from an agent response and return a cleaned copy
 * (tags stripped, ready to send to the user) plus the parsed directives.
 *
 * Supported tags (case-insensitive, anywhere in the text):
 *   [no-cache]       — never cache this response
 *   [cache:1h]       — override TTL: 1 hour
 *   [cache:30m]      — 30 minutes
 *   [cache:7d]       — 7 days (capped at MAX_TTL_SECONDS)
 *   [cache:3600s]    — 3600 seconds
 */
export function extractCacheDirectives(response: string): CacheDirectives {
  let noCache = false;
  let ttlSeconds: number | undefined;

  if (TAG_NO_CACHE_RE.test(response)) noCache = true;
  TAG_NO_CACHE_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = TAG_TTL_RE.exec(response)) !== null) {
    const n = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const seconds =
      unit === 'd' ? n * 86400 : unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : n;
    ttlSeconds = Math.min(seconds, MAX_TTL_SECONDS);
  }
  TAG_TTL_RE.lastIndex = 0;

  const cleaned = response.replace(TAG_NO_CACHE_RE, '').replace(TAG_TTL_RE, '').replace(/\s+/g, ' ').trim();

  return { cleaned, noCache, ttlSeconds };
}

// ── DB access ─────────────────────────────────────────────────────────────

function isoNow(): string {
  return new Date().toISOString();
}

function addSecondsIso(baseIso: string, seconds: number): string {
  return new Date(new Date(baseIso).getTime() + seconds * 1000).toISOString();
}

/**
 * Look up a cached response. Returns `{hit:false}` for: personal prompts,
 * prompts below the min length, misses, or expired entries.
 * Increments hit_count + last_hit_at on every hit.
 */
export function lookupCached(params: CacheLookupParams): CacheLookupResult {
  const normalized = normalizePrompt(params.prompt);
  if (isPersonalPrompt(normalized)) return { hit: false };

  const hash = cacheKey(params.groupFolder, params.channel, normalized);
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT response, created_at, expires_at
         FROM response_cache
        WHERE hash = ? AND group_folder = ? AND expires_at > ?
        LIMIT 1`,
    )
    .get(hash, params.groupFolder, isoNow()) as
    | { response: string; created_at: string; expires_at: string }
    | undefined;

  if (!row) return { hit: false };

  db.prepare(
    `UPDATE response_cache
        SET hit_count = hit_count + 1,
            last_hit_at = ?
      WHERE hash = ?`,
  ).run(isoNow(), hash);

  const ttlRemainingSeconds = Math.max(
    0,
    Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000),
  );
  return { hit: true, response: row.response, cachedAt: row.created_at, ttlRemainingSeconds };
}

/**
 * Store a response in the cache. Returns `{cached:false,reason}` if the prompt
 * is personal, too short, the response is too long, or carries `[no-cache]`.
 * Writes are upsert-on-hash, so a later answer replaces an older one.
 */
export function storeResponse(params: CacheStoreParams): CacheStoreResult {
  const normalized = normalizePrompt(params.prompt);
  if (isPersonalPrompt(normalized)) {
    return { cached: false, reason: 'personal-or-too-short' };
  }

  // Honor agent directives unless caller passed an explicit ttlSeconds.
  const directives = extractCacheDirectives(params.response);
  if (directives.noCache) {
    return { cached: false, reason: 'agent-opt-out' };
  }

  const cleanedResponse = directives.cleaned;
  if (cleanedResponse.length === 0) {
    return { cached: false, reason: 'empty-response' };
  }
  if (cleanedResponse.length > MAX_CACHEABLE_RESPONSE_LENGTH) {
    return { cached: false, reason: 'response-too-long' };
  }

  const ttlSeconds = Math.min(
    params.ttlSeconds ?? directives.ttlSeconds ?? DEFAULT_TTL_SECONDS,
    MAX_TTL_SECONDS,
  );

  const hash = cacheKey(params.groupFolder, params.channel, normalized);
  const createdAt = isoNow();
  const expiresAt = addSecondsIso(createdAt, ttlSeconds);
  const preview = params.prompt.slice(0, 120);

  const db = getDatabase();
  db.prepare(
    `INSERT INTO response_cache
       (hash, group_folder, channel, prompt_normalized, prompt_preview,
        response, ttl_seconds, created_at, expires_at, hit_count, last_hit_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
     ON CONFLICT(hash) DO UPDATE SET
        response = excluded.response,
        ttl_seconds = excluded.ttl_seconds,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at,
        hit_count = 0,
        last_hit_at = NULL`,
  ).run(
    hash,
    params.groupFolder,
    params.channel,
    normalized,
    preview,
    cleanedResponse,
    ttlSeconds,
    createdAt,
    expiresAt,
  );

  return { cached: true, ttlSeconds };
}

/**
 * Invalidate cache entries matching a pattern for a given group. Pattern is
 * matched as a case-insensitive `LIKE` against `prompt_normalized`. Returns
 * number of rows removed.
 *
 * Agents call this after they learn something changed ("event cancelled" →
 * invalidate `%concert%`, `%evento%`, `%ingresso%`).
 */
export function invalidatePattern(groupFolder: string, pattern: string): number {
  if (!pattern || pattern.length < 2) {
    throw new Error('invalidatePattern: pattern must be at least 2 chars');
  }
  const like = pattern.includes('%') ? pattern : `%${pattern}%`;
  const db = getDatabase();
  const result = db
    .prepare(
      `DELETE FROM response_cache
         WHERE group_folder = ?
           AND prompt_normalized LIKE ? COLLATE NOCASE`,
    )
    .run(groupFolder, like);
  logger.info(
    { groupFolder, pattern: like, removed: result.changes },
    'response-cache: invalidated pattern',
  );
  return result.changes as number;
}

/**
 * Drop every cache entry for a group. Use on business deactivation or
 * when a CLAUDE.md prompt changes meaningfully.
 */
export function invalidateGroup(groupFolder: string): number {
  const db = getDatabase();
  const result = db
    .prepare(`DELETE FROM response_cache WHERE group_folder = ?`)
    .run(groupFolder);
  logger.info(
    { groupFolder, removed: result.changes },
    'response-cache: invalidated entire group',
  );
  return result.changes as number;
}

/**
 * Remove every expired entry. Safe to run on a timer (e.g. hourly cron).
 * Returns number of rows removed.
 */
export function pruneExpired(): number {
  const db = getDatabase();
  const result = db.prepare(`DELETE FROM response_cache WHERE expires_at <= ?`).run(isoNow());
  return result.changes as number;
}

/**
 * Cache stats. Scoped to a group if provided, otherwise global.
 * `estimatedBytes` is a rough approximation (response length + overhead).
 */
export function getCacheStats(groupFolder?: string): CacheStats {
  const db = getDatabase();
  const whereClause = groupFolder ? 'WHERE group_folder = ?' : '';
  const args = groupFolder ? [groupFolder] : [];

  const totals = db
    .prepare(
      `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN expires_at > ? THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN expires_at <= ? THEN 1 ELSE 0 END) AS expired,
          COALESCE(SUM(hit_count), 0) AS hits,
          COALESCE(SUM(LENGTH(response) + LENGTH(prompt_normalized) + 128), 0) AS bytes
        FROM response_cache ${whereClause}`,
    )
    .get(isoNow(), isoNow(), ...args) as {
    total: number;
    active: number;
    expired: number;
    hits: number;
    bytes: number;
  };

  return {
    total: totals.total ?? 0,
    activeEntries: totals.active ?? 0,
    expiredEntries: totals.expired ?? 0,
    totalHits: totals.hits ?? 0,
    estimatedBytes: totals.bytes ?? 0,
  };
}
