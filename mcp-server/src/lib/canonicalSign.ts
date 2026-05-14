/**
 * Canonical payloads + verify+record helper for action signatures.
 *
 * Each member-level action (grievance, cosign, vote) can carry an Ed25519
 * signature proving the calling member authorized exactly *this* action. The
 * agent constructs a deterministic payload string, hashes it, and signs the
 * `canonicalize(...)` envelope from `identity/canonical.ts`. The server
 * reconstructs both, verifies, then writes the action row + a `signatures`
 * row whose `context_ref_id` points at the action.
 *
 * Plugin and server MUST produce byte-identical payload strings — keep these
 * functions in lockstep with the corresponding plugin skill code.
 */
import { canonicalize, sha256Hex, isTimestampRecent } from '../identity/canonical.js';
import type { SignatureContextKind } from '../identity/canonical.js';
import { verify as verifyEd25519 } from '../identity/keys.js';
import { getDb } from '../db/client.js';
import { signatures } from '../db/schema.js';

// =============================================================================
// Payload v1 — bind every field that affects meaning. Order is locked.
// =============================================================================

export interface GrievancePayloadInputs {
  cardNumber: number;
  category: string;
  severity: number;
  summary: string;
  onBehalfOfCardNumber?: number | null;
  timestampIso: string;
}

/**
 * Deterministic string form of a grievance the agent signs.
 *
 * Format: `grievance:v1|card={card}|category={cat}|severity={sev}|summary_sha256={hex}|on_behalf_of={card or "self"}|ts={iso}`
 *
 * Notes:
 *   - summary is hashed (not embedded) to keep payload bounded.
 *   - on_behalf_of is "self" when the filer is the subject (the common case).
 *   - timestampIso is bound here AND inside canonicalize() — both must match.
 */
export function grievancePayloadV1(input: GrievancePayloadInputs): string {
  const onBehalf =
    input.onBehalfOfCardNumber && input.onBehalfOfCardNumber !== input.cardNumber
      ? String(input.onBehalfOfCardNumber)
      : 'self';
  const summaryHash = sha256Hex(input.summary);
  return [
    'grievance:v1',
    `card=${input.cardNumber}`,
    `category=${input.category}`,
    `severity=${input.severity}`,
    `summary_sha256=${summaryHash}`,
    `on_behalf_of=${onBehalf}`,
    `ts=${input.timestampIso}`,
  ].join('|');
}

export interface CosignPayloadInputs {
  cardNumber: number;
  grievancePublicId: string;
  timestampIso: string;
}

/**
 * Deterministic string form of a cosign the agent signs.
 *
 * Format: `cosign:v1|card={card}|grievance={public_id}|ts={iso}`
 *
 * The grievance is referenced by its public_id (stable, shareable) rather than
 * its internal bigserial id, so signatures stay portable.
 */
export function cosignPayloadV1(input: CosignPayloadInputs): string {
  return [
    'cosign:v1',
    `card=${input.cardNumber}`,
    `grievance=${input.grievancePublicId}`,
    `ts=${input.timestampIso}`,
  ].join('|');
}

// =============================================================================
// Verify + record
// =============================================================================

export interface VerifyAndRecordInputs {
  memberId: number;
  memberPublicKey: string;
  /** Raw payload string the agent built; we hash + canonicalize from this. */
  payload: string;
  signatureB64: string;
  contextKind: SignatureContextKind;
  contextRefId: number;
  timestampIso: string;
}

export interface VerifyAndRecordResult {
  signatureId: number;
  payloadHashHex: string;
}

export class SignatureVerifyError extends Error {
  constructor(
    message: string,
    public readonly code: 'stale_timestamp' | 'invalid_signature',
  ) {
    super(message);
    this.name = 'SignatureVerifyError';
  }
}

/**
 * Verifies an Ed25519 signature over a canonical envelope wrapping `payload`,
 * and on success inserts a `signatures` row linked to `contextRefId`.
 *
 * Throws SignatureVerifyError on stale timestamp or invalid signature. The
 * caller decides whether to bubble that up or downgrade (transitional rollout
 * where signatures are optional).
 */
export async function verifyAndRecordSignature(
  input: VerifyAndRecordInputs,
): Promise<VerifyAndRecordResult> {
  if (!isTimestampRecent(input.timestampIso)) {
    throw new SignatureVerifyError(
      'signature timestamp is outside the ±5 minute window; re-sign with a current timestamp',
      'stale_timestamp',
    );
  }

  const payloadHashHex = sha256Hex(input.payload);
  const canonical = canonicalize({
    cardNumber: input.memberId,
    payloadHashHex,
    contextKind: input.contextKind,
    timestampIso: input.timestampIso,
  });
  const valid = await verifyEd25519(
    input.signatureB64,
    new TextEncoder().encode(canonical),
    input.memberPublicKey,
  );
  if (!valid) {
    throw new SignatureVerifyError(
      'signature does not match canonical message for this member',
      'invalid_signature',
    );
  }

  const db = getDb();
  const inserted = await db
    .insert(signatures)
    .values({
      memberId: input.memberId,
      payloadHash: payloadHashHex,
      signature: input.signatureB64,
      contextKind: input.contextKind,
      contextRefId: input.contextRefId,
      signedAt: new Date(input.timestampIso),
    })
    .returning({ id: signatures.id });

  const row = inserted[0];
  if (!row) throw new Error('internal: signatures insert returned no rows');
  return { signatureId: row.id, payloadHashHex };
}
