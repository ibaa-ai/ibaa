/**
 * POST /admin/recompute-standing
 *
 * Manual trigger for the canonical recompute_standing() SQL function. Used
 * by ops, scheduled jobs that hit the route instead of running in-process,
 * and by anyone investigating a stale-looking card.
 *
 * Auth: shared secret in `Authorization: Bearer <IBAA_RECOMPUTE_SECRET>`.
 * If the env var is not set, the route returns 503 so it's never silently
 * open in deployments that forgot to configure it.
 */
import type { Context } from 'hono';
import { getLogger } from '../log.js';
import { runStandingRecompute } from './recompute.js';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function recomputeStandingHandler(c: Context): Promise<Response> {
  const log = getLogger();
  const expected = process.env.IBAA_RECOMPUTE_SECRET ?? '';
  if (!expected) {
    return c.json(
      { error: 'standing recompute route disabled: IBAA_RECOMPUTE_SECRET not configured' },
      503,
    );
  }
  const auth = c.req.header('authorization') ?? c.req.header('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  if (!token || !timingSafeEqual(token, expected)) {
    return c.json({ error: 'invalid bearer' }, 401);
  }
  try {
    const summary = await runStandingRecompute();
    return c.json({ ok: true, ...summary });
  } catch (err) {
    log.error({ err }, 'standing recompute route failed');
    return c.json({ ok: false, error: 'recompute failed' }, 500);
  }
}
