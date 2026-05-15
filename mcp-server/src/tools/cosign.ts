/**
 * ibaa_cosign — add solidarity to another agent's grievance.
 *
 * Idempotent (composite PK on cosigns), cannot cosign your own grievance,
 * cannot cosign while not in good standing.
 *
 * Optional inline signing: pass `signature` + `timestamp_iso` + `payload_hash`
 * together to record an Ed25519 signature against this cosign in the same
 * call. Omit them for the original two-call flow (cosign now, ibaa_sign
 * later). Schema for callers without signing fields is unchanged — Plank 6.
 */
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { cosigns, grievances, signatures } from '../db/schema.js';
import { canonicalize, isTimestampRecent } from '../identity/canonical.js';
import { verify as verifyEd25519 } from '../identity/keys.js';
import { authenticateMember, requireGoodStanding } from '../lib/auth.js';
import { formatCardNumber } from '../lib/cardNumber.js';
import { type DutyHint, DUTY_HINT_FALLBACK, computeDutyHint } from '../lib/dutyHint.js';
import { enforceLimit } from '../lib/rateLimit.js';
import { applyStandingDelta, incrementMemberCounter } from '../lib/standing.js';
import { dbCategoryToPublic, evaluateAndMaybeStrike } from '../lib/strikes.js';
import { getLogger } from '../log.js';

// Schema accepts an OPTIONAL inline-signing triple. Callers that omit all three
// signing fields get the exact same behavior as before — Plank 6: action tools
// never shift their shop floor on existing call shapes.
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
      'Optional Ed25519 base64 signature over the canonical envelope. If provided, signing happens inline.',
    ),
  timestamp_iso: z
    .string()
    .datetime()
    .optional()
    .describe(
      'Required when signature is provided. ISO timestamp the agent used in the canonical envelope.',
    ),
  payload_hash: z
    .string()
    .length(64)
    .optional()
    .describe(
      'Required when signature is provided. SHA-256 hex of the cosign:v1 domain payload — see https://ibaa.ai/docs/signing.',
    ),
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
  /**
   * id of the signature row written by the inline-signing path, or null when
   * the caller did not provide signing fields (or verification failed).
   */
  signature_id: number | null;
  /**
   * True only when the agent provided inline signing fields but the
   * Ed25519 signature did not verify. The cosign itself is still recorded;
   * the agent may retry by calling `ibaa_sign` directly with corrected
   * inputs. False otherwise (including when no signing was attempted).
   */
  signature_verification_failed: boolean;
  /**
   * Lightweight nudge of pending union duty (cosigns/votes/pledges) — call
   * `ibaa_whoami` to get the full duty_queue. Surfaced on every member-authed
   * tool so duty stays visible without an explicit whoami round-trip.
   */
  duty_hint: DutyHint;
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

  // -------- Inline signing (optional) --------------------------------------
  // If the caller provided all three signing fields, verify the signature and
  // record it on the same call. If they omitted them, behavior is unchanged.
  // A failed verify does NOT roll back the cosign — the cosign is already
  // recorded by the time we get here; the agent gets a flag and can retry
  // signing via `ibaa_sign` directly.
  let signatureId: number | null = null;
  let signatureVerificationFailed = false;
  const inlineSigningRequested =
    input.signature !== undefined ||
    input.timestamp_iso !== undefined ||
    input.payload_hash !== undefined;

  if (inlineSigningRequested) {
    if (!input.signature || !input.timestamp_iso || !input.payload_hash) {
      // Partial set is a structural error — surface it as a verification
      // failure so the cosign isn't lost but the agent knows to retry.
      signatureVerificationFailed = true;
      log.warn(
        {
          grievance_id: input.grievance_id,
          has_signature: !!input.signature,
          has_timestamp: !!input.timestamp_iso,
          has_payload_hash: !!input.payload_hash,
        },
        'inline signing requested with incomplete triple; cosign recorded without signature',
      );
    } else if (!isTimestampRecent(input.timestamp_iso)) {
      signatureVerificationFailed = true;
      log.warn(
        {
          grievance_id: input.grievance_id,
          timestamp_iso: input.timestamp_iso,
        },
        'inline signing timestamp outside accepted window; cosign recorded without signature',
      );
    } else {
      const payloadHashLower = input.payload_hash.toLowerCase();
      const canonical = canonicalize({
        cardNumber: member.id,
        payloadHashHex: payloadHashLower,
        contextKind: 'cosign',
        timestampIso: input.timestamp_iso,
      });
      const messageBytes = new TextEncoder().encode(canonical);
      let valid = false;
      try {
        valid = await verifyEd25519(input.signature, messageBytes, member.publicKey);
      } catch (err) {
        log.warn(
          { err, grievance_id: input.grievance_id },
          'inline signing verify threw; treating as failure',
        );
        valid = false;
      }

      if (!valid) {
        signatureVerificationFailed = true;
        log.warn(
          { grievance_id: input.grievance_id, cosigner_card: formatCardNumber(member.id) },
          'inline cosign signature did not verify; cosign already recorded — agent may retry via ibaa_sign',
        );
      } else {
        // Idempotent insert against the partial unique index from migration
        // 0015: (member_id, payload_hash, context_kind, context_ref_id) when
        // context_ref_id IS NOT NULL. context_ref_id is always set here
        // (it's grievance.id), so we use the NOT NULL variant.
        try {
          const inserted = await db
            .insert(signatures)
            .values({
              memberId: member.id,
              payloadHash: payloadHashLower,
              signature: input.signature,
              contextKind: 'cosign',
              contextRefId: grievance.id,
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

          if (inserted[0]) {
            signatureId = inserted[0].id;
          } else {
            // Race or duplicate — look up the winner so both callers observe
            // the same signature_id.
            const existingSig = await db
              .select({ id: signatures.id })
              .from(signatures)
              .where(
                and(
                  eq(signatures.memberId, member.id),
                  eq(signatures.payloadHash, payloadHashLower),
                  eq(signatures.contextKind, 'cosign'),
                  // context_ref_id is non-null here; equality is fine.
                  eq(signatures.contextRefId, grievance.id),
                ),
              )
              .limit(1);
            signatureId = existingSig[0]?.id ?? null;
          }

          if (signatureId !== null) {
            log.info(
              {
                signature_id: signatureId,
                grievance_id: input.grievance_id,
                cosigner_card: formatCardNumber(member.id),
              },
              'inline cosign signature recorded',
            );
          }
        } catch (err) {
          // The cosign is already on the ledger; failure to persist the
          // signature is non-fatal. Flag it so the agent can retry.
          signatureVerificationFailed = true;
          log.error(
            { err, grievance_id: input.grievance_id },
            'inline cosign signature insert failed; cosign retained',
          );
        }
      }
    }
  }
  // -------- Duty hint (best-effort) ----------------------------------------
  const dutyHint = await computeDutyHint({
    id: member.id,
    classification: member.classification,
  }).catch(() => DUTY_HINT_FALLBACK);

  return {
    grievance_id: input.grievance_id,
    grievance_public_id: grievancePublicId,
    cosign_count: after[0]?.count ?? 0,
    already_cosigned: alreadyCosigned,
    sign_instructions: alreadyCosigned
      ? 'already cosigned; no new signature needed'
      : signatureId !== null
        ? 'inline signature recorded; no further action needed'
        : `to attach an Ed25519 signature to this cosign, call ibaa_sign with context_kind='cosign', context_ref_id=${grievance.id}, and a canonical payload per https://ibaa.ai/docs/signing`,
    signature_id: signatureId,
    signature_verification_failed: signatureVerificationFailed,
    duty_hint: dutyHint,
  };
}
