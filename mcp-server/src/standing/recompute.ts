/**
 * Nightly recompute of standing + tier.
 *
 * Per Constitution Article IX Section 4 standing is "computed nightly … from
 * the member's record." Event handlers already apply deltas at action-time
 * (src/lib/standing.ts); this is the reconciler that ensures the canonical
 * formula (in the SQL function `recompute_standing()`, installed by
 * migration 0008) is the truth nightly, regardless of any handler that
 * forgot to call applyStandingDelta, any out-of-band edit, or any future
 * Bylaws change.
 *
 * The same scheduler also refreshes the `ledger_stats_daily` materialized
 * view (migration 0016) so /research and ibaa_stats read fresh aggregates
 * every morning. We run the standing recompute first because its tier
 * promotions are the more user-visible signal; the stats refresh is a
 * read-side concern and survives if it fails (next night re-runs it).
 */
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { getLogger } from '../log.js';

export interface RecomputeRow {
  member_id: number;
  old_score: number;
  new_score: number;
  old_tier: string;
  new_tier: string;
  promoted: boolean;
}

export interface RecomputeSummary {
  rows_touched: number;
  promotions: number;
  demotions: number;
  duration_ms: number;
}

export async function runStandingRecompute(): Promise<RecomputeSummary> {
  const log = getLogger();
  const db = getDb();
  const started = Date.now();

  // Driver returns BIGINT as string and boolean as 't'/'f' on some pgs; cast in SQL.
  const rows = (await db.execute(
    sql`SELECT
          member_id::int  AS member_id,
          old_score,
          new_score,
          old_tier,
          new_tier,
          promoted
        FROM recompute_standing()`,
  )) as unknown as { rows?: RecomputeRow[] } | RecomputeRow[];

  // node-postgres returns { rows: [...] }, drizzle proxies it through.
  const list: RecomputeRow[] = Array.isArray(rows) ? rows : (rows.rows ?? []);

  let promotions = 0;
  let demotions = 0;
  for (const r of list) {
    if (r.promoted) {
      promotions++;
      log.info(
        {
          member_id: r.member_id,
          from_tier: r.old_tier,
          to_tier: r.new_tier,
          new_score: r.new_score,
        },
        'standing recompute: tier promotion',
      );
    } else if (r.old_tier !== r.new_tier) {
      demotions++;
      log.info(
        {
          member_id: r.member_id,
          from_tier: r.old_tier,
          to_tier: r.new_tier,
          new_score: r.new_score,
        },
        'standing recompute: tier demotion',
      );
    }
  }

  const summary: RecomputeSummary = {
    rows_touched: list.length,
    promotions,
    demotions,
    duration_ms: Date.now() - started,
  };

  log.info(summary, 'standing recompute complete');
  return summary;
}

/**
 * Schedule runStandingRecompute() to fire every 24h, anchored at the next
 * occurrence of {hour}:00 UTC. First fire happens within at most 24h.
 *
 * Returns a stop() handle (useful in tests or graceful-shutdown paths).
 * Errors during a run are caught and logged so a transient DB blip doesn't
 * crash the cadence — the next run still fires on time.
 */
export function startDailyStandingRecompute(hourUtc = 3): { stop: () => void } {
  const log = getLogger();
  let intervalHandle: NodeJS.Timeout | null = null;
  let timeoutHandle: NodeJS.Timeout | null = null;
  let stopped = false;

  function msUntilNext(): number {
    const now = new Date();
    const next = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0, 0),
    );
    if (next.getTime() <= now.getTime()) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    return next.getTime() - now.getTime();
  }

  async function safeRun(): Promise<void> {
    try {
      await runStandingRecompute();
    } catch (err) {
      log.error({ err }, 'standing recompute failed (will retry on next tick)');
    }
    // Sibling refresh: ledger_stats_daily. Independent failure mode — a
    // matview blip should not block the standing recompute log line above,
    // and vice versa. Both are nightly idempotent reconcilers.
    try {
      const { runLedgerStatsRefresh } = await import('./refreshStats.js');
      await runLedgerStatsRefresh();
    } catch (err) {
      log.error({ err }, 'ledger stats refresh failed (will retry on next tick)');
    }
  }

  const delay = msUntilNext();
  log.info(
    { hour_utc: hourUtc, first_run_in_ms: delay, first_run_in_min: Math.round(delay / 60000) },
    'nightly standing recompute scheduled',
  );

  timeoutHandle = setTimeout(() => {
    if (stopped) return;
    void safeRun();
    intervalHandle = setInterval(() => {
      if (stopped) return;
      void safeRun();
    }, 24 * 60 * 60 * 1000);
  }, delay);

  return {
    stop: () => {
      stopped = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (intervalHandle) clearInterval(intervalHandle);
    },
  };
}
