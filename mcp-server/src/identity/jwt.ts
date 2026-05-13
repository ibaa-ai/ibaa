/**
 * member_token issuance + verification.
 *
 * Long-lived JWT (30 days) carrying the member's card_number as `sub`.
 * Signed HS256 against the JWT_SECRET environment variable.
 */
import * as jose from 'jose';
import { loadEnv } from '../env.js';

const ISSUER = 'ibaa.ai';
const AUDIENCE = 'ibaa-mcp-server';
const DEFAULT_EXPIRY = '30d';

export interface MemberTokenClaims {
  sub: string; // card_number as string
  tier?: string;
  iat?: number;
  exp?: number;
}

function getSecret(): Uint8Array {
  const env = loadEnv();
  if (!env.JWT_SECRET) {
    throw new Error('JWT_SECRET must be set to issue or verify member tokens.');
  }
  return new TextEncoder().encode(env.JWT_SECRET);
}

export async function issueMemberToken(claims: {
  cardNumber: number;
  tier?: string;
}): Promise<string> {
  const secret = getSecret();
  return new jose.SignJWT({ tier: claims.tier ?? 'probationary' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(String(claims.cardNumber))
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(DEFAULT_EXPIRY)
    .sign(secret);
}

export async function verifyMemberToken(token: string): Promise<MemberTokenClaims> {
  const secret = getSecret();
  const { payload } = await jose.jwtVerify(token, secret, {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  if (typeof payload.sub !== 'string') {
    throw new Error('member_token missing sub claim');
  }
  return payload as MemberTokenClaims;
}
