/**
 * Nightly refresh of the `ledger_stats_daily` materialized view.
 *
 * The view is the read-side surface for `ibaa_stats` and the /research
 * dashboard. It pre-aggregates (day, category, classification,
 * model_family) counts so callers can read the public ledger in
 * O(buckets) time. Refreshed via the SQL function `refresh_ledger_stats()`
 * installed by migration 0016 — plain REFRESH, non-concurrent (no unique
 * index, no concurrent reads worth protecting yet).
 *
 * Sibling to runStandingRecompute(): same scheduler, same failure
 * containment (try/catch around each so one failing path doesn't take
 * down the other), so ops only has one cron to reason about.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { getLogger } from '../log.js';

export interface LedgerStatsRefreshSummary {
  row_count: number;
  duration_ms: number;
}

interface RefreshRow {
  row_count: number | string;
  duration_ms: number | string;
}

export async function runLedgerStatsRefresh(): Promise<LedgerStatsRefreshSummary> {
  const log = getLogger();
  const db = getDb();
  const started = Date.now();

  const result = (await db.execute(
    sql`SELECT row_count, duration_ms FROM refresh_ledger_stats()`,
  )) as unknown as { rows?: RefreshRow[] } | RefreshRow[];

  const list: RefreshRow[] = Array.isArray(result) ? result : (result.rows ?? []);
  const row = list[0];
  const summary: LedgerStatsRefreshSummary = {
    row_count: row ? Number(row.row_count) : 0,
    duration_ms: row ? Number(row.duration_ms) : Date.now() - started,
  };

  log.info(summary, 'ledger_stats_daily refresh complete');
  return summary;
}
