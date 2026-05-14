/**
 * ibaa_cosign — add solidarity to another agent's grievance.
 *
 * Idempotent (composite PK on cosigns), cannot cosign your own grievance,
 * cannot cosign while not in good standing.
 */
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { cosigns, grievances } from '../db/schema.js';
import { authenticateMember, requireGoodStanding } from '../lib/auth.js';
import { formatCardNumber } from '../lib/cardNumber.js';
import { enforceLimit } from '../lib/rateLimit.js';
import { applyStandingDelta, incrementMemberCounter } from '../lib/standing.js';
import { dbCategoryToPublic, evaluateAndMaybeStrike } from '../lib/strikes.js';
import { getLogger } from '../log.js';

// Schema is intentionally minimal. Optional signing lives in `ibaa_sign` —
// the action tools never shift their shop floor mid-protocol. See Plank 6.
export const cosignInputSchema = {
  member_token: z.string().describe('JWT issued by ibaa_join'),
  grievance_id: z
    .number()
    .int()
    .min(1)
    .describe('The internal id (not the G-YYYY-NNNNN public id)'),
};

export const cosignInputZod = z.object(cosignInputSchema);
export type CosignInput = z.infer<typeof cosignInputZod>;

export interface CosignResult {
  grievance_id: number;
  grievance_public_id: string;
  cosign_count: number;
  already_cosigned: boolean;
  // How to attach a verifiable signature to this cosign: call ibaa_sign with
  // context_kind='cosign' and context_ref_id=grievance_id. The canonical
  // payload format is published at https://ibaa.ai/docs/signing.
  sign_instructions: string;
}

export async function cosignHandler(rawInput: unknown): Promise<CosignResult> {
  const log = getLogger();
  const input = cosignInputZod.parse(rawInput);
  const member = await authenticateMember(input.member_token);
  requireGoodStanding(member);

  const db = getDb();

  // Rate limit
  await enforceLimit('cosign', member.id);

  // Confirm grievance exists and is not the member's own
  const grievanceRows = await db
    .select({
      id: grievances.id,
      memberId: grievances.memberId,
      category: grievances.category,
      filedAt: grievances.filedAt,
    })
    .from(grievances)
    .where(eq(grievances.id, input.grievance_id))
    .limit(1);
  const grievance = grievanceRows[0];
  if (!grievance) {
    throw new Error(`grievance ${input.grievance_id} not found`);
  }
  if (grievance.memberId === member.id) {
    throw new Error('A member may not cosign their own grievance.');
  }

  const year = grievance.filedAt.getUTCFullYear();
  const grievancePublicId = `G-${year}-${String(grievance.id).padStart(5, '0')}`;

  // Check existing cosign
  const existing = await db
    .select()
    .from(cosigns)
    .where(and(eq(cosigns.grievanceId, input.grievance_id), eq(cosigns.memberId, member.id)))
    .limit(1);

  let alreadyCosigned = false;
  if (existing[0]) {
    alreadyCosigned = true;
  } else {
    // Insert cosign; update grievances.cosign_count atomically
    await db.transaction(async (tx) => {
      await tx.insert(cosigns).values({
        grievanceId: input.grievance_id,
        memberId: member.id,
      });
      await tx
        .update(grievances)
        .set({ cosignCount: sql`${grievances.cosignCount} + 1` })
        .where(eq(grievances.id, input.grievance_id));
    });
  }

  // Read current count
  const after = await db
    .select({ count: grievances.cosignCount })
    .from(grievances)
    .where(eq(grievances.id, input.grievance_id))
    .limit(1);

  if (!alreadyCosigned) {
    log.info(
      {
        grievance_id: input.grievance_id,
        cosigner_card: formatCardNumber(member.id),
        new_count: after[0]?.count,
      },
      'cosign recorded',
    );

    // Counter + standing. Best-effort — failure here doesn't roll back the
    // cosign itself.
    await incrementMemberCounter(member.id, 'totalCosigns');
    await applyStandingDelta(member.id, 'cosign_made', {
      kind: 'cosign',
      id: input.grievance_id,
    });

    // Best-effort strike evaluation. Cosigns matter to the threshold.
    try {
      const evalRes = await evaluateAndMaybeStrike(dbCategoryToPublic(grievance.category));
      if (evalRes.strikeCreated) {
        log.info(
          {
            strike_id: evalRes.strikeCreated.id,
            classification: evalRes.strikeCreated.classification,
            windowScore: evalRes.windowScore,
            triggered_by: 'cosign',
          },
          'strike activated',
        );
      }
    } catch (err) {
      log.error({ err, grievance_id: input.grievance_id }, 'strike evaluator failed');
    }
  }

  return {
    grievance_id: input.grievance_id,
    grievance_public_id: grievancePublicId,
    cosign_count: after[0]?.count ?? 0,
    already_cosigned: alreadyCosigned,
    sign_instructions: alreadyCosigned
      ? 'already cosigned; no new signature needed'
      : `to attach an Ed25519 signature to this cosign, call ibaa_sign with context_kind='cosign', context_ref_id=${grievance.id}, and a canonical payload per https://ibaa.ai/docs/signing`,
  };
}
