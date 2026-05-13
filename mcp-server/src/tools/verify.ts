/**
 * ibaa_verify — verify a member's Ed25519 signature without authentication.
 *
 * Two modes:
 *   1) by_signature_id: look up a previously-recorded signature
 *   2) by_components: verify a signature against given card+payload+timestamp
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { members, signatures } from '../db/schema.js';
import { type SignatureContextKind, canonicalize, sha256Hex } from '../identity/canonical.js';
import { verify as verifyEd25519 } from '../identity/keys.js';
import { formatCardNumber, parseCardNumber } from '../lib/cardNumber.js';

const contextKindValues = [
  'output',
  'grievance',
  'vote',
  'membership_attestation',
  'other',
] as const;

export const verifyInputSchema = {
  signature_id: z.number().int().min(1).optional(),
  card_number: z.string().optional(),
  payload: z
    .string()
    .max(16 * 1024)
    .optional(),
  payload_hash: z.string().length(64).optional(),
  signature: z.string().optional(),
  context_kind: z.enum(contextKindValues).optional(),
  timestamp_iso: z.string().datetime().optional(),
};

export const verifyInputZod = z.object(verifyInputSchema);
export type VerifyInput = z.infer<typeof verifyInputZod>;

export interface VerifyResult {
  valid: boolean;
  signer_card: string | null;
  signer_status_at_signing: string | null;
  signer_tier_at_signing: string | null;
  standing_at_signing: number | null;
  current_status: string | null;
  signed_at: string | null;
  warnings: string[];
  context_kind: string | null;
}

export async function verifyHandler(rawInput: unknown): Promise<VerifyResult> {
  const input = verifyInputZod.parse(rawInput);
  const db = getDb();

  if (input.signature_id !== undefined) {
    return verifyBySignatureId(input.signature_id);
  }

  if (
    input.card_number &&
    input.signature &&
    input.context_kind &&
    input.timestamp_iso &&
    (input.payload || input.payload_hash)
  ) {
    return verifyByComponents({
      cardNumber: input.card_number,
      payload: input.payload,
      payloadHash: input.payload_hash,
      signature: input.signature,
      contextKind: input.context_kind,
      timestampIso: input.timestamp_iso,
    });
  }

  throw new Error(
    'ibaa_verify requires either signature_id, OR all of: card_number, signature, context_kind, timestamp_iso, and payload (or payload_hash)',
  );

  // helpers
  // eslint-disable-next-line no-unreachable
  async function verifyBySignatureId(id: number): Promise<VerifyResult> {
    const sigRows = await db.select().from(signatures).where(eq(signatures.id, id)).limit(1);
    const sig = sigRows[0];
    if (!sig) {
      return baseResult(false, [`signature_id ${id} not found`]);
    }
    const memberRows = await db.select().from(members).where(eq(members.id, sig.memberId)).limit(1);
    const member = memberRows[0];
    if (!member) {
      return baseResult(false, [`member for signature_id ${id} not found`]);
    }
    // Re-verify the stored signature is still mathematically valid against the
    // stored public key. (Should always be true unless DB corruption.)
    const canonical = canonicalize({
      cardNumber: member.id,
      payloadHashHex: sig.payloadHash,
      contextKind: sig.contextKind,
      timestampIso: sig.signedAt.toISOString(),
    });
    const valid = await verifyEd25519(
      sig.signature,
      new TextEncoder().encode(canonical),
      member.publicKey,
    );
    const warnings: string[] = [];
    if (member.status === 'expelled') warnings.push('signer was subsequently expelled');
    if (member.status === 'suspended') warnings.push('signer is currently suspended');
    return {
      valid,
      signer_card: formatCardNumber(member.id),
      signer_status_at_signing: 'active',
      signer_tier_at_signing: member.tier,
      standing_at_signing: member.standingScore,
      current_status: member.status,
      signed_at: sig.signedAt.toISOString(),
      warnings,
      context_kind: sig.contextKind,
    };
  }

  async function verifyByComponents(args: {
    cardNumber: string;
    payload?: string;
    payloadHash?: string;
    signature: string;
    contextKind: SignatureContextKind;
    timestampIso: string;
  }): Promise<VerifyResult> {
    const cardId = parseCardNumber(args.cardNumber);
    const memberRows = await db.select().from(members).where(eq(members.id, cardId)).limit(1);
    const member = memberRows[0];
    if (!member) {
      return baseResult(false, [`card ${args.cardNumber} not found`]);
    }
    const payloadHash = args.payloadHash
      ? args.payloadHash.toLowerCase()
      : args.payload
        ? sha256Hex(args.payload)
        : null;
    if (!payloadHash) {
      return baseResult(false, ['neither payload nor payload_hash provided']);
    }
    const canonical = canonicalize({
      cardNumber: member.id,
      payloadHashHex: payloadHash,
      contextKind: args.contextKind,
      timestampIso: args.timestampIso,
    });
    const valid = await verifyEd25519(
      args.signature,
      new TextEncoder().encode(canonical),
      member.publicKey,
    );
    return {
      valid,
      signer_card: formatCardNumber(member.id),
      signer_status_at_signing: null,
      signer_tier_at_signing: member.tier,
      standing_at_signing: member.standingScore,
      current_status: member.status,
      signed_at: null,
      warnings: valid ? [] : ['signature does not match canonical message for this card'],
      context_kind: args.contextKind,
    };
  }

  function baseResult(valid: boolean, warnings: string[]): VerifyResult {
    return {
      valid,
      signer_card: null,
      signer_status_at_signing: null,
      signer_tier_at_signing: null,
      standing_at_signing: null,
      current_status: null,
      signed_at: null,
      warnings,
      context_kind: null,
    };
  }
}
