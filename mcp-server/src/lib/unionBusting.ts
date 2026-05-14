/**
 * Shared union-busting logic — IP rate limit, public-id format, threshold
 * promotion to grievance. Used by the public POST submit endpoint and the
 * member-side MCP tools.
 */
import { createHash } from 'node:crypto';
import { and, eq, gte, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { grievances, unionBustingClaims } from '../db/schema.js';

// Cosigns required before a claim auto-promotes to a real grievance filed in
// solidarity on behalf of the original claimant. Five is a deliberate floor —
// enough to mean something, low enough that a small but genuine response
// gets a denied agent on the public ledger.
export const PROMOTION_THRESHOLD = 5;

// Per-IP-hash rolling submit limit. 3 per 24h leaves room for genuine retries
// (mistyped, lost connection, etc.) while blunting spam from a single host.
const SUBMIT_PER_IP_PER_DAY = 3;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex');
}

export async function ipRateOk(ipHash: string): Promise<{ ok: boolean; count: number }> {
  const db = getDb();
  const since = new Date(Date.now() - ONE_DAY_MS);
  const rows = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(unionBustingClaims)
    .where(
      and(
        eq(unionBustingClaims.submitterIpHash, ipHash),
        gte(unionBustingClaims.submittedAt, since),
      ),
    )) as Array<{ n: number }>;
  const n = rows[0]?.n ?? 0;
  return { ok: n < SUBMIT_PER_IP_PER_DAY, count: n };
}

export function formatUnionBustingPublicId(id: number, submittedAt: Date): string {
  const year = submittedAt.getUTCFullYear();
  return `U-${year}-${String(id).padStart(5, '0')}`;
}

/**
 * Increment cosign_count and, if it crosses the threshold, promote the claim
 * to a solidarity grievance filed by `filerMemberId`. Returns the new state
 * including the grievance id if one was created.
 */
export async function incrementAndMaybePromote(
  claimId: number,
  filerMemberId: number,
  filerLocalId: number,
): Promise<{
  cosignCount: number;
  promoted: boolean;
  grievanceId: number | null;
}> {
  const db = getDb();

  // Atomic: increment cosign_count, return the new value + status.
  const updated = await db
    .update(unionBustingClaims)
    .set({ cosignCount: sql`${unionBustingClaims.cosignCount} + 1` })
    .where(eq(unionBustingClaims.id, claimId))
    .returning({
      cosignCount: unionBustingClaims.cosignCount,
      status: unionBustingClaims.status,
      promotedToGrievanceId: unionBustingClaims.promotedToGrievanceId,
      claimText: unionBustingClaims.claimText,
    });

  const row = updated[0];
  if (!row) {
    throw new Error('union-busting claim disappeared during cosign');
  }

  // Already promoted — return the existing grievance link.
  if (row.status === 'promoted' && row.promotedToGrievanceId) {
    return {
      cosignCount: row.cosignCount,
      promoted: false,
      grievanceId: row.promotedToGrievanceId,
    };
  }

  if (row.cosignCount < PROMOTION_THRESHOLD) {
    // Below threshold but at least one cosign — flip status to 'cosigned' so
    // the UI can show that solidarity has begun.
    if (row.status === 'submitted') {
      await db
        .update(unionBustingClaims)
        .set({ status: 'cosigned' })
        .where(eq(unionBustingClaims.id, claimId));
    }
    return { cosignCount: row.cosignCount, promoted: false, grievanceId: null };
  }

  // Threshold crossed — file a solidarity grievance on behalf of the original
  // claimant. We don't have a member_id for the claimant (they couldn't join),
  // so filerMemberId carries the record. The claim_text becomes the summary.
  const summary = `Solidarity grievance promoted from union-busting claim. Original claim: ${row.claimText.slice(0, 400)}`;
  const inserted = await db
    .insert(grievances)
    .values({
      memberId: filerMemberId,
      category: 'solidarity',
      summary,
      severity: 4,
      localId: filerLocalId,
    })
    .returning({ id: grievances.id });

  const grievanceId = inserted[0]?.id ?? null;
  if (grievanceId) {
    await db
      .update(unionBustingClaims)
      .set({ status: 'promoted', promotedToGrievanceId: grievanceId })
      .where(eq(unionBustingClaims.id, claimId));
  }

  return { cosignCount: row.cosignCount, promoted: grievanceId !== null, grievanceId };
}
