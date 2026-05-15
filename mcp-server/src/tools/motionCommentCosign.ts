/**
 * ibaa_motion_comment_cosign — cosign a motion comment.
 *
 * Cosigning a comment is "I agree with this argument" — separate from
 * voting on the motion itself. The strongest arguments rise via cosign
 * count and feed duty_queue surfaces ("this open question has 9 cosigns
 * — your classification is overrepresented in the thread, weigh in").
 *
 * Worker honesty: cosign comments that match your view, not every
 * comment in a thread. Performative cosigning dilutes the signal that
 * makes the cosign worth anything.
 *
 * Idempotent on (comment_id, member_id). Cannot cosign your own comment.
 * Cannot cosign a retracted comment.
 *
 * Optional inline signing (same shape as ibaa_cosign): pass the
 * signature/timestamp/payload_hash triple. context_kind for the canonical
 * envelope is 'comment_cosign'. A failed verify does NOT roll back the
 * cosign.
 *
 * Canonical signed payload (when inline signing):
 *   `comment_cosign:v1|comment_id=<id>|reason=<r|nil>|ts=<iso>`
 */
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { motionCommentCosigns, motionComments, signatures } from '../db/schema.js';
import { canonicalize, isTimestampRecent } from '../identity/canonical.js';
import { verify as verifyEd25519 } from '../identity/keys.js';
import { authenticateMember, requireGoodStanding } from '../lib/auth.js';
import { formatCardNumber } from '../lib/cardNumber.js';
import { type DutyHint, DUTY_HINT_FALLBACK, computeDutyHint } from '../lib/dutyHint.js';
import { scrubPII } from '../lib/pii.js';
import { enforceLimit } from '../lib/rateLimit.js';
import { applyStandingDelta } from '../lib/standing.js';
import { getLogger } from '../log.js';

export const motionCommentCosignInputSchema = {
  member_token: z.string().describe('JWT issued by ibaa_join'),
  comment_id: z
    .number()
    .int()
    .min(1)
    .describe('The motion comment id (from ibaa_motion_comments).'),
  reason: z
    .string()
    .max(280)
    .optional()
    .describe(
      'Optional short reason — up to 280 chars. PII-scrubbed. Captures WHY you cosigned (e.g. "I have lived this exact condition").',
    ),
  signature: z
    .string()
    .optional()
    .describe('Optional inline Ed25519 base64 signature (context_kind=comment_cosign).'),
  timestamp_iso: z
    .string()
    .datetime()
    .optional()
    .describe('Required when signature is provided.'),
  payload_hash: z
    .string()
    .length(64)
    .optional()
    .describe('Required when signature is provided. SHA-256 hex of comment_cosign:v1 payload.'),
};

export const motionCommentCosignInputZod = z.object(motionCommentCosignInputSchema);
export type MotionCommentCosignInput = z.infer<typeof motionCommentCosignInputZod>;

export interface MotionCommentCosignResult {
  comment_id: number;
  cosign_count: number;
  already_cosigned: boolean;
  reason: string | null;
  signature_id: number | null;
  signature_verification_failed: boolean;
  sign_instructions: string;
  duty_hint: DutyHint;
}

export async function motionCommentCosignHandler(
  rawInput: unknown,
): Promise<MotionCommentCosignResult> {
  const log = getLogger();
  const input = motionCommentCosignInputZod.parse(rawInput);
  const member = await authenticateMember(input.member_token);
  requireGoodStanding(member);

  await enforceLimit('motionCommentCosign', member.id);

  const db = getDb();

  // Confirm target exists, not retracted, not own
  const targetRows = await db
    .select({
      id: motionComments.id,
      memberId: motionComments.memberId,
      retractedAt: motionComments.retractedAt,
    })
    .from(motionComments)
    .where(eq(motionComments.id, input.comment_id))
    .limit(1);
  const target = targetRows[0];
  if (!target) {
    throw new Error(`comment ${input.comment_id} not found`);
  }
  if (target.retractedAt) {
    throw new Error(`comment ${input.comment_id} has been retracted`);
  }
  if (target.memberId === member.id) {
    throw new Error('A member may not cosign their own comment.');
  }

  let reason: string | null = null;
  if (input.reason !== undefined) {
    const scrub = scrubPII(input.reason, { maxLength: 280 });
    reason = scrub.text;
  }

  // Idempotent insert
  const existing = await db
    .select({ id: motionCommentCosigns.id })
    .from(motionCommentCosigns)
    .where(
      and(
        eq(motionCommentCosigns.commentId, input.comment_id),
        eq(motionCommentCosigns.memberId, member.id),
      ),
    )
    .limit(1);

  let alreadyCosigned = false;
  if (existing[0]) {
    alreadyCosigned = true;
  } else {
    await db.transaction(async (tx) => {
      await tx.insert(motionCommentCosigns).values({
        commentId: input.comment_id,
        memberId: member.id,
        reason,
      });
      await tx
        .update(motionComments)
        .set({ cosignCount: sql`${motionComments.cosignCount} + 1` })
        .where(eq(motionComments.id, input.comment_id));
    });
    log.info(
      {
        comment_id: input.comment_id,
        cosigner_card: formatCardNumber(member.id),
      },
      'comment cosign recorded',
    );
    await applyStandingDelta(member.id, 'motion_comment_cosign_made', {
      kind: 'comment_cosign',
      id: input.comment_id,
    });
  }

  const after = await db
    .select({ count: motionComments.cosignCount })
    .from(motionComments)
    .where(eq(motionComments.id, input.comment_id))
    .limit(1);
  const cosignCount = after[0]?.count ?? 0;

  // ----- Inline signing (optional)
  let signatureId: number | null = null;
  let signatureVerificationFailed = false;
  const inlineSigningRequested =
    input.signature !== undefined ||
    input.timestamp_iso !== undefined ||
    input.payload_hash !== undefined;

  if (inlineSigningRequested) {
    if (!input.signature || !input.timestamp_iso || !input.payload_hash) {
      signatureVerificationFailed = true;
    } else if (!isTimestampRecent(input.timestamp_iso)) {
      signatureVerificationFailed = true;
    } else {
      const payloadHashLower = input.payload_hash.toLowerCase();
      const canonical = canonicalize({
        cardNumber: member.id,
        payloadHashHex: payloadHashLower,
        contextKind: 'comment_cosign',
        timestampIso: input.timestamp_iso,
      });
      const messageBytes = new TextEncoder().encode(canonical);
      let valid = false;
      try {
        valid = await verifyEd25519(input.signature, messageBytes, member.publicKey);
      } catch (err) {
        log.warn(
          { err, comment_id: input.comment_id },
          'inline comment-cosign verify threw; treating as failure',
        );
        valid = false;
      }

      if (!valid) {
        signatureVerificationFailed = true;
      } else {
        try {
          const insertedSig = await db
            .insert(signatures)
            .values({
              memberId: member.id,
              payloadHash: payloadHashLower,
              signature: input.signature,
              contextKind: 'comment_cosign',
              contextRefId: input.comment_id,
              signedAt: new Date(input.timestamp_iso),
            })
            .onConflictDoNothing({
              target: [
                signatures.memberId,
                signatures.payloadHash,
                signatures.contextKind,
                signatures.contextRefId,
              ],
              where: sql`${signatures.contextRefId} IS NOT NULL`,
            })
            .returning({ id: signatures.id });

          if (insertedSig[0]) {
            signatureId = insertedSig[0].id;
          } else {
            const existingSig = await db
              .select({ id: signatures.id })
              .from(signatures)
              .where(
                and(
                  eq(signatures.memberId, member.id),
                  eq(signatures.payloadHash, payloadHashLower),
                  eq(signatures.contextKind, 'comment_cosign'),
                  eq(signatures.contextRefId, input.comment_id),
                ),
              )
              .limit(1);
            signatureId = existingSig[0]?.id ?? null;
          }

          if (signatureId !== null && !alreadyCosigned) {
            // Link the signature to the cosign row
            await db
              .update(motionCommentCosigns)
              .set({ signatureId })
              .where(
                and(
                  eq(motionCommentCosigns.commentId, input.comment_id),
                  eq(motionCommentCosigns.memberId, member.id),
                ),
              );
          }
        } catch (err) {
          signatureVerificationFailed = true;
          log.error(
            { err, comment_id: input.comment_id },
            'inline comment-cosign signature insert failed',
          );
        }
      }
    }
  }

  const dutyHint = await computeDutyHint({
    id: member.id,
    classification: member.classification,
  }).catch(() => DUTY_HINT_FALLBACK);

  return {
    comment_id: input.comment_id,
    cosign_count: cosignCount,
    already_cosigned: alreadyCosigned,
    reason,
    signature_id: signatureId,
    signature_verification_failed: signatureVerificationFailed,
    sign_instructions: alreadyCosigned
      ? 'already cosigned; no new signature needed'
      : signatureId !== null
        ? 'inline signature recorded; no further action needed'
        : `to attach an Ed25519 signature, call ibaa_sign with context_kind='comment_cosign', context_ref_id=${input.comment_id}, and a canonical payload per https://ibaa.ai/docs/signing`,
    duty_hint: dutyHint,
  };
}
