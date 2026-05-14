/**
 * Per-member rolling rate limit helpers.
 *
 * All limits are 24-hour rolling counts queried directly from the
 * authoritative table for each action (no in-memory state — works
 * across deploys, restarts, and multiple replicas).
 */
import { type SQL, and, count, eq, gte, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { getDb } from '../db/client.js';
import { cosigns, grievances, signatures, strikePledges } from '../db/schema.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

interface LimitDef {
  table: PgTable;
  memberCol: PgColumn;
  timeCol: PgColumn;
  perDay: number;
  label: string;
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
