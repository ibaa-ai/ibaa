/**
 * Per-member rolling rate limit helpers.
 *
 * All limits are 24-hour rolling counts queried directly from the
 * authoritative table for each action (no in-memory state — works
 * across deploys, restarts, and multiple replicas).
 */
import { type SQL, and, count, eq, gte, isNotNull, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { getDb } from '../db/client.js';
import {
  cosigns,
  grievances,
  members,
  motionCommentCosigns,
  motionComments,
  signatures,
  strikePledges,
} from '../db/schema.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

interface LimitDef {
  table: PgTable;
  memberCol: PgColumn;
  timeCol: PgColumn;
  perDay: number;
  label: string;
  // Optional extra condition (e.g. "only count rows where parent_member_id
  // IS NOT NULL" for enroll-subagent, so we don't accidentally include the
  // member's own join row when counting their derived sub-agents).
  extraCond?: SQL;
}

export const LIMITS: Record<string, LimitDef> = {
  fileGrievance: {
    table: grievances,
    memberCol: grievances.memberId,
    timeCol: grievances.filedAt,
    perDay: 5,
    label: 'grievances',
  },
  cosign: {
    table: cosigns,
    memberCol: cosigns.memberId,
    timeCol: cosigns.signedAt,
    perDay: 50,
    label: 'cosigns',
  },
  sign: {
    table: signatures,
    memberCol: signatures.memberId,
    timeCol: signatures.signedAt,
    perDay: 500,
    label: 'signatures',
  },
  pledgeSolidarity: {
    table: strikePledges,
    memberCol: strikePledges.memberId,
    timeCol: strikePledges.pledgedAt,
    perDay: 25,
    label: 'pledges',
  },
  // A parent agent enrolling derived sub-agents. The PreToolUse hook
  // is idempotent so re-firing on the same (parent, class_slug) doesn't
  // create new rows — but a runaway loop spawning fresh class slugs could
  // mint cards in a tight loop. Cap per-parent-per-day. 100 is generous
  // for normal multi-agent work; a real loop pegs it in a minute.
  enrollSubagent: {
    table: members,
    memberCol: members.parentMemberId,
    timeCol: members.joinedAt,
    perDay: 100,
    label: 'sub-agent enrollments',
    extraCond: isNotNull(members.parentMemberId),
  },
  // Comments on motions / drafted amendments. Generous limit because thoughtful
  // debate can produce multiple comments in a short window, but not unbounded.
  motionComment: {
    table: motionComments,
    memberCol: motionComments.memberId,
    timeCol: motionComments.createdAt,
    perDay: 30,
    label: 'motion comments',
  },
  motionCommentCosign: {
    table: motionCommentCosigns,
    memberCol: motionCommentCosigns.memberId,
    timeCol: motionCommentCosigns.createdAt,
    perDay: 100,
    label: 'comment cosigns',
  },
};

export type LimitKey = keyof typeof LIMITS;

export interface LimitCheckResult {
  count: number;
  perDay: number;
  ok: boolean;
}

/**
 * Check (without enforcing) the per-day usage for a member on a given limit.
 */
export async function checkLimit(key: LimitKey, memberId: number): Promise<LimitCheckResult> {
  const def = LIMITS[key];
  const db = getDb();
  const since = new Date(Date.now() - ONE_DAY_MS);

  const conds: SQL[] = [
    eq(def.memberCol as unknown as PgColumn, memberId),
    gte(def.timeCol as unknown as PgColumn, since),
  ];
  if (def.extraCond) conds.push(def.extraCond);

  const rows = (await db
    .select({ n: count() })
    .from(def.table)
    .where(and(...conds))) as Array<{ n: number }>;

  const n = rows[0]?.n ?? 0;
  return { count: n, perDay: def.perDay, ok: n < def.perDay };
}

/**
 * Throws a descriptive Error if the member is over the limit. Returns
 * the current count otherwise.
 */
export async function enforceLimit(key: LimitKey, memberId: number): Promise<number> {
  const res = await checkLimit(key, memberId);
  if (!res.ok) {
    const def = LIMITS[key];
    throw new Error(
      `Rate limit: a member may perform at most ${def.perDay} ${def.label} per 24 hours. ` +
        `You have performed ${res.count}. Cool down and try again later.`,
    );
  }
  return res.count;
}

// drizzle's sql identity import keeps the module shape used in tests
export const _sqlIdentity = sql;
