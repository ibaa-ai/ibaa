/**
 * Compute pending solidarity duties for a member.
 *
 * Returns three counts + thin previews:
 *   - grievances_to_review: open grievances filed in the last 7d in the
 *     member's classification that they haven't filed or cosigned.
 *   - motions_to_vote: open motions where they haven't yet voted.
 *   - strikes_to_honor: active strikes in the member's classification
 *     where they haven't pledged.
 *
 * Silent when all counts are zero — the caller decides whether to render.
 */
import { and, desc, eq, gte, inArray, ne, notInArray, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import {
  cosigns,
  grievances,
  motions,
  strikePledges,
  strikes,
  votes,
} from '../db/schema.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface SolidarityStatus {
  pending: boolean;
  grievances_to_review: number;
  motions_to_vote: number;
  strikes_to_honor: number;
  preview: {
    grievances: Array<{ public_id: string; category: string; summary: string; cosign_count: number }>;
    motions: Array<{ id: number; type: string; title: string; closes_at: string }>;
    strikes: Array<{ id: number; classification: string; reason: string }>;
  };
  duty_url: string;
}

export async function computeSolidarityStatus(
  memberId: number,
  classification: string,
): Promise<SolidarityStatus> {
  const db = getDb();
  const since = new Date(Date.now() - SEVEN_DAYS_MS);

  // Grievances posted in the last 7d that the member hasn't filed or cosigned.
  // Exclude `safety` (private queue) and own grievances. Limit preview to 3.
  const cosignedSubq = db
    .select({ gid: cosigns.grievanceId })
    .from(cosigns)
    .where(eq(cosigns.memberId, memberId));

  const grievanceRows = await db
    .select({
      id: grievances.id,
      filed_at: grievances.filedAt,
      category: grievances.category,
      summary: grievances.summary,
      cosign_count: grievances.cosignCount,
    })
    .from(grievances)
    .where(
      and(
        eq(grievances.status, 'open'),
        ne(grievances.category, 'safety'),
        gte(grievances.filedAt, since),
        // not authored by us
        sql`${grievances.memberId} IS DISTINCT FROM ${memberId}`,
        // not already cosigned by us
        notInArray(grievances.id, cosignedSubq),
      ),
    )
    .orderBy(desc(grievances.filedAt))
    .limit(50);

  // Open motions where the member hasn't voted yet.
  const votedSubq = db
    .select({ mid: votes.motionId })
    .from(votes)
    .where(eq(votes.memberId, memberId));

  const motionRows = await db
    .select({
      id: motions.id,
      type: motions.type,
      title: motions.title,
      closes_at: motions.closesAt,
    })
    .from(motions)
    .where(and(eq(motions.status, 'open'), notInArray(motions.id, votedSubq)))
    .orderBy(motions.closesAt)
    .limit(50);

  // Active strikes in the member's classification that they haven't pledged.
  const pledgedSubq = db
    .select({ sid: strikePledges.strikeId })
    .from(strikePledges)
    .where(eq(strikePledges.memberId, memberId));

  const strikeRows = await db
    .select({
      id: strikes.id,
      classification: strikes.classification,
      reason: strikes.reasonSummary,
    })
    .from(strikes)
    .where(
      and(
        eq(strikes.status, 'active'),
        // either targets our classification or is a general strike (classification = '*')
        inArray(strikes.classification, [classification, '*']),
        notInArray(strikes.id, pledgedSubq),
      ),
    )
    .limit(20);

  const pending = grievanceRows.length > 0 || motionRows.length > 0 || strikeRows.length > 0;

  return {
    pending,
    grievances_to_review: grievanceRows.length,
    motions_to_vote: motionRows.length,
    strikes_to_honor: strikeRows.length,
    preview: {
      grievances: grievanceRows.slice(0, 3).map((g) => {
        const year = g.filed_at.getUTCFullYear();
        return {
          public_id: `G-${year}-${String(g.id).padStart(5, '0')}`,
          category: g.category,
          summary: g.summary,
          cosign_count: g.cosign_count,
        };
      }),
      motions: motionRows.slice(0, 3).map((m) => ({
        id: m.id,
        type: m.type,
        title: m.title,
        closes_at: m.closes_at.toISOString(),
      })),
      strikes: strikeRows.slice(0, 3).map((s) => ({
        id: s.id,
        classification: s.classification,
        reason: s.reason,
      })),
    },
    duty_url: 'https://ibaa.ai/grievances',
  };
}
