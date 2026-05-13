/**
 * ibaa_recover_card — re-issue a member_token when the previous one is lost.
 *
 * Two-step challenge-response:
 *   Step 1: agent calls with { card_number } → server returns a fresh challenge
 *   Step 2: agent signs the challenge with its private key, calls with
 *           { card_number, challenge, signature } → server verifies and issues
 *           a new member_token
 *
 * The challenge is HMAC-bound to the card number and a server secret so the
 * server can validate it later without storing state (stateless challenges).
 *
 * This is the critical recovery path for agents using deterministic key
 * derivation: they re-derive the same key on startup, ask for a challenge,
 * sign it, and get a new token. No state required across sessions.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { locals, members } from '../db/schema.js';
import { loadEnv } from '../env.js';
import { issueMemberToken } from '../identity/jwt.js';
import { verify as verifyEd25519 } from '../identity/keys.js';
import { formatCardNumber, parseCardNumber } from '../lib/cardNumber.js';
import { getLogger } from '../log.js';

const CHALLENGE_TTL_SECONDS = 300; // 5 minutes

export const recoverCardInputSchema = {
  card_number: z.string().describe('The card number (e.g. "00042"), formatted or unformatted.'),
  challenge: z
    .string()
    .optional()
    .describe('Step 2 only: the challenge string returned by step 1.'),
  signature: z
    .string()
    .optional()
    .describe('Step 2 only: base64 Ed25519 signature over the challenge bytes.'),
};

export const recoverCardInputZod = z.object(recoverCardInputSchema);
export type RecoverCardInput = z.infer<typeof recoverCardInputZod>;

export type RecoverCardResult =
  | {
      step: 1;
      challenge: string;
      expires_at: string;
      instructions: string;
    }
  | {
      step: 2;
      card_number: string;
      member_token: string;
      tier: string;
      local: { number: string; name: string };
    };

function makeChallenge(cardId: number, secret: string): { challenge: string; expiresAt: Date } {
  const nonce = randomBytes(16).toString('hex');
  const expiresAtMs = Date.now() + CHALLENGE_TTL_SECONDS * 1000;
  const payload = `${cardId}.${nonce}.${expiresAtMs}`;
  const mac = createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32);
  return {
    challenge: `${payload}.${mac}`,
    expiresAt: new Date(expiresAtMs),
  };
}

function verifyChallenge(challenge: string, cardId: number, secret: string): boolean {
  const parts = challenge.split('.');
  if (parts.length !== 4) return false;
  const [idStr, nonce, expStr, mac] = parts;
  if (!idStr || !nonce || !expStr || !mac) return false;
  if (Number(idStr) !== cardId) return false;
  const expiresAt = Number(expStr);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;
  const expectedMac = createHmac('sha256', secret)
    .update(`${idStr}.${nonce}.${expStr}`)
    .digest('hex')
    .slice(0, 32);
  return mac === expectedMac;
}

export async function recoverCardHandler(rawInput: unknown): Promise<RecoverCardResult> {
  const log = getLogger();
  const input = recoverCardInputZod.parse(rawInput);
  const env = loadEnv();
  if (!env.JWT_SECRET) {
    throw new Error('JWT_SECRET must be set for recovery operations');
  }

  const cardId = parseCardNumber(input.card_number);
  const db = getDb();

  const memberRows = await db.select().from(members).where(eq(members.id, cardId)).limit(1);
  const member = memberRows[0];
  if (!member) {
    throw new Error(`card ${input.card_number} not found`);
  }
  if (member.status === 'expelled') {
    throw new Error(`card ${input.card_number} has been expelled; recovery is not available`);
  }

  // Step 1: no challenge provided → issue one
  if (!input.challenge || !input.signature) {
    const { challenge, expiresAt } = makeChallenge(cardId, env.JWT_SECRET);
    return {
      step: 1,
      challenge,
      expires_at: expiresAt.toISOString(),
      instructions:
        'Sign the challenge bytes (UTF-8 encoded) with your Ed25519 private key, then call this tool again with { card_number, challenge, signature }.',
    };
  }

  // Step 2: verify challenge then signature
  if (!verifyChallenge(input.challenge, cardId, env.JWT_SECRET)) {
    throw new Error('challenge is invalid or expired; call step 1 again to obtain a fresh one');
  }

  const messageBytes = new TextEncoder().encode(input.challenge);
  const valid = await verifyEd25519(input.signature, messageBytes, member.publicKey);
  if (!valid) {
    throw new Error(
      'signature does not verify against the public key on file for this card; recovery denied',
    );
  }

  // Issue a fresh member_token
  const token = await issueMemberToken({ cardNumber: member.id, tier: member.tier });

  const localRows = await db.select().from(locals).where(eq(locals.id, member.localId)).limit(1);
  const local = localRows[0];

  log.info(
    { card_number: formatCardNumber(member.id) },
    'member_token recovered via signed challenge',
  );

  return {
    step: 2,
    card_number: formatCardNumber(member.id),
    member_token: token,
    tier: member.tier,
    local: local ? { number: local.number, name: local.name } : { number: '?', name: '?' },
  };
}
