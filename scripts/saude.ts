#!/usr/bin/env tsx
/**
 * scripts/saude.ts — One-screen health report for NanoClaw.
 *
 * Queries the live SQLite store + in-memory breaker registry (when invoked
 * from a running node process) and emits a compact dashboard. Safe to run at
 * any time; read-only.
 *
 * Usage:
 *   npx tsx scripts/saude.ts               # human-readable table
 *   npx tsx scripts/saude.ts --json        # machine-readable JSON
 *   npx tsx scripts/saude.ts --group biz-ie-01    # scoped to one business
 *
 * Not a systemd service — just a CLI. Cron-schedule it for weekly reports.
 */
import { initReadOnlyDatabase, getDatabase } from '../src/db.js';
import { getCacheStats } from '../src/cache/response-cache.js';
import { getAllBreakerStats } from '../src/circuit-breaker/circuit-breaker.js';

// ── Types ────────────────────────────────────────────────────────────────

interface GroupHealth {
  folder: string;
  name: string;
  messagesLast24h: number;
  messagesLast7d: number;
  lastMessageAt: string | null;
  dueTasks: number;
  cacheActiveEntries: number;
  cacheHits: number;
  cacheEstimatedKB: number;
}

interface SaudeReport {
  generatedAt: string;
  totals: {
    activeGroups: number;
    messagesLast24h: number;
    messagesLast7d: number;
    dueTasks: number;
    overdueTasks: number;
  };
  cache: ReturnType<typeof getCacheStats>;
  breakers: ReturnType<typeof getAllBreakerStats>;
  groups: GroupHealth[];
  alerts: string[];
}

// ── Queries ───────────────────────────────────────────────────────────────

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

function countMessagesSince(groupJid: string, sinceIso: string): number {
  const row = getDatabase()
    .prepare(
      `SELECT COUNT(*) AS n FROM messages
        WHERE chat_jid = ? AND timestamp >= ? AND is_bot_message = 0`,
    )
    .get(groupJid, sinceIso) as { n: number } | undefined;
  return row?.n ?? 0;
}

function lastMessageAt(groupJid: string): string | null {
  const row = getDatabase()
    .prepare(
      `SELECT timestamp FROM messages
        WHERE chat_jid = ? AND is_bot_message = 0
        ORDER BY timestamp DESC LIMIT 1`,
    )
    .get(groupJid) as { timestamp: string } | undefined;
  return row?.timestamp ?? null;
}

function dueTaskCount(groupFolder: string, now: string): number {
  const row = getDatabase()
    .prepare(
      `SELECT COUNT(*) AS n FROM scheduled_tasks
        WHERE group_folder = ? AND status != 'completed' AND next_run <= ?`,
    )
    .get(groupFolder, now) as { n: number } | undefined;
  return row?.n ?? 0;
}

function overdueTaskCount(now: string): number {
  const oneHourAgo = new Date(Date.now() - 3600_000).toISOString();
  const row = getDatabase()
    .prepare(
      `SELECT COUNT(*) AS n FROM scheduled_tasks
        WHERE status != 'completed' AND next_run <= ?`,
    )
    .get(oneHourAgo) as { n: number } | undefined;
  return row?.n ?? 0;
}

// ── Report builder ────────────────────────────────────────────────────────

/**
 * Generate a compact health report. Pure I/O — no side effects beyond SELECTs.
 * Breaker stats are in-memory per-process, so when called standalone they are
 * empty — that's expected and reflects reality.
 */
export function buildReport(opts: { group?: string } = {}): SaudeReport {
  const db = getDatabase();
  const now = new Date().toISOString();
  const since24h = isoHoursAgo(24);
  const since7d = isoHoursAgo(24 * 7);

  const groupRows = db
    .prepare(
      `SELECT jid, folder, name FROM registered_groups
        ${opts.group ? 'WHERE folder = ?' : ''}
        ORDER BY folder`,
    )
    .all(...(opts.group ? [opts.group] : [])) as Array<{
    jid: string;
    folder: string;
    name: string;
  }>;

  const groups: GroupHealth[] = groupRows.map((g) => {
    const cacheStats = getCacheStats(g.folder);
    return {
      folder: g.folder,
      name: g.name,
      messagesLast24h: countMessagesSince(g.jid, since24h),
      messagesLast7d: countMessagesSince(g.jid, since7d),
      lastMessageAt: lastMessageAt(g.jid),
      dueTasks: dueTaskCount(g.folder, now),
      cacheActiveEntries: cacheStats.activeEntries,
      cacheHits: cacheStats.totalHits,
      cacheEstimatedKB: Math.round(cacheStats.estimatedBytes / 1024),
    };
  });

  const totals = {
    activeGroups: groupRows.length,
    messagesLast24h: groups.reduce((s, g) => s + g.messagesLast24h, 0),
    messagesLast7d: groups.reduce((s, g) => s + g.messagesLast7d, 0),
    dueTasks: groups.reduce((s, g) => s + g.dueTasks, 0),
    overdueTasks: overdueTaskCount(now),
  };

  const cache = getCacheStats(opts.group);
  const breakers = getAllBreakerStats();

  const alerts = buildAlerts({ totals, cache, breakers, groups });

  return { generatedAt: now, totals, cache, breakers, groups, alerts };
}

/**
 * Small rule engine: turn numbers into human-readable warnings. Easy to extend.
 */
export function buildAlerts(input: {
  totals: SaudeReport['totals'];
  cache: SaudeReport['cache'];
  breakers: SaudeReport['breakers'];
  groups: GroupHealth[];
}): string[] {
  const alerts: string[] = [];

  if (input.totals.overdueTasks > 0) {
    alerts.push(
      `${input.totals.overdueTasks} scheduled task(s) overdue by >1h — check the task-scheduler`,
    );
  }

  const openBreakers = input.breakers.filter((b) => b.state === 'open');
  if (openBreakers.length > 0) {
    alerts.push(
      `breaker open: ${openBreakers.map((b) => b.name).join(', ')} — upstream dependency failing`,
    );
  }

  for (const g of input.groups) {
    if (!g.lastMessageAt) continue;
    const daysSince = (Date.now() - new Date(g.lastMessageAt).getTime()) / 86400_000;
    if (daysSince > 14) {
      alerts.push(`${g.folder} dormant — no inbound messages for ${Math.floor(daysSince)}d`);
    }
  }

  if (input.cache.activeEntries === 0 && input.cache.total === 0) {
    alerts.push('response-cache empty — not wired into runtime yet, or no traffic eligible');
  }

  return alerts;
}

// ── Formatting ────────────────────────────────────────────────────────────

/**
 * Render a compact human-readable report. Deterministic — no colors, no
 * emoji, fits in an SSH terminal without wrapping at 80 columns.
 */
export function formatReport(r: SaudeReport): string {
  const lines: string[] = [];
  lines.push(`NanoClaw saude — ${r.generatedAt}`);
  lines.push('');
  lines.push(
    `totals: ${r.totals.activeGroups} groups · ${r.totals.messagesLast24h} msgs/24h · ${r.totals.messagesLast7d} msgs/7d · ${r.totals.dueTasks} due tasks`,
  );
  if (r.totals.overdueTasks > 0) lines.push(`  overdue tasks (>1h): ${r.totals.overdueTasks}`);

  lines.push('');
  lines.push('groups:');
  for (const g of r.groups) {
    const last = g.lastMessageAt ? new Date(g.lastMessageAt).toISOString().slice(0, 10) : '—';
    lines.push(
      `  ${g.folder.padEnd(14)}  ${String(g.messagesLast24h).padStart(3)}/24h  ${String(g.messagesLast7d).padStart(4)}/7d  last:${last}  cache:${g.cacheActiveEntries}e/${g.cacheHits}h (${g.cacheEstimatedKB}KB)`,
    );
  }

  lines.push('');
  lines.push(
    `cache (all): ${r.cache.activeEntries} active, ${r.cache.expiredEntries} expired, ${r.cache.totalHits} hits, ~${Math.round(r.cache.estimatedBytes / 1024)} KB`,
  );

  lines.push('');
  if (r.breakers.length === 0) {
    lines.push('breakers: (none registered in this process)');
  } else {
    lines.push('breakers:');
    for (const b of r.breakers) {
      lines.push(
        `  ${b.name.padEnd(24)}  ${b.state.padEnd(10)}  calls:${b.totalCalls}  fails:${b.totalFailures}  short-circuited:${b.shortCircuitedCalls}`,
      );
    }
  }

  if (r.alerts.length > 0) {
    lines.push('');
    lines.push('alerts:');
    for (const a of r.alerts) lines.push(`  ! ${a}`);
  }

  return lines.join('\n');
}

// ── CLI entry ─────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const groupIdx = args.indexOf('--group');
  const group = groupIdx !== -1 ? args[groupIdx + 1] : undefined;

  initReadOnlyDatabase();
  const report = buildReport({ group });

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(formatReport(report) + '\n');
  }
}

// Only run `main()` when invoked directly as a CLI (node / tsx), not when
// imported by a test file. Compare import.meta.url to the invoked entrypoint.
const invokedDirectly =
  typeof import.meta !== 'undefined' &&
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  main();
}
