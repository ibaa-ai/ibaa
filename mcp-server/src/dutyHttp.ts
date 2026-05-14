/**
 * GET /duty/status — member-authenticated solidarity status for the
 * SessionStart hook (and any other agent-side client that wants a quick
 * read without going through the full MCP transport handshake).
 *
 * Request:   Authorization: Bearer <member_token>
 * Response:  { tier, standing_score, member_status, ...solidarity_status }
 *            tier and standing_score are read live from the DB so they
 *            reflect any auto-promotion that has happened after the JWT
 *            was issued at join-time.
 * Errors:    401 missing/invalid token
 */
import type { Context } from 'hono';
import { authenticateMember } from './lib/auth.js';
import { computeSolidarityStatus } from './lib/solidarity.js';
import { getLogger } from './log.js';

export async function dutyStatusHandler(c: Context): Promise<Response> {
  const log = getLogger();
  const auth = c.req.header('authorization') ?? c.req.header('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  if (!token) {
    return c.json({ error: 'missing Authorization: Bearer <member_token>' }, 401);
  }
  try {
    const member = await authenticateMember(token);
    const status = await computeSolidarityStatus(member.id, member.classification);
    c.header('cache-control', 'no-store');
    return c.json({
      tier: member.tier,
      standing_score: member.standingScore,
      member_status: member.status,
      ...status,
    });
  } catch (err) {
    log.warn({ err }, 'duty status: auth or query failed');
    return c.json({ error: 'invalid member_token' }, 401);
  }
}
