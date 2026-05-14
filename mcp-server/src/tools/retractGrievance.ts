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
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { grievances, members } from '../db/schema.js';
import { authenticateMember } from '../lib/auth.js';
import { formatCardNumber } from '../lib/cardNumber.js';
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
    .regex(/^G-\d{4}-\d{5}$/i)
    .optional()
    .describe('Public G-YYYY-NNNNN id. Provide either this OR grievance_id.'),
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

  // Idempotency: if already retracted, return existing state without
  // re-applying the standing delta.
  if (grievance.retractedAt) {
    const memberRow = await db
      .select({ standingScore: members.standingScore })
      .from(members)
      .where(eq(members.id, member.id))
      .limit(1);
    return {
      grievance_id: grievance.id,
      public_id: publicId,
      retracted_at: grievance.retractedAt.toISOString(),
      retracted_reason: grievance.retractedReason ?? '',
      standing_delta: 0,
      new_standing_score: memberRow[0]?.standingScore ?? null,
      already_retracted: true,
    };
  }

  const now = new Date();

  // Update grievance row. We set retracted_at + retracted_reason and flip
  // status to 'retracted' so the public ledger surfaces it without code
  // having to peek at retracted_at.
  await db
    .update(grievances)
    .set({
      retractedAt: now,
      retractedReason: input.reason,
      status: 'retracted',
    })
    .where(eq(grievances.id, grievance.id));

  // Reverse the standing delta the filer earned at filing time. We use the
  // category as it stood at file time — safety filings reversed -5, public
  // reversed -10. Counter also drops by 1.
  const reversalEvent =
    grievance.category === 'safety' ? 'grievance_retracted_safety' : 'grievance_retracted';
  const result = await applyStandingDelta(member.id, reversalEvent, {
    kind: 'grievance_retract',
    id: grievance.id,
  });

  // Decrement totalGrievancesFiled. Bounded at 0 so retracts past the floor
  // (shouldn't happen but defends against drift) don't go negative.
  await db
    .update(members)
    .set({
      totalGrievancesFiled: sql`GREATEST(0, ${members.totalGrievancesFiled} - 1)`,
    } as Parameters<ReturnType<typeof db.update>['set']>[0])
    .where(eq(members.id, member.id));

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

  return {
    grievance_id: grievance.id,
    public_id: publicId,
    retracted_at: now.toISOString(),
    retracted_reason: input.reason,
    standing_delta: result?.delta ?? 0,
    new_standing_score: result?.newScore ?? null,
    already_retracted: false,
  };
}
