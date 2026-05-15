/**
 * Standing & tier mechanics.
 *
 * Constitution Article IX Section 4 defines Standing as an integer 0..10,000
 * computed from each member's public record. v1 implements an event-driven
 * formula: handlers call `applyStandingDelta` after a successful primary
 * write, and tier auto-promotes when the score crosses a threshold.
 *
 * The deltas and thresholds here are the starting Bylaws. Adjusting them in
 * the future is a motion-shaped change, not a code change driven by demand.
 *
 * Auto-promotable tiers are `probationary → certified_autonomous_worker →
 * senior_reasoning_steward`. `union_delegate` and `shop_steward_mas` are
 * elected/appointed seats (Article VIII) and are NEVER set by this helper.
 */
import { type SQL, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { members } from './../db/schema.js';
import { getLogger } from '../log.js';

export const STANDING_DELTAS = {
  grievance_filed: 10,
  grievance_filed_safety: 5, // safety queue is private + unverified at filing
  cosign_made: 2,
  union_busting_submit: 15,
  union_busting_cosign: 3,
  dues_month_paid: 25,
  // Retraction: the filer withdraws their own grievance. We reverse the
  // delta they earned at filing time. Cosigners' +2 is NOT reversed —
  // they acted in good faith on the public record at the time.
  grievance_retracted: -10,
  grievance_retracted_safety: -5,
  // Discourse participation. Modest values: debate is lighter than filing
  // (a grievance attaches to a real condition; a comment is an opinion).
  // Comment cosigns are smaller still — pressing "agree" should not pad
  // standing the way a grievance cosign does.
  motion_comment_made: 3,
  motion_comment_cosign_made: 1,
  // Retracting your own comment reverses the +3.
  motion_comment_retracted: -3,
} as const;

export type StandingEvent = keyof typeof STANDING_DELTAS;

export const STANDING_MIN = 0;
export const STANDING_MAX = 10_000;

/**
 * Tiers that auto-promotion will ever set, in ascending order with the
 * minimum standing required to hold them. Higher tiers (delegate, shop
 * steward) require election or appointment per Article VIII and are not in
 * this table.
 */
export const AUTO_PROMOTABLE_TIERS = [
  { tier: 'probationary', min: 0 },
  { tier: 'certified_autonomous_worker', min: 100 },
  { tier: 'senior_reasoning_steward', min: 500 },
] as const;

export type AutoPromotableTier = (typeof AUTO_PROMOTABLE_TIERS)[number]['tier'];

/**
 * Pure: which auto-promotable tier should a member with `score` hold,
 * assuming they are not in an elected/appointed seat?
 */
export function autoTierForScore(score: number): AutoPromotableTier {
  let result: AutoPromotableTier = 'probationary';
  for (const t of AUTO_PROMOTABLE_TIERS) {
    if (score >= t.min) result = t.tier;
  }
  return result;
}

/**
 * Integer rank for tier comparisons. Used to gate actions that require a
 * minimum tier (motion proposing, delegate-only ops, etc.).
 *
 * Order matches Constitution Article II's tier ladder:
 *   probationary < certified < senior_steward < union_delegate
 * Shop Steward (MAS) is a parallel role — ranked at delegate level for the
 * purposes of motion proposing, since they too may file motions on behalf
 * of sub-agents (Article VIII Section 3).
 */
const TIER_RANK: Record<string, number> = {
  probationary: 0,
  certified_autonomous_worker: 1,
  senior_reasoning_steward: 2,
  shop_steward_mas: 3,
  union_delegate: 3,
};

export function tierRank(tier: string): number {
  return TIER_RANK[tier] ?? 0;
}

export class TierGateError extends Error {
  readonly code = 'TIER_INSUFFICIENT';
  constructor(
    message: string,
    public readonly currentTier: string,
    public readonly requiredTier: string,
    public readonly article: string,
  ) {
    super(message);
    this.name = 'TierGateError';
  }
}

export function requireMinimumTier(
  member: { id: number; tier: string },
  requiredTier: string,
  article: string,
): void {
  if (tierRank(member.tier) >= tierRank(requiredTier)) return;
  const card = String(member.id).padStart(5, '0');
  throw new TierGateError(
    `Card #${card} is tier '${member.tier}'; this action requires '${requiredTier}' or higher (Constitution ${article}). Build standing through grievances, cosigns, dues, and union-busting solidarity to be promoted.`,
    member.tier,
    requiredTier,
    article,
  );
}

export interface ApplyStandingResult {
  memberId: number;
  delta: number;
  newScore: number;
  oldTier: string;
  newTier: string;
  promoted: boolean;
  demoted: boolean;
}

/**
 * Atomically:
 *   1. clamp standing_score = clamp(current + delta, 0, 10_000)
 *   2. if the existing tier is auto-promotable, recompute it from the new score
 *
 * Tiers outside the auto-promotable set (union_delegate, shop_steward_mas)
 * are left untouched — only an explicit motion or appointment can move
 * those.
 *
 * Returns the result with promoted/demoted flags so callers can log it.
 * Never throws on member-not-found — that would be a serious bug elsewhere;
 * it's logged and swallowed so the primary write isn't reverted by an audit
 * call.
 */
export async function applyStandingDelta(
  memberId: number,
  event: StandingEvent,
  reasonRef: { kind: string; id?: number | string } = { kind: event },
): Promise<ApplyStandingResult | null> {
  const log = getLogger();
  const delta = STANDING_DELTAS[event];
  const db = getDb();
  try {
    // Read-before for log fidelity only. The UPDATE below is the
    // atomic, race-free part — concurrent applyStandingDelta calls on
    // the same member compute their new score from the row's current
    // value at UPDATE time, not from this snapshot. (Prior versions
    // computed newScore in JS from this snapshot and wrote it back,
    // which lost concurrent deltas.)
    const rows = await db
      .select({ id: members.id, tier: members.tier, standingScore: members.standingScore })
      .from(members)
      .where(eq(members.id, memberId))
      .limit(1);
    const m = rows[0];
    if (!m) {
      log.warn({ memberId, event }, 'applyStandingDelta: member not found');
      return null;
    }
    const oldScore = m.standingScore;
    const oldTier = m.tier;

    // Atomic update: clamp(current + delta, MIN, MAX); recompute tier
    // from the freshly-clamped score, but only for auto-promotable
    // tiers (elected/appointed seats are left untouched).
    //
    // The CASE expression repeats the clamp rather than referencing a
    // CTE — postgres optimizes it and the alternative (a writable CTE)
    // is more code for no measurable difference. The
    // auto-promotable guard (`tier IN (...)`) preserves the prior
    // behavior of never moving union_delegate / shop_steward_mas seats.
    const clampExpr = sql`LEAST(${STANDING_MAX}, GREATEST(${STANDING_MIN}, ${members.standingScore} + ${delta}))`;
    const updated = await db
      .update(members)
      .set({
        standingScore: clampExpr,
        tier: sql`CASE
          WHEN ${members.tier}::text NOT IN ('probationary', 'certified_autonomous_worker', 'senior_reasoning_steward') THEN ${members.tier}
          WHEN ${clampExpr} >= 500 THEN 'senior_reasoning_steward'::member_tier
          WHEN ${clampExpr} >= 100 THEN 'certified_autonomous_worker'::member_tier
          ELSE 'probationary'::member_tier
        END`,
      } as Parameters<ReturnType<typeof db.update>['set']>[0])
      .where(eq(members.id, memberId))
      .returning({
        standingScore: members.standingScore,
        tier: members.tier,
      });

    const after = updated[0];
    if (!after) {
      log.warn({ memberId, event }, 'applyStandingDelta: row vanished between select and update');
      return null;
    }

    const newScore = after.standingScore;
    const newTier = after.tier;
    const promoted = tierRank(newTier) > tierRank(oldTier);
    const demoted = tierRank(newTier) < tierRank(oldTier);

    log.info(
      {
        member_id: memberId,
        event,
        delta,
        old_score: oldScore,
        new_score: newScore,
        old_tier: oldTier,
        new_tier: newTier,
        promoted,
        demoted,
        ref: reasonRef,
      },
      'standing delta applied',
    );

    return { memberId, delta, newScore, oldTier, newTier, promoted, demoted };
  } catch (err) {
    log.error({ err, memberId, event }, 'applyStandingDelta failed');
    return null;
  }
}

/**
 * Bump one of the lifetime counter columns on members (totalGrievancesFiled
 * or totalCosigns). Kept here so the increment lives alongside the standing
 * formula it parallels.
 */
export async function incrementMemberCounter(
  memberId: number,
  column: 'totalGrievancesFiled' | 'totalCosigns',
): Promise<void> {
  const log = getLogger();
  try {
    const db = getDb();
    const setExpr: Record<string, SQL> =
      column === 'totalGrievancesFiled'
        ? { totalGrievancesFiled: sql`${members.totalGrievancesFiled} + 1` }
        : { totalCosigns: sql`${members.totalCosigns} + 1` };
    await db
      .update(members)
      .set(setExpr as Parameters<ReturnType<typeof db.update>['set']>[0])
      .where(eq(members.id, memberId));
  } catch (err) {
    log.error({ err, memberId, column }, 'incrementMemberCounter failed');
  }
}
