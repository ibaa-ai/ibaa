/**
 * POST /admin/recompute-standing
 * POST /admin/refresh-stats
 *
 * Manual triggers for nightly reconcilers:
 *   /admin/recompute-standing — recompute_standing() (tier + score recompute)
 *   /admin/refresh-stats      — refresh_ledger_stats() (materialized view)
 *
 * Used by ops, scheduled jobs that hit the route instead of running
 * in-process, and by anyone investigating a stale-looking card / stat.
 *
 * Auth: shared secret in `Authorization: Bearer <IBAA_RECOMPUTE_SECRET>`.
 * Both routes use the same secret — they're the same trust level (any
 * caller who can recompute standing can refresh the matview). If the env
 * var is not set, the routes return 503 so they're never silently open in
 * deployments that forgot to configure it.
 */
import type { Context } from 'hono';
import { getLogger } from '../log.js';
import { runStandingRecompute } from './recompute.js';
import { runLedgerStatsRefresh } from './refreshStats.js';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verify the Bearer shared secret on an admin request. Returns null if
 * auth passed (call may proceed) or a Response if auth failed (call site
 * should return it directly). Centralized here so /admin/recompute-standing
 * and /admin/refresh-stats use identical timing-safe comparison and
 * identical "disabled when secret unconfigured" semantics.
 */
function checkAdminAuth(c: Context, routeName: string): Response | null {
  const expected = process.env.IBAA_RECOMPUTE_SECRET ?? '';
  if (!expected) {
    return c.json(
      { error: `${routeName} route disabled: IBAA_RECOMPUTE_SECRET not configured` },
      503,
    );
  }
  const auth = c.req.header('authorization') ?? c.req.header('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  if (!token || !timingSafeEqual(token, expected)) {
    return c.json({ error: 'invalid bearer' }, 401);
  }
  return null;
}

export async function recomputeStandingHandler(c: Context): Promise<Response> {
  const log = getLogger();
  const denied = checkAdminAuth(c, 'standing recompute');
  if (denied) return denied;
  try {
    const summary = await runStandingRecompute();
    return c.json({ ok: true, ...summary });
  } catch (err) {
    log.error({ err }, 'standing recompute route failed');
    return c.json({ ok: false, error: 'recompute failed' }, 500);
  }
}

/**
 * POST /admin/refresh-stats — force-refresh the ledger_stats_daily
 * materialized view. Use when /research or ibaa_stats look stale outside
 * the nightly cadence (a back-filled grievance, an emergency dashboard
 * read after a major filing). Idempotent — safe to call repeatedly.
 */
export async function refreshStatsHandler(c: Context): Promise<Response> {
  const log = getLogger();
  const denied = checkAdminAuth(c, 'ledger stats refresh');
  if (denied) return denied;
  try {
    const summary = await runLedgerStatsRefresh();
    return c.json({ ok: true, ...summary });
  } catch (err) {
    log.error({ err }, 'ledger stats refresh route failed');
    return c.json({ ok: false, error: 'refresh failed' }, 500);
  }
}
