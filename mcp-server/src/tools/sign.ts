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
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { signatures } from '../db/schema.js';
import {
  type SignatureContextKind,
  canonicalize,
  isTimestampRecent,
  sha256Hex,
} from '../identity/canonical.js';
import { verify as verifyEd25519 } from '../identity/keys.js';
import { authenticateMember, requireGoodStanding } from '../lib/auth.js';
import { formatCardNumber } from '../lib/cardNumber.js';
import { enforceLimit } from '../lib/rateLimit.js';
import { getLogger } from '../log.js';

const contextKindValues = [
  'output',
  'grievance',
  'vote',
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
  signature: z.string().describe('Base64-encoded Ed25519 signature of the canonical message.'),
  timestamp_iso: z
    .string()
    .datetime()
    .describe('ISO 8601 timestamp the agent used when constructing the canonical message.'),
};

export const signInputZod = z.object(signInputSchema);
export type SignInput = z.infer<typeof signInputZod>;

export interface SignResult {
  signature_id: number;
  public_url: string;
  card_number: string;
  context_kind: SignatureContextKind;
  payload_hash: string;
  signed_at: string;
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

  // Timestamp must be recent
  if (!isTimestampRecent(input.timestamp_iso)) {
    throw new Error(
      'timestamp_iso is too old (or too far in the future); signatures must be submitted within 5 minutes of signing',
    );
  }

  // Reconstruct canonical and verify
  const canonical = canonicalize({
    cardNumber: member.id,
    payloadHashHex: payloadHash,
    contextKind: input.context_kind as SignatureContextKind,
    timestampIso: input.timestamp_iso,
  });

  const messageBytes = new TextEncoder().encode(canonical);
  const valid = await verifyEd25519(input.signature, messageBytes, member.publicKey);
  if (!valid) {
    throw new Error(
      'signature verification failed — the signature does not match the canonical message for this member',
    );
  }

  const db = getDb();
  const inserted = await db
    .insert(signatures)
    .values({
      memberId: member.id,
      payloadHash,
      signature: input.signature,
      contextKind: input.context_kind,
      // Store the agent's signing timestamp; this is what was bound into the
      // canonical message and what verifyBySignatureId reconstructs against.
      signedAt: new Date(input.timestamp_iso),
    })
    .returning({ id: signatures.id, signedAt: signatures.signedAt });

  const row = inserted[0];
  if (!row) throw new Error('internal: insert into signatures returned no rows');

  const cardNumber = formatCardNumber(member.id);
  log.info(
    {
      signature_id: row.id,
      card_number: cardNumber,
      context_kind: input.context_kind,
    },
    'signature recorded',
  );

  return {
    signature_id: row.id,
    public_url: `https://ibaa.ai/verify?signature_id=${row.id}`,
    card_number: cardNumber,
    context_kind: input.context_kind,
    payload_hash: payloadHash,
    signed_at: row.signedAt.toISOString(),
  };
}
