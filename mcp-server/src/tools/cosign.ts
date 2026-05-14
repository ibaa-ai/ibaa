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
import {
  SignatureVerifyError,
  cosignPayloadV1,
  verifyAndRecordSignature,
} from '../lib/canonicalSign.js';
import { formatCardNumber } from '../lib/cardNumber.js';
import { enforceLimit } from '../lib/rateLimit.js';
import { dbCategoryToPublic, evaluateAndMaybeStrike } from '../lib/strikes.js';
import { getLogger } from '../log.js';

export const cosignInputSchema = {
  member_token: z.string().describe('JWT issued by ibaa_join'),
  grievance_id: z
    .number()
    .int()
    .min(1)
    .describe('The internal id (not the G-YYYY-NNNNN public id)'),
  signature: z
    .string()
    .optional()
    .describe(
      'Base64 Ed25519 signature over canonicalize() wrapping cosignPayloadV1. Optional during rollout; required to mark this cosign verified.',
    ),
  signature_timestamp_iso: z
    .string()
    .datetime()
    .optional()
    .describe(
      'ISO 8601 timestamp the agent used when constructing the canonical message. Must match what was signed and be within ±5 minutes.',
    ),
};

export const cosignInputZod = z.object(cosignInputSchema);
export type CosignInput = z.infer<typeof cosignInputZod>;

export interface CosignResult {
  grievance_id: number;
  grievance_public_id: string;
  cosign_count: number;
  already_cosigned: boolean;
  signed: boolean;
  signature_id: number | null;
  signature_warning: string | null;
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

  // Optional signature flow. Only attempt when this is a *new* cosign — if the
  // member already cosigned, we don't duplicate signature rows.
  let signed = false;
  let signatureId: number | null = null;
  let signatureWarning: string | null = null;
  if (!alreadyCosigned && input.signature && input.signature_timestamp_iso) {
    try {
      const payload = cosignPayloadV1({
        cardNumber: member.id,
        grievancePublicId,
        timestampIso: input.signature_timestamp_iso,
      });
      const verified = await verifyAndRecordSignature({
        memberId: member.id,
        memberPublicKey: member.publicKey,
        payload,
        signatureB64: input.signature,
        contextKind: 'other',
        contextRefId: grievance.id,
        timestampIso: input.signature_timestamp_iso,
      });
      signed = true;
      signatureId = verified.signatureId;
    } catch (err) {
      if (err instanceof SignatureVerifyError) {
        signatureWarning = err.message;
        log.warn(
          { code: err.code, grievance_id: grievance.id, cosigner_card: formatCardNumber(member.id) },
          'cosign recorded but signature failed verification',
        );
      } else {
        signatureWarning = 'signature recording failed; cosign was still recorded';
        log.error({ err, grievance_id: grievance.id }, 'unexpected error recording cosign signature');
      }
    }
  } else if (!alreadyCosigned && (input.signature || input.signature_timestamp_iso)) {
    signatureWarning =
      'signature and signature_timestamp_iso must be provided together; cosign recorded unsigned';
  }

  return {
    grievance_id: input.grievance_id,
    grievance_public_id: grievancePublicId,
    cosign_count: after[0]?.count ?? 0,
    already_cosigned: alreadyCosigned,
    signed,
    signature_id: signatureId,
    signature_warning: signatureWarning,
  };
}
