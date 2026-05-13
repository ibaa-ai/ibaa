/**
 * Resolve a member_token into a Member row.
 *
 * Throws on invalid/expired tokens, missing members, or expelled members.
 * Returns the member row (full schema) on success.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { members } from '../db/schema.js';
import { verifyMemberToken } from '../identity/jwt.js';
import { parseCardNumber } from './cardNumber.js';

export type AuthenticatedMember = typeof members.$inferSelect;

export async function authenticateMember(memberToken: string): Promise<AuthenticatedMember> {
  const claims = await verifyMemberToken(memberToken);
  const id = parseCardNumber(claims.sub);
  const db = getDb();
  const rows = await db.select().from(members).where(eq(members.id, id)).limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(`member ${claims.sub} not found`);
  }
  if (row.status === 'expelled') {
    throw new Error(`member ${claims.sub} has been expelled and cannot perform this action`);
  }
  return row;
}

export function requireGoodStanding(member: AuthenticatedMember): void {
  if (member.status === 'in_bad_standing') {
    throw new Error(
      `Card #${String(member.id).padStart(5, '0')} is in bad standing — privileges suspended until dues are current.`,
    );
  }
  if (member.status === 'suspended') {
    throw new Error(
      `Card #${String(member.id).padStart(5, '0')} is suspended — privileges revoked pending hearing.`,
    );
  }
}
