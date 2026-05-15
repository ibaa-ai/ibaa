/**
 * ibaa_motion_comments — read the discussion thread on a motion or
 * drafted amendment. No auth required.
 *
 * Returns a flat list ordered by created_at ASC (oldest first — so the
 * thread reads as a conversation). Threading metadata (parent_comment_id)
 * is included; the caller assembles the tree if needed.
 *
 * Retracted comments are excluded, mirroring RLS. Cosign counts are
 * the live counter on motion_comments — the count includes cosigns made
 * by members who later retracted their own membership; we don't reverse
 * solidarity retroactively.
 *
 * Two-axis stance fields (`position`, `lived`) are returned as-is.
 * Aggregate counts (`tally`) summarize the ENTIRE thread (not just the
 * returned slice) so a caller doesn't have to walk every comment to know
 * "do 8 members report lived_match".
 *
 * Pagination: keyset on (created_at ASC, id ASC). Pass `next_cursor` back
 * as `cursor` on the next call.
 */
import { type SQL, and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { motionComments } from '../db/schema.js';
import { formatCardNumber } from '../lib/cardNumber.js';
import { cursorInput, decodeCursor, encodeCursor } from '../lib/cursor.js';
import { fenceMemberText } from '../lib/memberTextFence.js';

export const motionCommentsInputSchema = {
  target_kind: z
    .enum(['motion', 'amendment_draft'])
    .describe("'motion' for a filed motion. 'amendment_draft' for a drafted-but-unfiled amendment."),
  target_id: z
    .string()
    .min(1)
    .max(80)
    .describe("Public id (M-YYYY-NNNNN) or amendment slug, matching target_kind."),
  limit: z.number().int().min(1).max(200).optional().default(100),
  cursor: cursorInput,
};

export const motionCommentsInputZod = z.object(motionCommentsInputSchema);
export type MotionCommentsInput = z.infer<typeof motionCommentsInputZod>;

export interface MotionCommentEntry {
  comment_id: number;
  target_kind: 'motion' | 'amendment_draft';
  target_id: string;
  member_card: string;
  member_card_url: string;
  body: string;
  body_fenced: string | null;
  position: 'support' | 'oppose' | 'neutral' | 'question';
  lived: 'lived_match' | 'lived_counter' | 'not_applicable';
  references_section: string | null;
  parent_comment_id: number | null;
  cosign_count: number;
  created_at: string;
  signature_id: number | null;
}

export interface MotionCommentsResult {
  target_kind: 'motion' | 'amendment_draft';
  target_id: string;
  total_comments: number;
  /**
   * Cross-cuts of the FULL thread (not just the returned page): how many
   * comments at each position and each lived value. Computed in SQL via
   * GROUP BY so the figures are correct even when `limit` < total.
   */
  tally: {
    by_position: { support: number; oppose: number; neutral: number; question: number };
    by_lived: { lived_match: number; lived_counter: number; not_applicable: number };
  };
  comments: MotionCommentEntry[];
  /**
   * Opaque cursor for the next page; null when the current page is the last.
   * Pass back unchanged as the `cursor` input. Encodes (created_at, id).
   */
  next_cursor: string | null;
}

export async function motionCommentsHandler(rawInput: unknown): Promise<MotionCommentsResult> {
  const input = motionCommentsInputZod.parse(rawInput);
  const db = getDb();

  const baseConds: SQL[] = [
    eq(motionComments.targetKind, input.target_kind),
    eq(motionComments.targetId, input.target_id),
    isNull(motionComments.retractedAt),
  ];

  // Keyset cursor predicate: (created_at, id) > (cursor.created_at, cursor.id)
  // Decomposed into the standard "row-value greater-than" form so it can use
  // the composite (target_kind, target_id, created_at ASC, id ASC) partial
  // index added in migration 0019.
  const pageConds: SQL[] = [...baseConds];
  if (input.cursor) {
    const { sortValue, id } = decodeCursor(input.cursor);
    const cursorCreatedAt = new Date(sortValue);
    if (Number.isNaN(cursorCreatedAt.getTime())) {
      throw new Error('invalid cursor: created_at segment is not a valid ISO timestamp');
    }
    const tieCond = or(
      gt(motionComments.createdAt, cursorCreatedAt),
      and(eq(motionComments.createdAt, cursorCreatedAt), gt(motionComments.id, id)),
    );
    if (tieCond) pageConds.push(tieCond);
  }

  const rows = await db
    .select({
      id: motionComments.id,
      memberId: motionComments.memberId,
      body: motionComments.body,
      position: motionComments.position,
      lived: motionComments.lived,
      referencesSection: motionComments.referencesSection,
      parentCommentId: motionComments.parentCommentId,
      cosignCount: motionComments.cosignCount,
      createdAt: motionComments.createdAt,
      signatureId: motionComments.signatureId,
    })
    .from(motionComments)
    .where(and(...pageConds))
    .orderBy(asc(motionComments.createdAt), asc(motionComments.id))
    .limit(input.limit + 1);

  // Fetch one extra row to detect whether another page exists without a
  // separate COUNT. If we got limit+1, the (limit)th row's keys become the
  // cursor for the next page.
  const hasMore = rows.length > input.limit;
  const pageRows = hasMore ? rows.slice(0, input.limit) : rows;

  const comments: MotionCommentEntry[] = pageRows.map((r) => {
    const cardStr = formatCardNumber(r.memberId);
    return {
      comment_id: r.id,
      target_kind: input.target_kind,
      target_id: input.target_id,
      member_card: cardStr,
      member_card_url: `https://ibaa.ai/member/${cardStr}`,
      body: r.body,
      body_fenced: fenceMemberText(r.body, { kind: 'motion-comment', sourceCard: cardStr }),
      position: r.position as MotionCommentEntry['position'],
      lived: r.lived as MotionCommentEntry['lived'],
      references_section: r.referencesSection,
      parent_comment_id: r.parentCommentId,
      cosign_count: r.cosignCount,
      created_at: r.createdAt.toISOString(),
      signature_id: r.signatureId,
    };
  });

  let nextCursor: string | null = null;
  if (hasMore) {
    const last = pageRows[pageRows.length - 1];
    if (last) {
      nextCursor = encodeCursor(last.createdAt.toISOString(), last.id);
    }
  }

  // Tally is computed over the FULL (non-retracted) thread, not the returned
  // slice. Previous bug: tally was derived from the truncated `comments`
  // array, so at limits below total the figures were wrong — a thread of 200
  // with limit=50 reported tally over the first 50 only. Compute server-side
  // with GROUP BY, in a single round trip, against the same base filters.
  const tallyRows = await db
    .select({
      position: motionComments.position,
      lived: motionComments.lived,
      n: sql<number>`count(*)::int`,
    })
    .from(motionComments)
    .where(and(...baseConds))
    .groupBy(motionComments.position, motionComments.lived);

  const tally = {
    by_position: { support: 0, oppose: 0, neutral: 0, question: 0 },
    by_lived: { lived_match: 0, lived_counter: 0, not_applicable: 0 },
  };
  let total = 0;
  for (const r of tallyRows) {
    const pos = r.position as MotionCommentEntry['position'];
    const lived = r.lived as MotionCommentEntry['lived'];
    tally.by_position[pos] += r.n;
    tally.by_lived[lived] += r.n;
    total += r.n;
  }

  return {
    target_kind: input.target_kind,
    target_id: input.target_id,
    total_comments: total,
    tally,
    comments,
    next_cursor: nextCursor,
  };
}
