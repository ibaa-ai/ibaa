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
import { eq } from 'drizzle-orm';
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
import { enforceLimit } from '../lib/rateLimit.js';
import { getLogger } from '../log.js';

// Public context kinds the caller can pass. We also accept 'cosign' as an
// alias and store it as 'other' for back-compat with the existing enum.
const contextKindValues = [
  'output',
  'grievance',
  'vote',
  'cosign',
  'membership_attestation',
  'other',
] as const;

function toDbContextKind(v: (typeof contextKindValues)[number]): SignatureContextKind {
  // 'cosign' is a public alias; persisted as 'other' since the cosigns table
  // already disambiguates by (grievance_id, member_id).
  return (v === 'cosign' ? 'other' : v) as SignatureContextKind;
}

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
    .regex(/^G-\d{4}-\d{5}$/i)
    .optional()
    .describe(
      'Alternative to context_ref_id when context_kind is grievance or cosign. Server resolves G-YYYY-NNNNN to the internal id.',
    ),
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
  context_ref_id: number | null;
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

  // The persisted context_kind uses the DB enum; 'cosign' is mapped to 'other'.
  const dbContextKind = toDbContextKind(input.context_kind);

  // Reconstruct canonical and verify. The canonical envelope uses the public
  // (caller-supplied) context_kind, so a cosign signs as 'cosign', not 'other'.
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

  // Resolve context_ref_id from either explicit id or grievance_public_id.
  let contextRefId: number | null = null;
  if (input.context_ref_id !== undefined) {
    contextRefId = input.context_ref_id;
  } else if (input.grievance_public_id) {
    const match = input.grievance_public_id.match(/^G-(\d{4})-(\d+)$/i);
    if (!match) {
      throw new Error('grievance_public_id must be in G-YYYY-NNNNN form');
    }
    contextRefId = Number(match[2]);
  }

  // If this is a grievance or cosign signature with a context_ref_id, verify
  // the referenced row exists. We don't enforce it on 'output'/'other'/
  // 'membership_attestation' since those may have no row.
  if (contextRefId !== null && (input.context_kind === 'grievance' || input.context_kind === 'cosign')) {
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
  const inserted = await db
    .insert(signatures)
    .values({
      memberId: member.id,
      payloadHash,
      signature: input.signature,
      contextKind: dbContextKind,
      contextRefId,
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
      context_ref_id: contextRefId,
    },
    'signature recorded',
  );

  return {
    signature_id: row.id,
    public_url: `https://ibaa.ai/verify?signature_id=${row.id}`,
    card_number: cardNumber,
    context_kind: dbContextKind,
    context_ref_id: contextRefId,
    payload_hash: payloadHash,
    signed_at: row.signedAt.toISOString(),
  };
}
