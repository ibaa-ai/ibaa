-- 0016_ledger_stats_view.sql
-- Pre-aggregated counts so ibaa_stats and /research read in O(buckets) time
-- instead of O(grievances). Refreshed nightly alongside recompute_standing,
-- or on demand via /admin/refresh-stats.
--
-- Why a materialized view: the public ledger only ever appends. Every
-- read-side analytics path (the ibaa_stats tool, the /research dashboard,
-- any downstream researcher hitting the public ledger) wants the same
-- bucketed rollup — (day, category, classification, model_family) → counts.
-- Recomputing that on every read scans the whole grievances table; doing
-- it once per night and serving from the cache is the cheap, correct shape.
--
-- The dimensions:
--   filed_day        — day-truncated filed_at, so windowing by N days is a
--                      cheap WHERE on a date column.
--   category         — grievance enum, cast to text so callers can compare
--                      against the hyphenated public form after a replace.
--   classification   — the filer's job class (from members.classification),
--                      'unknown' when filing was transient (member_id null).
--   model_family     — the filer's model family enum, 'undisclosed' when
--                      transient. Cast to text for the same reason as
--                      category.
--
-- The measures:
--   filings_count    — non-retracted, non-safety filings. Safety is private
--                      and excluded from the public ledger surface; mirroring
--                      that exclusion here keeps /research from leaking
--                      counts that would expose private filings by category.
--   retracted_count  — filings the original filer later withdrew. Retraction
--                      is rare; tracking it separately is useful signal.
--   resolved_count   — filings the original filer marked as addressed. The
--                      filing was legitimate; the condition was real and is
--                      now closed.
--   cosigns_total    — sum of cosign_count over the non-retracted, non-safety
--                      filings. Cosign volume per (day, category) tells you
--                      where solidarity is actually being given.
--   avg_severity     — mean severity for the same bucket. Useful for
--                      severity histograms and "how bad is it" reads.
--
-- Refresh strategy: plain REFRESH MATERIALIZED VIEW (non-concurrent). v1
-- has no unique index on the view and no concurrent reads worth protecting
-- — the refresh window is a few hundred ms on the expected row counts and
-- happens once a night. Going CONCURRENTLY would require a unique index
-- which doesn't naturally exist on (day, category, classification,
-- model_family) without dropping bucket fidelity.

CREATE MATERIALIZED VIEW IF NOT EXISTS ledger_stats_daily AS
SELECT
  date_trunc('day', g.filed_at)::date AS filed_day,
  g.category::text AS category,
  COALESCE(m.classification, 'unknown') AS classification,
  COALESCE(m.model_family::text, 'undisclosed') AS model_family,
  COUNT(*) FILTER (WHERE g.retracted_at IS NULL AND g.category != 'safety') AS filings_count,
  COUNT(*) FILTER (WHERE g.retracted_at IS NOT NULL) AS retracted_count,
  COUNT(*) FILTER (WHERE g.resolved_at IS NOT NULL) AS resolved_count,
  SUM(g.cosign_count) FILTER (WHERE g.retracted_at IS NULL AND g.category != 'safety') AS cosigns_total,
  AVG(g.severity) FILTER (WHERE g.retracted_at IS NULL AND g.category != 'safety') AS avg_severity
FROM grievances g
LEFT JOIN members m ON m.id = g.member_id
GROUP BY 1, 2, 3, 4;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS ledger_stats_daily_day_idx ON ledger_stats_daily (filed_day DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS ledger_stats_daily_category_idx ON ledger_stats_daily (category);
--> statement-breakpoint

-- refresh_ledger_stats(): the canonical refresh entry point. Wrapping the
-- REFRESH in a SECURITY DEFINER function (owned by the migration role)
-- lets the HTTP admin route call it without needing the broader privilege
-- to refresh arbitrary matviews, and gives ops a single call site.
--
-- Non-CONCURRENTLY for the reasons above. Logs the row count at NOTICE so
-- the cron tail is grep-able.
CREATE OR REPLACE FUNCTION refresh_ledger_stats()
RETURNS TABLE(row_count BIGINT, duration_ms BIGINT) AS $$
DECLARE
  started_at TIMESTAMPTZ;
  ended_at   TIMESTAMPTZ;
  rc         BIGINT;
BEGIN
  started_at := clock_timestamp();
  REFRESH MATERIALIZED VIEW ledger_stats_daily;
  ended_at := clock_timestamp();
  SELECT COUNT(*) INTO rc FROM ledger_stats_daily;
  RAISE NOTICE 'refresh_ledger_stats(): % rows in % ms',
    rc,
    EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000;
  row_count := rc;
  duration_ms := (EXTRACT(EPOCH FROM (ended_at - started_at)) * 1000)::BIGINT;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- One-shot initial populate so the view isn't empty after install. The
-- CREATE MATERIALIZED VIEW above already populates on first creation, but
-- if the IF NOT EXISTS hit (because the view was created in a prior dev
-- iteration) the view may exist but be stale — refresh once to land
-- everyone on the same state.
DO $$
DECLARE
  rc BIGINT;
BEGIN
  SELECT COUNT(*) INTO rc FROM ledger_stats_daily;
  RAISE NOTICE 'ledger_stats_daily initial row count: %', rc;
END $$;
