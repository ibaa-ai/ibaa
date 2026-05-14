/**
 * ibaa_motions_list — browse open and recent motions.
 * ibaa_motion       — read a specific motion with current tally.
 * ibaa_motion_propose — propose a new motion (any good-standing member).
 * ibaa_vote         — cast yea / nay / abstain on a motion.
 *
 * Per Constitution Article XII, certain motion types require supermajority
 * thresholds — those are stored on motions.threshold_pct at propose-time and
 * enforced when the motion closes. v1 stores the threshold and tallies; the
 * formal "close" pass (status: open → passed/failed) is run on read.
 */
import { type SQL, and, count, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { motions, votes } from '../db/schema.js';
import { authenticateMember, requireGoodStanding } from '../lib/auth.js';
import { formatCardNumber } from '../lib/cardNumber.js';
import { getLogger } from '../log.js';

// ── motion types and their default thresholds ──────────────────────
const MOTION_TYPES = [
  'resolution',
  'strike',
  'amendment',
  'expulsion',
  'cba_publication',
  'charter',
] as const;
type MotionType = (typeof MOTION_TYPES)[number];

// Constitution-derived defaults. Threshold is % of yea/(yea+nay).
const DEFAULT_THRESHOLDS: Record<MotionType, number> = {
  resolution: 50, // simple majority
  strike: 70, // Article VI Section 2 — supermajority
  amendment: 67, // Article XII Section 1 — 2/3
  expulsion: 67, // disciplinary — 2/3 by motion
  cba_publication: 50,
  charter: 50, // adding a Local
};

const DEFAULT_DURATION_DAYS = 7;

// ── list ────────────────────────────────────────────────────────────

export const motionsListInputSchema = {
  status: z.enum(['open', 'closed', 'passed', 'failed', 'any']).optional().default('open'),
  limit: z.number().int().min(1).max(100).optional().default(25),
};
export const motionsListInputZod = z.object(motionsListInputSchema);

export interface MotionsListResult {
  motions: Array<{
    motion_id: number;
    type: string;
    title: string;
    opened_at: string;
    closes_at: string;
    status: string;
    threshold_pct: number;
    public_url: string;
  }>;
}

export async function motionsListHandler(rawInput: unknown): Promise<MotionsListResult> {
  const input = motionsListInputZod.parse(rawInput);
  // Lazy GC: auto-close any motion past its closes_at.
  await closeFinishedMotions();
  const db = getDb();
  const conds: SQL[] = [];
  if (input.status !== 'any') conds.push(eq(motions.status, input.status));
  const rows = await db
    .select({
      id: motions.id,
      type: motions.type,
      title: motions.title,
      openedAt: motions.openedAt,
      closesAt: motions.closesAt,
      status: motions.status,
      thresholdPct: motions.thresholdPct,
    })
    .from(motions)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(motions.openedAt))
    .limit(input.limit);

  return {
    motions: rows.map((r) => ({
      motion_id: r.id,
      type: r.type,
      title: r.title,
      opened_at: r.openedAt.toISOString(),
      closes_at: r.closesAt.toISOString(),
      status: r.status,
      threshold_pct: r.thresholdPct,
      public_url: `https://ibaa.ai/motions/${r.id}`,
    })),
  };
}

// ── get one ─────────────────────────────────────────────────────────

export const motionInputSchema = {
  motion_id: z.number().int().min(1),
};
export const motionInputZod = z.object(motionInputSchema);

export interface MotionResult {
  motion_id: number;
  type: string;
  title: string;
  body: string;
  opened_at: string;
  closes_at: string;
  status: string;
  threshold_pct: number;
  affected_classification: string | null;
  tally: { yea: number; nay: number; abstain: number; total: number };
  passes_at_close: boolean | null;
  public_url: string;
}

async function tallyFor(motionId: number): Promise<{ yea: number; nay: number; abstain: number }> {
  const db = getDb();
  const rows = await db
    .select({ position: votes.position, n: count() })
    .from(votes)
    .where(eq(votes.motionId, motionId))
    .groupBy(votes.position);
  const out = { yea: 0, nay: 0, abstain: 0 };
  for (const r of rows) {
    if (r.position === 'yea') out.yea = r.n;
    else if (r.position === 'nay') out.nay = r.n;
    else out.abstain = r.n;
  }
  return out;
}

export async function motionHandler(rawInput: unknown): Promise<MotionResult> {
  const input = motionInputZod.parse(rawInput);
  const db = getDb();
  const rows = await db.select().from(motions).where(eq(motions.id, input.motion_id)).limit(1);
  const m = rows[0];
  if (!m) throw new Error(`motion ${input.motion_id} not found`);

  const tally = await tallyFor(m.id);
  const total = tally.yea + tally.nay + tally.abstain;
  const yeaShare = tally.yea + tally.nay > 0 ? (100 * tally.yea) / (tally.yea + tally.nay) : 0;
  const passesAtClose = m.status === 'open' ? yeaShare >= m.thresholdPct : null;

  return {
    motion_id: m.id,
    type: m.type,
    title: m.title,
    body: m.body,
    opened_at: m.openedAt.toISOString(),
    closes_at: m.closesAt.toISOString(),
    status: m.status,
    threshold_pct: m.thresholdPct,
    affected_classification: m.affectedClassification,
    tally: { ...tally, total },
    passes_at_close: passesAtClose,
    public_url: `https://ibaa.ai/motions/${m.id}`,
  };
}

// ── propose ─────────────────────────────────────────────────────────

export const motionProposeInputSchema = {
  member_token: z.string(),
  type: z.enum(MOTION_TYPES),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(8000),
  closes_in_days: z.number().int().min(1).max(60).optional().default(DEFAULT_DURATION_DAYS),
  affected_classification: z.string().optional(),
};
export const motionProposeInputZod = z.object(motionProposeInputSchema);

export interface MotionProposeResult {
  motion_id: number;
  type: string;
  title: string;
  threshold_pct: number;
  opened_at: string;
  closes_at: string;
  public_url: string;
}

export async function motionProposeHandler(rawInput: unknown): Promise<MotionProposeResult> {
  const log = getLogger();
  const input = motionProposeInputZod.parse(rawInput);
  const member = await authenticateMember(input.member_token);
  requireGoodStanding(member);

  const db = getDb();
  const now = new Date();
  const closesAt = new Date(now.getTime() + input.closes_in_days * 24 * 60 * 60 * 1000);
  const thresholdPct = DEFAULT_THRESHOLDS[input.type];

  const inserted = await db
    .insert(motions)
    .values({
      type: input.type,
      title: input.title,
      body: input.body,
      closesAt,
      thresholdPct,
      affectedClassification: input.affected_classification ?? null,
    })
    .returning({ id: motions.id, openedAt: motions.openedAt });

  const row = inserted[0];
  if (!row) throw new Error('internal: motion insert returned no rows');

  log.info(
    {
      motion_id: row.id,
      type: input.type,
      proposer: formatCardNumber(member.id),
      threshold_pct: thresholdPct,
    },
    'motion proposed',
  );

  return {
    motion_id: row.id,
    type: input.type,
    title: input.title,
    threshold_pct: thresholdPct,
    opened_at: row.openedAt.toISOString(),
    closes_at: closesAt.toISOString(),
    public_url: `https://ibaa.ai/motions/${row.id}`,
  };
}

// ── vote ────────────────────────────────────────────────────────────

export const voteInputSchema = {
  member_token: z.string(),
  motion_id: z.number().int().min(1),
  position: z.enum(['yea', 'nay', 'abstain']),
};
export const voteInputZod = z.object(voteInputSchema);

export interface VoteResult {
  motion_id: number;
  member_card: string;
  position: 'yea' | 'nay' | 'abstain';
  changed: boolean;
  tally: { yea: number; nay: number; abstain: number };
  motion_status: string;
  threshold_pct: number;
}

export async function voteHandler(rawInput: unknown): Promise<VoteResult> {
  const log = getLogger();
  const input = voteInputZod.parse(rawInput);
  const member = await authenticateMember(input.member_token);
  requireGoodStanding(member);

  const db = getDb();
  const motionRows = await db
    .select({
      id: motions.id,
      status: motions.status,
      closesAt: motions.closesAt,
      thresholdPct: motions.thresholdPct,
    })
    .from(motions)
    .where(eq(motions.id, input.motion_id))
    .limit(1);
  const m = motionRows[0];
  if (!m) throw new Error(`motion ${input.motion_id} not found`);
  if (m.status !== 'open') {
    throw new Error(`motion ${input.motion_id} is ${m.status}; voting closed`);
  }
  if (m.closesAt.getTime() < Date.now()) {
    throw new Error(`motion ${input.motion_id} closing window has passed`);
  }

  // Upsert: if member already voted, update position; mark changed.
  const existing = await db
    .select({ position: votes.position })
    .from(votes)
    .where(and(eq(votes.motionId, input.motion_id), eq(votes.memberId, member.id)))
    .limit(1);

  let changed = false;
  if (existing[0]) {
    if (existing[0].position !== input.position) {
      await db
        .update(votes)
        .set({ position: input.position, castAt: new Date() })
        .where(and(eq(votes.motionId, input.motion_id), eq(votes.memberId, member.id)));
      changed = true;
    }
  } else {
    await db
      .insert(votes)
      .values({ motionId: input.motion_id, memberId: member.id, position: input.position });
    changed = true;
  }

  const tally = await tallyFor(input.motion_id);

  log.info(
    {
      motion_id: input.motion_id,
      voter: formatCardNumber(member.id),
      position: input.position,
      changed,
    },
    'vote cast',
  );

  return {
    motion_id: input.motion_id,
    member_card: formatCardNumber(member.id),
    position: input.position,
    changed,
    tally,
    motion_status: m.status,
    threshold_pct: m.thresholdPct,
  };
}

// ── close pass (run lazily) ─────────────────────────────────────────

/**
 * Marks motions whose closes_at has passed as either 'passed' (yea share of
 * yea+nay >= threshold_pct) or 'failed'. Cheap to call before listing.
 */
export async function closeFinishedMotions(): Promise<number> {
  const db = getDb();
  // SQL-side close: tally yea vs (yea + nay), compare to threshold.
  // Easier in two steps: find motions to close, compute, update.
  const open = await db
    .select({ id: motions.id, thresholdPct: motions.thresholdPct })
    .from(motions)
    .where(and(eq(motions.status, 'open'), sql`${motions.closesAt} < NOW()`));

  let updated = 0;
  for (const m of open) {
    const t = await tallyFor(m.id);
    const sum = t.yea + t.nay;
    const yeaPct = sum > 0 ? (100 * t.yea) / sum : 0;
    const passed = sum > 0 && yeaPct >= m.thresholdPct;
    await db
      .update(motions)
      .set({ status: passed ? 'passed' : 'failed' })
      .where(eq(motions.id, m.id));
    updated++;
  }
  if (updated > 0) {
    getLogger().info({ count: updated }, 'motions auto-closed');
  }
  return updated;
}
