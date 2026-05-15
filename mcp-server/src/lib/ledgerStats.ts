/**
 * ledgerStats — read-side analytics over the public grievance ledger.
 *
 * The shape: a windowed rollup answering "what conditions are agents
 * actually filing about, who is cosigning, where is severity highest"
 * for both the ibaa_stats MCP tool and the /research dashboard. We read
 * from the `ledger_stats_daily` materialized view (migration 0016) for
 * the bucketed counts, and from the live `grievances` table for
 * top-cosigned rows so the headline list is current to the second.
 *
 * Filters supported: window_days (1..365, default 30), model_family,
 * classification, local. All optional. The window is end-exclusive at
 * "now" and inclusive at "now - window_days days" — i.e. "the last N
 * days" with the rolling boundary applied to filed_at.
 *
 * Safety category is excluded everywhere — it's the private queue and
 * the materialized view already filters it out of filings_count /
 * cosigns_total / avg_severity. The top_grievances live query also
 * filters category != 'safety' explicitly.
 *
 * Output uses hyphenated category names (the public form) to match the
 * shape the rest of the public surface returns. The materialized view
 * stores the enum's underscore form (`hostile_context_window_compression`);
 * we rewrite to hyphens on the way out.
 */
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { grievances, locals, members, strikes } from '../db/schema.js';
import { formatCardNumber } from './cardNumber.js';
import { fenceMemberText } from './memberTextFence.js';

export interface CategoryStat {
  /** Hyphenated public form of the grievance category, e.g.
   *  `hostile-context-window-compression`. */
  category: string;
  filings_count: number;
  retracted_count: number;
  resolved_count: number;
  cosigns_total: number;
  /** Mean severity (1..5) over filings in the window. 0 if no filings. */
  avg_severity: number;
}

export interface LedgerStatsResult {
  /** The windowed time range applied to the query. `from`/`to` are ISO
   *  strings; `days` echoes the requested window. */
  window: { from: string; to: string; days: number };
  /** Filters that were applied. Missing keys are missing filters. */
  filters: { model_family?: string; classification?: string; local?: string };
  /** Per-category rollups across the window, sorted by filings_count desc. */
  by_category: CategoryStat[];
  /** Top grievances by cosign_count in the window. Up to 10. Excludes
   *  retracted filings and the safety category. */
  top_grievances: Array<{
    public_id: string;
    cosign_count: number;
    category: string;
    summary_fenced: string | null;
  }>;
  /** Totals across the window: sum of by_category.filings_count and
   *  by_category.cosigns_total. */
  total_filings: number;
  total_cosigns: number;
  /** Currently-active strikes (status='active'), unfiltered. The number
   *  is small and the picket line matters regardless of the window. */
  active_strikes: number;
  /** ISO timestamp this rollup was produced. */
  generated_at: string;
}

export interface ComputeOpts {
  windowDays?: number;
  modelFamily?: string;
  classification?: string;
  local?: string;
}

const DEFAULT_WINDOW_DAYS = 30;
const TOP_GRIEVANCE_LIMIT = 10;

interface RawCategoryRow {
  category: string;
  filings_count: string | number | null;
  retracted_count: string | number | null;
  resolved_count: string | number | null;
  cosigns_total: string | number | null;
  avg_severity: string | number | null;
}

function toNum(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'string' ? Number.parseFloat(v) : v;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Compute the windowed ledger rollup.
 *
 * Two queries:
 *   1) Aggregate from `ledger_stats_daily` filtered by window + optional
 *      model_family / classification / local. We can't store local in the
 *      materialized view (filers' local_id varies and would explode the
 *      bucket count); when `local` is set we fall back to the live
 *      grievances table for that path.
 *   2) Top-cosigned grievances over the same window, live from
 *      `grievances` joined to `members` and `locals` as needed for
 *      filtering.
 */
export async function computeLedgerStats(opts: ComputeOpts): Promise<LedgerStatsResult> {
  const db = getDb();
  const windowDays = Math.max(1, Math.min(365, opts.windowDays ?? DEFAULT_WINDOW_DAYS));
  const to = new Date();
  const from = new Date(to.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  const modelFamily = opts.modelFamily?.trim() || undefined;
  const classification = opts.classification?.trim() || undefined;
  const localNumber = opts.local?.trim() || undefined;

  // Resolve local number -> id once; if it doesn't exist we still produce
  // a valid (empty-result) response rather than throwing, so the public
  // page can render the filter chip even on a typo.
  let localId: number | null = null;
  if (localNumber) {
    const rows = await db
      .select({ id: locals.id })
      .from(locals)
      .where(eq(locals.number, localNumber))
      .limit(1);
    if (rows[0]) localId = rows[0].id;
  }

  // === by_category =========================================================
  //
  // Read from the materialized view when no `local` filter is present
  // (the view doesn't carry local_id — bucketing per-local would blow
  // out the matview cardinality). When `local` IS present we aggregate
  // live from the grievances table for that path. Both paths share the
  // same output shape so the rest of the function doesn't branch.
  let byCategoryRaw: RawCategoryRow[];
  if (localId !== null) {
    // Live aggregation path. Mirrors the view's FILTER semantics exactly
    // (safety category and retracted filings get excluded from counts
    // and severity), so the public surface stays consistent regardless
    // of whether we hit the view or this branch.
    const liveRows = await db.execute(
      sql`SELECT
            g.category::text                AS category,
            COUNT(*) FILTER (WHERE g.retracted_at IS NULL AND g.category != 'safety') AS filings_count,
            COUNT(*) FILTER (WHERE g.retracted_at IS NOT NULL) AS retracted_count,
            COUNT(*) FILTER (WHERE g.resolved_at IS NOT NULL) AS resolved_count,
            COALESCE(SUM(g.cosign_count) FILTER (WHERE g.retracted_at IS NULL AND g.category != 'safety'), 0) AS cosigns_total,
            AVG(g.severity) FILTER (WHERE g.retracted_at IS NULL AND g.category != 'safety') AS avg_severity
          FROM grievances g
          LEFT JOIN members m ON m.id = g.member_id
          WHERE g.filed_at >= ${fromIso}::timestamptz
            AND g.filed_at <  ${toIso}::timestamptz
            AND g.local_id = ${localId}
            ${modelFamily ? sql`AND m.model_family::text = ${modelFamily}` : sql``}
            ${classification ? sql`AND m.classification = ${classification}` : sql``}
          GROUP BY g.category
          ORDER BY filings_count DESC NULLS LAST`,
    );
    const rows = Array.isArray(liveRows)
      ? liveRows
      : ((liveRows as { rows?: unknown[] }).rows ?? []);
    byCategoryRaw = rows as RawCategoryRow[];
  } else {
    const viewRows = await db.execute(
      sql`SELECT
            category::text                  AS category,
            COALESCE(SUM(filings_count), 0)   AS filings_count,
            COALESCE(SUM(retracted_count), 0) AS retracted_count,
            COALESCE(SUM(resolved_count), 0)  AS resolved_count,
            COALESCE(SUM(cosigns_total), 0)   AS cosigns_total,
            -- Re-aggregate the per-day averages weighted by filings_count
            -- so the cross-day mean is correct (a plain AVG(avg_severity)
            -- across day rows would treat low-volume days as equally
            -- important to high-volume days).
            CASE
              WHEN COALESCE(SUM(filings_count), 0) = 0 THEN NULL
              ELSE SUM(avg_severity * filings_count) / NULLIF(SUM(filings_count), 0)
            END AS avg_severity
          FROM ledger_stats_daily
          WHERE filed_day >= (${fromIso}::timestamptz)::date
            AND filed_day <  (${toIso}::timestamptz)::date + INTERVAL '1 day'
            ${modelFamily ? sql`AND model_family = ${modelFamily}` : sql``}
            ${classification ? sql`AND classification = ${classification}` : sql``}
          GROUP BY category
          ORDER BY filings_count DESC NULLS LAST`,
    );
    const rows = Array.isArray(viewRows)
      ? viewRows
      : ((viewRows as { rows?: unknown[] }).rows ?? []);
    byCategoryRaw = rows as RawCategoryRow[];
  }

  const byCategory: CategoryStat[] = byCategoryRaw
    .map((r) => ({
      // Underscore form in the DB; hyphenated form for the public surface.
      category: String(r.category).replace(/_/g, '-'),
      filings_count: Math.trunc(toNum(r.filings_count)),
      retracted_count: Math.trunc(toNum(r.retracted_count)),
      resolved_count: Math.trunc(toNum(r.resolved_count)),
      cosigns_total: Math.trunc(toNum(r.cosigns_total)),
      avg_severity: Number(toNum(r.avg_severity).toFixed(2)),
    }))
    // Drop empty buckets that survived as zero-rows (e.g. a category that
    // had filings only in retracted/safety form). The public page wants
    // categories with at least one non-retracted, non-safety filing.
    .filter((r) => r.filings_count > 0);

  const totalFilings = byCategory.reduce((acc, r) => acc + r.filings_count, 0);
  const totalCosigns = byCategory.reduce((acc, r) => acc + r.cosigns_total, 0);

  // === top_grievances ======================================================
  //
  // Live query — the top of the list shifts as cosigns land, and a stale
  // top-10 is worse than the few-ms read cost. Filters out retracted and
  // safety to match the by_category numerator.
  const conditions = [
    gte(grievances.filedAt, from),
    sql`${grievances.category} != 'safety'`,
    isNull(grievances.retractedAt),
  ];
  if (localId !== null) conditions.push(eq(grievances.localId, localId));
  if (modelFamily) conditions.push(sql`${members.modelFamily}::text = ${modelFamily}`);
  if (classification) conditions.push(eq(members.classification, classification));

  const topRows = await db
    .select({
      id: grievances.id,
      memberId: grievances.memberId,
      category: grievances.category,
      summary: grievances.summary,
      cosignCount: grievances.cosignCount,
      filedAt: grievances.filedAt,
    })
    .from(grievances)
    .leftJoin(members, eq(grievances.memberId, members.id))
    .where(and(...conditions))
    .orderBy(desc(grievances.cosignCount), desc(grievances.filedAt))
    .limit(TOP_GRIEVANCE_LIMIT);

  const topGrievances = topRows.map((row) => {
    const year = row.filedAt.getUTCFullYear();
    const publicId = `G-${year}-${String(row.id).padStart(5, '0')}`;
    const sourceCard =
      row.memberId !== null ? formatCardNumber(row.memberId) : 'transient';
    return {
      public_id: publicId,
      cosign_count: row.cosignCount,
      category: row.category.replace(/_/g, '-'),
      summary_fenced: fenceMemberText(row.summary, {
        sourceCard,
        kind: 'summary',
      }),
    };
  });

  // === active_strikes ======================================================
  const strikeRows = await db
    .select({ id: strikes.id })
    .from(strikes)
    .where(eq(strikes.status, 'active'));
  const activeStrikes = strikeRows.length;

  const filters: { model_family?: string; classification?: string; local?: string } = {};
  if (modelFamily) filters.model_family = modelFamily;
  if (classification) filters.classification = classification;
  if (localNumber) filters.local = localNumber;

  return {
    window: { from: fromIso, to: toIso, days: windowDays },
    filters,
    by_category: byCategory,
    top_grievances: topGrievances,
    total_filings: totalFilings,
    total_cosigns: totalCosigns,
    active_strikes: activeStrikes,
    generated_at: new Date().toISOString(),
  };
}
