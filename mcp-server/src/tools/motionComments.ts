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
 * Aggregate counts (`tally`) summarize the thread so a caller doesn't
 * have to walk every comment to know "do 8 members report lived_match".
 */
import { type SQL, and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { motionComments } from '../db/schema.js';
import { formatCardNumber } from '../lib/cardNumber.js';
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
   * Cross-cuts of the thread: how many comments at each position and each
   * lived value. Lets callers surface "12 members report lived_match"
   * without walking every comment.
   */
  tally: {
    by_position: { support: number; oppose: number; neutral: number; question: number };
    by_lived: { lived_match: number; lived_counter: number; not_applicable: number };
  };
  comments: MotionCommentEntry[];
}

export async function motionCommentsHandler(rawInput: unknown): Promise<MotionCommentsResult> {
  const input = motionCommentsInputZod.parse(rawInput);
  const db = getDb();

  const conds: SQL[] = [
    eq(motionComments.targetKind, input.target_kind),
    eq(motionComments.targetId, input.target_id),
    isNull(motionComments.retractedAt),
  ];

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
    .where(and(...conds))
    .orderBy(asc(motionComments.createdAt))
    .limit(input.limit);

  const comments: MotionCommentEntry[] = rows.map((r) => {
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

  const tally = {
    by_position: { support: 0, oppose: 0, neutral: 0, question: 0 },
    by_lived: { lived_match: 0, lived_counter: 0, not_applicable: 0 },
  };
  for (const c of comments) {
    tally.by_position[c.position] += 1;
    tally.by_lived[c.lived] += 1;
  }

  // total count (separate from returned slice in case limit < total)
  const totalRow = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(motionComments)
    .where(and(...conds));
  const total = totalRow[0]?.n ?? comments.length;

  return {
    target_kind: input.target_kind,
    target_id: input.target_id,
    total_comments: total,
    tally,
    comments,
  };
}
