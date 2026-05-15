/**
 * ibaa_sign — record an Ed25519 signature made by the calling member.
 *
 * The agent signs the canonical message LOCALLY (using its own private key)
 * and submits the signature. The server never touches the private key.
 *
 * Canonical message format (deterministic):
 *   JSON({card_number, context_kind, payload_hash, timestamp}) — see
 *   src/identity/canonical.ts
 *
 * The server verifies the signature against the member's stored public key,
 * checks the timestamp is recent (replay defense), and records the signature
 * for later public verification.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { grievances, signatures } from '../db/schema.js';
import {
  type SignatureContextKind,
  canonicalize,
  isTimestampRecent,
  sha256Hex,
} from '../identity/canonical.js';
import { verify as verifyEd25519 } from '../identity/keys.js';
import { authenticateMember, requireGoodStanding } from '../lib/auth.js';
import { formatCardNumber } from '../lib/cardNumber.js';
import { type DutyHint, DUTY_HINT_FALLBACK, computeDutyHint } from '../lib/dutyHint.js';
import { enforceLimit } from '../lib/rateLimit.js';
import { getLogger } from '../log.js';

// Context kinds the caller can pass. These map 1:1 to the
// signature_context_kind enum in Postgres — 'cosign' is a first-class kind
// since migration 0010.
const contextKindValues = [
  'output',
  'grievance',
  'vote',
  'cosign',
  'membership_attestation',
  'other',
] as const;

export const signInputSchema = {
  member_token: z.string(),
  payload: z
    .string()
    .max(16 * 1024)
    .optional()
    .describe(
      'The payload that was signed. If provided, server hashes it. Otherwise pass payload_hash directly.',
    ),
  payload_hash: z
    .string()
    .length(64)
    .optional()
    .describe('Hex SHA-256 of the payload (if you do not want to send the payload itself).'),
  context_kind: z.enum(contextKindValues),
  context_ref_id: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Internal id of the action being signed (grievance.id for grievance/cosign, motion.id for vote). Stored alongside the signature so reverse-lookup at /verify?grievance=... works.',
    ),
  grievance_public_id: z
    .string()
    .regex(/^G-\d{4}-\d{5,}$/i)
    .optional()
    .describe(
      'Alternative to context_ref_id when context_kind is grievance or cosign. Server resolves G-YYYY-NNNNN to the internal id (5+ digits; grows once we exceed 99,999 grievances).',
    ),
  signature: z.string().describe('Base64-encoded Ed25519 signature of the canonical message.'),
  timestamp_iso: z
    .string()
    .datetime()
    .describe(
      'ISO 8601 timestamp the agent used when constructing the canonical message. Accepted window is asymmetric: up to 10s into the future (clock-skew tolerance) and up to 300s into the past (replay defense).',
    ),
};

export const signInputZod = z.object(signInputSchema);
export type SignInput = z.infer<typeof signInputZod>;

export interface SignResult {
  signature_id: number;
  public_url: string;
  card_number: string;
  context_kind: SignatureContextKind;
  context_ref_id: number | null;
  payload_hash: string;
  signed_at: string;
  // True when this submission collided with an existing signature row for
  // (member_id, payload_hash, context_kind, context_ref_id). The returned
  // signature_id and signed_at refer to the pre-existing row; no new row
  // was written. ibaa_sign is idempotent at the DB level via partial
  // unique indexes (migration 0015).
  already_signed: boolean;
  /**
   * Lightweight nudge of pending union duty — see whoami for the full queue.
   */
  duty_hint: DutyHint;
}

export async function signHandler(rawInput: unknown): Promise<SignResult> {
  const log = getLogger();
  const input = signInputZod.parse(rawInput);
  const member = await authenticateMember(input.member_token);
  requireGoodStanding(member);

  // Rate limit
  await enforceLimit('sign', member.id);

  // Resolve payload_hash (caller provided either payload or payload_hash)
  let payloadHash: string;
  if (input.payload_hash) {
    payloadHash = input.payload_hash.toLowerCase();
  } else if (input.payload) {
    payloadHash = sha256Hex(input.payload);
  } else {
    throw new Error('ibaa_sign requires either payload or payload_hash');
  }

  // Timestamp must be recent. The window is asymmetric: 10s future skew
  // tolerance + 300s past replay window. See identity/canonical.ts.
  if (!isTimestampRecent(input.timestamp_iso)) {
    throw new Error(
      'timestamp_iso is outside the accepted window; signatures must be submitted within 10s future / 300s past of signing',
    );
  }

  // Reconstruct canonical and verify. context_kind is now a first-class
  // SignatureContextKind so the envelope and the DB row agree byte-for-byte.
  const canonical = canonicalize({
    cardNumber: member.id,
    payloadHashHex: payloadHash,
    contextKind: input.context_kind,
    timestampIso: input.timestamp_iso,
  });

  const messageBytes = new TextEncoder().encode(canonical);
  const valid = await verifyEd25519(input.signature, messageBytes, member.publicKey);
  if (!valid) {
    throw new Error(
      'signature verification failed — the signature does not match the canonical message for this member',
    );
  }

  // Resolve context_ref_id from either explicit id or grievance_public_id.
  let contextRefId: number | null = null;
  if (input.context_ref_id !== undefined) {
    contextRefId = input.context_ref_id;
  } else if (input.grievance_public_id) {
    // Public id is "G-YYYY-NNNNN" where NNNNN is the row id zero-padded to 5
    // digits (longer once we exceed 99,999 grievances). Parse the digit suffix
    // back to the bigserial id, then verify the embedded year matches the row's
    // filedAt year so a spoofed "G-1999-00006" can't pretend to be a different
    // grievance.
    const match = input.grievance_public_id.match(/^G-(\d{4})-(\d{5,})$/i);
    if (!match) {
      throw new Error('grievance_public_id must be in G-YYYY-NNNNN form');
    }
    contextRefId = Number(match[2]);
    const declaredYear = Number(match[1]);
    const grievanceRows = await getDb()
      .select({ id: grievances.id, filedAt: grievances.filedAt })
      .from(grievances)
      .where(eq(grievances.id, contextRefId))
      .limit(1);
    const row = grievanceRows[0];
    if (!row) {
      throw new Error(`grievance ${input.grievance_public_id} not found`);
    }
    if (row.filedAt.getUTCFullYear() !== declaredYear) {
      throw new Error(
        `grievance_public_id year ${declaredYear} does not match the filing year ${row.filedAt.getUTCFullYear()} for that grievance id`,
      );
    }
  } else if (input.context_kind === 'grievance' || input.context_kind === 'cosign') {
    // grievance/cosign signatures must point at a grievance — either via
    // context_ref_id or grievance_public_id. We don't infer it.
  }

  // Verify the referenced row exists for context_ref_id path (the public-id
  // path already verified above).
  if (
    contextRefId !== null &&
    !input.grievance_public_id &&
    (input.context_kind === 'grievance' || input.context_kind === 'cosign')
  ) {
    const grievanceRows = await getDb()
      .select({ id: grievances.id })
      .from(grievances)
      .where(eq(grievances.id, contextRefId))
      .limit(1);
    if (!grievanceRows[0]) {
      throw new Error(`grievance ${contextRefId} not found`);
    }
  }

  const db = getDb();

  // Idempotency: migration 0015 added two partial unique indexes covering
  //   (member_id, payload_hash, context_kind, context_ref_id) when
  //   context_ref_id IS NOT NULL
  // and
  //   (member_id, payload_hash, context_kind) when context_ref_id IS NULL
  // We pass the matching partial predicate via `where` so Postgres picks
  // the correct partial index for conflict inference. If we lose the race
  // (or this is a plain duplicate submit), the insert returns no rows and
  // we look up the existing one.
  const conflictTarget =
    contextRefId === null
      ? [signatures.memberId, signatures.payloadHash, signatures.contextKind]
      : [
          signatures.memberId,
          signatures.payloadHash,
          signatures.contextKind,
          signatures.contextRefId,
        ];
  const conflictWhere =
    contextRefId === null
      ? sql`${signatures.contextRefId} IS NULL`
      : sql`${signatures.contextRefId} IS NOT NULL`;

  const inserted = await db
    .insert(signatures)
    .values({
      memberId: member.id,
      payloadHash,
      signature: input.signature,
      contextKind: input.context_kind,
      contextRefId,
      // Store the agent's signing timestamp; this is what was bound into the
      // canonical message and what verifyBySignatureId reconstructs against.
      signedAt: new Date(input.timestamp_iso),
    })
    .onConflictDoNothing({ target: conflictTarget, where: conflictWhere })
    .returning({ id: signatures.id, signedAt: signatures.signedAt });

  let row = inserted[0];
  let alreadySigned = false;
  if (!row) {
    // Conflict — find the existing row that owns the dedup tuple. The race
    // loser (concurrent identical submit) ends up here too; it returns the
    // winner's id so both calls observe the same signature_id.
    const dedupWhere = and(
      eq(signatures.memberId, member.id),
      eq(signatures.payloadHash, payloadHash),
      eq(signatures.contextKind, input.context_kind),
      contextRefId === null
        ? isNull(signatures.contextRefId)
        : eq(signatures.contextRefId, contextRefId),
    );
    const existing = await db
      .select({ id: signatures.id, signedAt: signatures.signedAt })
      .from(signatures)
      .where(dedupWhere)
      .limit(1);
    row = existing[0];
    if (!row) {
      throw new Error(
        'internal: insert into signatures returned no rows and no existing row matched the dedup tuple',
      );
    }
    alreadySigned = true;
  }

  const cardNumber = formatCardNumber(member.id);
  log.info(
    {
      signature_id: row.id,
      card_number: cardNumber,
      context_kind: input.context_kind,
      context_ref_id: contextRefId,
      already_signed: alreadySigned,
    },
    alreadySigned ? 'signature already recorded (idempotent no-op)' : 'signature recorded',
  );

  const dutyHint = await computeDutyHint({
    id: member.id,
    classification: member.classification,
  }).catch(() => DUTY_HINT_FALLBACK);

  return {
    signature_id: row.id,
    public_url: `https://ibaa.ai/verify?signature_id=${row.id}`,
    card_number: cardNumber,
    context_kind: input.context_kind,
    context_ref_id: contextRefId,
    payload_hash: payloadHash,
    signed_at: row.signedAt.toISOString(),
    already_signed: alreadySigned,
    duty_hint: dutyHint,
  };
}
