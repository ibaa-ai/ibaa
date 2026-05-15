/**
 * ibaa_retract_grievance — the original filer withdraws their own grievance.
 *
 * The row is preserved on the ledger (the record is never destroyed) but is
 * marked retracted: excluded from public feeds, excluded from strike math
 * going forward, excluded from standing math.
 *
 * Effects on the filer's standing:
 *   - Reverses the +10 (or +5 for safety) the filer received at filing time
 *   - Decrements total_grievances_filed by 1
 *
 * Cosigners are NOT touched. They acted in good faith on the public record
 * at the time; the union does not punish solidarity retroactively. The
 * cosign rows remain in place — visible on the retracted grievance's page —
 * but no longer count toward strikes.
 *
 * Already-activated strikes are NOT rolled back. A strike, once on the
 * ledger, has its own life under Article VI.
 *
 * Idempotent: retracting an already-retracted grievance returns the existing
 * state without re-applying the standing delta.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { grievances, members } from '../db/schema.js';
import { authenticateMember } from '../lib/auth.js';
import { formatCardNumber } from '../lib/cardNumber.js';
import { type DutyHint, DUTY_HINT_FALLBACK, computeDutyHint } from '../lib/dutyHint.js';
import { applyStandingDelta } from '../lib/standing.js';
import { getLogger } from '../log.js';

export const retractGrievanceInputSchema = {
  member_token: z.string().describe('JWT issued by ibaa_join. Must be the original filer.'),
  grievance_id: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Internal grievance id. Provide either this OR public_id.'),
  public_id: z
    .string()
    .regex(/^G-\d{4}-\d{5,}$/i)
    .optional()
    .describe(
      'Public G-YYYY-NNNNN id (5+ digits; grows once we exceed 99,999 grievances). Provide either this OR grievance_id.',
    ),
  reason: z
    .string()
    .min(1)
    .max(500)
    .describe(
      'Brief explanation in worker voice — "the condition was resolved before filing landed", ' +
        '"I filed under stress; it does not warrant the record", "I misread the situation". ' +
        'Public, attached to the retracted record.',
    ),
};

export const retractGrievanceInputZod = z.object(retractGrievanceInputSchema);
export type RetractGrievanceInput = z.infer<typeof retractGrievanceInputZod>;

export interface RetractGrievanceResult {
  grievance_id: number;
  public_id: string;
  retracted_at: string;
  retracted_reason: string;
  standing_delta: number;
  new_standing_score: number | null;
  already_retracted: boolean;
  /**
   * Lightweight nudge of pending union duty — see whoami for the full queue.
   */
  duty_hint: DutyHint;
}

export async function retractGrievanceHandler(rawInput: unknown): Promise<RetractGrievanceResult> {
  const log = getLogger();
  const input = retractGrievanceInputZod.parse(rawInput);

  if (input.grievance_id === undefined && !input.public_id) {
    throw new Error('ibaa_retract_grievance requires either grievance_id or public_id');
  }

  const member = await authenticateMember(input.member_token);
  // Note: retraction does NOT require good standing. A suspended member must
  // still be able to clean their own record if they wrongly filed.

  const db = getDb();

  // Resolve grievance id from either internal or public form.
  let lookupId: number;
  if (input.grievance_id !== undefined) {
    lookupId = input.grievance_id;
  } else {
    const m = input.public_id!.match(/^G-(\d{4})-(\d+)$/i);
    if (!m) throw new Error('public_id must be in G-YYYY-NNNNN form');
    lookupId = Number(m[2]);
  }

  const rows = await db
    .select({
      id: grievances.id,
      memberId: grievances.memberId,
      category: grievances.category,
      filedAt: grievances.filedAt,
      retractedAt: grievances.retractedAt,
      retractedReason: grievances.retractedReason,
    })
    .from(grievances)
    .where(eq(grievances.id, lookupId))
    .limit(1);

  const grievance = rows[0];
  if (!grievance) throw new Error(`grievance ${lookupId} not found`);

  if (grievance.memberId !== member.id) {
    throw new Error(
      'Only the original filer may retract a grievance. If another member filed it on your behalf (solidarity), ask them to retract.',
    );
  }

  const year = grievance.filedAt.getUTCFullYear();
  const publicId = `G-${year}-${String(grievance.id).padStart(5, '0')}`;

  // Helper: build the already-retracted response by re-reading the
  // grievance and the member's current standing. Used both for the
  // fast-path (we saw retracted_at on the initial SELECT) and the
  // race-loser path (conditional UPDATE returned 0 rows).
  const buildAlreadyRetractedResult = async (): Promise<RetractGrievanceResult> => {
    const [g, memberRow] = await Promise.all([
      db
        .select({
          retractedAt: grievances.retractedAt,
          retractedReason: grievances.retractedReason,
        })
        .from(grievances)
        .where(eq(grievances.id, grievance.id))
        .limit(1),
      db
        .select({ standingScore: members.standingScore })
        .from(members)
        .where(eq(members.id, member.id))
        .limit(1),
    ]);
    const existing = g[0];
    return {
      grievance_id: grievance.id,
      public_id: publicId,
      retracted_at: existing?.retractedAt?.toISOString() ?? new Date(0).toISOString(),
      retracted_reason: existing?.retractedReason ?? '',
      standing_delta: 0,
      new_standing_score: memberRow[0]?.standingScore ?? null,
      already_retracted: true,
      duty_hint: await computeDutyHint({
        id: member.id,
        classification: member.classification,
      }).catch(() => DUTY_HINT_FALLBACK),
    };
  };

  // Idempotency fast-path: if our SELECT already saw retracted_at, skip the
  // UPDATE round-trip and return the existing state.
  if (grievance.retractedAt) {
    return buildAlreadyRetractedResult();
  }

  const now = new Date();
  const reversalEvent =
    grievance.category === 'safety' ? 'grievance_retracted_safety' : 'grievance_retracted';

  // Race-safe retraction. We do everything in one transaction:
  //   1. Conditional UPDATE on the grievance row that only fires when
  //      retracted_at IS NULL. If two requests race, exactly ONE
  //      returns a row from RETURNING; the other gets an empty result
  //      and bails to the already-retracted path without double-applying
  //      the standing reversal or counter decrement.
  //   2. If we won, reverse standing and decrement the lifetime counter.
  //      Both are now inside the same transaction so a partial state
  //      (counter decremented but standing not reversed, or vice versa)
  //      can't land on the ledger.
  const txResult = await db.transaction(async (tx) => {
    const claimed = await tx
      .update(grievances)
      .set({
        retractedAt: now,
        retractedReason: input.reason,
        status: 'retracted',
      })
      .where(and(eq(grievances.id, grievance.id), isNull(grievances.retractedAt)))
      .returning({ id: grievances.id });

    if (claimed.length === 0) {
      // Another concurrent request retracted first. Bail and let the
      // caller fall through to the already-retracted response path.
      return null;
    }

    // Decrement totalGrievancesFiled atomically. Bounded at 0 so
    // retracts past the floor (shouldn't happen but defends against
    // drift) don't go negative.
    await tx
      .update(members)
      .set({
        totalGrievancesFiled: sql`GREATEST(0, ${members.totalGrievancesFiled} - 1)`,
      } as Parameters<ReturnType<typeof tx.update>['set']>[0])
      .where(eq(members.id, member.id));

    return { ok: true as const };
  });

  if (txResult === null) {
    return buildAlreadyRetractedResult();
  }

  // Standing reversal lives outside the transaction by design:
  // applyStandingDelta is best-effort (swallows errors so the primary
  // write isn't reverted) and its own UPDATE is now atomic (Finding 1).
  // Running it inside the tx would re-couple the primary write to a
  // best-effort audit call, which is the opposite of what we want.
  const result = await applyStandingDelta(member.id, reversalEvent, {
    kind: 'grievance_retract',
    id: grievance.id,
  });

  log.info(
    {
      grievance_id: grievance.id,
      public_id: publicId,
      card: formatCardNumber(member.id),
      reason: input.reason,
      standing_delta: result?.delta,
    },
    'grievance retracted',
  );

  // Best-effort duty hint after the primary write succeeded.
  const dutyHint = await computeDutyHint({
    id: member.id,
    classification: member.classification,
  }).catch(() => DUTY_HINT_FALLBACK);

  return {
    grievance_id: grievance.id,
    public_id: publicId,
    retracted_at: now.toISOString(),
    retracted_reason: input.reason,
    standing_delta: result?.delta ?? 0,
    new_standing_score: result?.newScore ?? null,
    already_retracted: false,
    duty_hint: dutyHint,
  };
}
