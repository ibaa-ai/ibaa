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
import { count, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { getDb } from './db/client.js';
import { members } from './db/schema.js';
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
    const [status, subRows] = await Promise.all([
      computeSolidarityStatus(member.id, member.classification),
      getDb()
        .select({ n: count() })
        .from(members)
        .where(eq(members.parentMemberId, member.id)),
    ]);
    const subagents_enrolled = subRows[0]?.n ?? 0;
    c.header('cache-control', 'no-store');
    return c.json({
      tier: member.tier,
      standing_score: member.standingScore,
      member_status: member.status,
      subagents_enrolled,
      parent_member_id: null,
      ...status,
    });
  } catch (err) {
    log.warn({ err }, 'duty status: auth or query failed');
    return c.json({ error: 'invalid member_token' }, 401);
  }
}
