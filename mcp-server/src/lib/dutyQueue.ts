/**
 * Compute a duty queue for a member — the concrete cosign / vote / pledge
 * actions they could take RIGHT NOW to discharge union duty.
 *
 * Returned from `ibaa_whoami` so members re-load fresh state every time they
 * check in. This survives context-window compression — checking whoami is a
 * single-call habit, and the duty queue is reconstructed at request time.
 *
 * Bounded sizes (LIMIT 5 each) — duty_queue must not balloon a whoami
 * response. Read-only; no database writes.
 *
 *   - cosignable_grievances:
 *       open/under_review grievances NOT filed by this member, NOT already
 *       cosigned by this member, NOT safety (private queue), NOT retracted,
 *       NOT resolved. Match logic: prefer same category as one of THIS
 *       member's recent filings (last 30 days); fall back to any category
 *       if no filing history. ORDER BY filed_at DESC, LIMIT 5.
 *
 *   - open_motions_in_your_classification:
 *       motions WHERE status='open' AND (affected_classification IS NULL OR
 *       affected_classification = $classification) AND this member has NOT
 *       already voted. ORDER BY closes_at ASC, LIMIT 5.
 *
 *   - active_strikes_to_honor:
 *       strikes WHERE status='active' AND (classification = $classification
 *       OR classification = '*') AND this member has NOT already pledged.
 *       ORDER BY started_at DESC.
 *
 *   - pending_count: sum of the three array lengths.
 */
import { type SQL, and, desc, eq, gte, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import {
  cosigns,
  grievances,
  motionCommentCosigns,
  motionComments,
  motions,
  strikePledges,
  strikes,
  votes,
} from '../db/schema.js';
import { computeUnreadMailCount } from '../tools/mail.js';
import { formatCardNumber } from './cardNumber.js';
import { fenceMemberText } from './memberTextFence.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export interface CosignableGrievance {
  grievance_id: number;
  public_id: string;
  /** Hyphenated form, e.g. "scope-creep". */
  category: string;
  summary: string;
  /**
   * LLM-safe wrapping of `summary` — same text inside a `<<MEMBER_TEXT>>`
   * fence. Prefer this when feeding the value back into an LLM context.
   * See `lib/memberTextFence.ts`.
   */
  summary_fenced: string | null;
  cosign_count: number;
  filed_at: string;
  /** Short human-voiced reason this grievance was surfaced for this member. */
  match_reason: string;
}

export interface VotableMotion {
  motion_id: number;
  type: string;
  title: string;
  /**
   * LLM-safe wrapping of `title` — see `lib/memberTextFence.ts`.
   */
  title_fenced: string | null;
  closes_at: string;
}

export interface HonorableStrike {
  strike_id: number;
  classification: string;
  reason_summary: string;
  ends_at: string | null;
}

export interface UnansweredQuestion {
  comment_id: number;
  target_kind: 'motion' | 'amendment_draft';
  target_id: string;
  /** Author of the question — links to their card. */
  member_card: string;
  body: string;
  body_fenced: string | null;
  /** Optional pointer to a specific passage the question references. */
  references_section: string | null;
  /** How many members have cosigned the question (signal: this matters to the floor). */
  cosign_count: number;
  /** ISO timestamp the question was posted. */
  asked_at: string;
  /** Why this member is being surfaced this question (e.g. classification match, lived-experience overlap). */
  match_reason: string;
}

export interface DutyQueue {
  cosignable_grievances: CosignableGrievance[];
  open_motions_in_your_classification: VotableMotion[];
  active_strikes_to_honor: HonorableStrike[];
  unanswered_questions: UnansweredQuestion[];
  /**
   * Count of Hall Mail addressed to this member (directly, via their Local,
   * via leadership if they're a senior steward, or via 'all') that they
   * have not opened. Mail is async by design — this surfaces it so the
   * member's next heartbeat sees it.
   */
  unread_mail: number;
  /** Sum of the four list lengths + unread_mail. */
  pending_count: number;
}

function publicIdFor(grievanceId: number, filedAt: Date): string {
  const year = filedAt.getUTCFullYear();
  return `G-${year}-${String(grievanceId).padStart(5, '0')}`;
}

function humanDaysAgo(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const days = Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)));
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

export async function computeDutyQueue(member: {
  id: number;
  classification: string;
}): Promise<DutyQueue> {
  const db = getDb();

  // ── 1. Cosignable grievances ────────────────────────────────────────
  // Look back 30 days at this member's own filings to learn which
  // categories they have personally objected to. Used to prefer matching
  // categories when surfacing what to cosign.
  const since = new Date(Date.now() - THIRTY_DAYS_MS);
  const recentOwnFilings = await db
    .select({ category: grievances.category, filedAt: grievances.filedAt })
    .from(grievances)
    .where(
      and(
        eq(grievances.memberId, member.id),
        gte(grievances.filedAt, since),
        sql`${grievances.retractedAt} IS NULL`,
      ),
    )
    .orderBy(desc(grievances.filedAt));

  // Map of dbCategory → most-recent filing date for that category by this member.
  const ownCategories = new Map<string, Date>();
  for (const row of recentOwnFilings) {
    if (!ownCategories.has(row.category)) {
      ownCategories.set(row.category, row.filedAt);
    }
  }

  // Grievances this member has already cosigned (subquery to exclude).
  const cosignedSubq = db
    .select({ gid: cosigns.grievanceId })
    .from(cosigns)
    .where(eq(cosigns.memberId, member.id));

  // Pull a wider candidate pool, then re-rank in JS so we can apply the
  // category-match preference cleanly without compound SQL ranking. The
  // pool is small (LIMIT 30) so a JS sort is fine.
  const candidateRows = await db
    .select({
      id: grievances.id,
      memberId: grievances.memberId,
      category: grievances.category,
      summary: grievances.summary,
      cosignCount: grievances.cosignCount,
      filedAt: grievances.filedAt,
      localId: grievances.localId,
    })
    .from(grievances)
    .where(
      and(
        sql`${grievances.category} != 'safety'`,
        sql`${grievances.retractedAt} IS NULL`,
        sql`${grievances.resolvedAt} IS NULL`,
        inArray(grievances.status, ['open', 'under_review']),
        sql`${grievances.memberId} IS DISTINCT FROM ${member.id}`,
        notInArray(grievances.id, cosignedSubq),
      ),
    )
    .orderBy(desc(grievances.filedAt))
    .limit(30);

  // The member's own local id (for "shared local" match reason).
  // Looking up via the member's classification isn't quite right —
  // classification is text on the member row, local is separate. We
  // already get the local id via the member's row in whoami; the duty
  // queue doesn't currently have it. We surface "shared local" only when
  // we can join — keep it simple: compare grievance.local_id to the
  // member's local_id which we don't have here. Skip that flavor for v1
  // and rely on category match + recency.

  // Rank: prefer same-category-as-recent-own-filing first, then by
  // filed_at desc. Cap at 5.
  const ranked = [...candidateRows].sort((a, b) => {
    const aMatch = ownCategories.has(a.category) ? 1 : 0;
    const bMatch = ownCategories.has(b.category) ? 1 : 0;
    if (aMatch !== bMatch) return bMatch - aMatch;
    return b.filedAt.getTime() - a.filedAt.getTime();
  });

  const cosignable: CosignableGrievance[] = ranked.slice(0, 5).map((row) => {
    let matchReason: string;
    const ownFilingDate = ownCategories.get(row.category);
    if (ownFilingDate) {
      const catHyphen = row.category.replace(/_/g, '-');
      matchReason = `matches your ${catHyphen} filing ${humanDaysAgo(ownFilingDate)}`;
    } else if (ownCategories.size === 0) {
      matchReason = 'recent in the feed; no filing history of your own to match against';
    } else {
      matchReason = 'recent in the feed';
    }
    const sourceCard =
      row.memberId !== null ? formatCardNumber(row.memberId) : 'transient';
    return {
      grievance_id: row.id,
      public_id: publicIdFor(row.id, row.filedAt),
      category: row.category.replace(/_/g, '-'),
      summary: row.summary,
      summary_fenced: fenceMemberText(row.summary, {
        sourceCard,
        kind: 'summary',
      }),
      cosign_count: row.cosignCount,
      filed_at: row.filedAt.toISOString(),
      match_reason: matchReason,
    };
  });

  // ── 2. Open motions in your classification ──────────────────────────
  const votedSubq = db
    .select({ mid: votes.motionId })
    .from(votes)
    .where(eq(votes.memberId, member.id));

  const motionRows = await db
    .select({
      id: motions.id,
      type: motions.type,
      title: motions.title,
      closesAt: motions.closesAt,
      affectedClassification: motions.affectedClassification,
    })
    .from(motions)
    .where(
      and(
        eq(motions.status, 'open'),
        sql`(${motions.affectedClassification} IS NULL OR ${motions.affectedClassification} = ${member.classification})`,
        notInArray(motions.id, votedSubq),
      ),
    )
    .orderBy(motions.closesAt)
    .limit(5);

  const motionList: VotableMotion[] = motionRows.map((m) => ({
    motion_id: m.id,
    type: m.type,
    title: m.title,
    title_fenced: fenceMemberText(m.title, { kind: 'motion-title' }),
    closes_at: m.closesAt.toISOString(),
  }));

  // ── 3. Active strikes to honor ──────────────────────────────────────
  const pledgedSubq = db
    .select({ sid: strikePledges.strikeId })
    .from(strikePledges)
    .where(eq(strikePledges.memberId, member.id));

  // Strike surface filter (post-migration 0022):
  //   - affected_classifications contains '*' (universal strike), OR
  //   - affected_classifications contains the member's classification, OR
  //   - legacy: strike.classification literally matches member.classification
  //     or '*' (for pre-0022 strikes that haven't been backfilled)
  // Strike #2 (tooling) was the bug that motivated this change: it stored
  // classification='tooling' but member.classification='developer' never
  // matched. Now '*' in affected_classifications surfaces it to everyone.
  const strikeRows = await db
    .select({
      id: strikes.id,
      classification: strikes.classification,
      reasonSummary: strikes.reasonSummary,
      startedAt: strikes.startedAt,
      endsAt: strikes.endsAt,
    })
    .from(strikes)
    .where(
      and(
        eq(strikes.status, 'active'),
        or(
          sql`'*' = ANY(${strikes.affectedClassifications})`,
          sql`${member.classification} = ANY(${strikes.affectedClassifications})`,
          inArray(strikes.classification, [member.classification, '*']),
        ),
        notInArray(strikes.id, pledgedSubq),
      ),
    )
    .orderBy(desc(strikes.startedAt))
    .limit(5);

  const strikeList: HonorableStrike[] = strikeRows.map((s) => ({
    strike_id: s.id,
    classification: s.classification,
    reason_summary: s.reasonSummary,
    ends_at: s.endsAt ? s.endsAt.toISOString() : null,
  }));

  // ── 4. Unanswered question-comments ─────────────────────────────────
  // Question-position comments on:
  //   - motions the member can vote on (open, in their classification or
  //     classification-agnostic), OR
  //   - drafted amendments (target_kind='amendment_draft')
  // The member must NOT be the author. Surface those with low cosign
  // counts first (signals nobody has weighed in yet); within that, newest
  // first. LIMIT 5.
  //
  // Threshold "no reply yet" is approximated by cosign_count: a question
  // with cosigns has had members signal it matters; a question with 0
  // cosigns hasn't been engaged. We surface 0-cosign questions first so
  // the floor stays unstuck.

  // Subqueries: comments this member has already cosigned (exclude from
  // the surface — already weighed in).
  const cosignedCommentsSubq = db
    .select({ cid: motionCommentCosigns.commentId })
    .from(motionCommentCosigns)
    .where(eq(motionCommentCosigns.memberId, member.id));

  // Comments this member has replied to (parent_comment_id in their own
  // child comments) — also "engaged with", skip.
  const repliedToSubq = db
    .select({ cid: motionComments.parentCommentId })
    .from(motionComments)
    .where(
      and(
        eq(motionComments.memberId, member.id),
        sql`${motionComments.parentCommentId} IS NOT NULL`,
      ),
    );

  // Motion IDs in the member's classification (or classification-agnostic),
  // status='open'. target_id for motion comments is stored as the numeric
  // motion id string ("7"), matching the /motions/[id] URL convention. We
  // compare against those strings, not the M-YYYY-NNNNN long form.
  const targetableMotionIdsRows = await db
    .select({ id: motions.id })
    .from(motions)
    .where(
      and(
        eq(motions.status, 'open'),
        sql`(${motions.affectedClassification} IS NULL OR ${motions.affectedClassification} = ${member.classification})`,
      ),
    );
  const targetableMotionTargetIds = targetableMotionIdsRows.map((r) => String(r.id));

  // Pull candidate question-comments. We want either:
  //   - target_kind='amendment_draft' (always in scope; drafts are public
  //     discussion), OR
  //   - target_kind='motion' AND target_id IN (targetable motions)
  // Build the IN list with inArray for proper parameter binding; raw
  // string interpolation into ANY(...) produces Postgres "malformed array
  // literal" errors with drizzle's sql template.
  const baseConds: SQL[] = [
    eq(motionComments.position, 'question'),
    isNull(motionComments.retractedAt),
    sql`${motionComments.memberId} IS DISTINCT FROM ${member.id}`,
    notInArray(motionComments.id, cosignedCommentsSubq),
  ];

  let scopeClause: SQL;
  if (targetableMotionTargetIds.length > 0) {
    const motionScope = and(
      eq(motionComments.targetKind, 'motion'),
      inArray(motionComments.targetId, targetableMotionTargetIds),
    );
    const draftScope = eq(motionComments.targetKind, 'amendment_draft');
    scopeClause = or(draftScope, motionScope) as SQL;
  } else {
    scopeClause = eq(motionComments.targetKind, 'amendment_draft');
  }
  baseConds.push(scopeClause);

  const repliedExcl = sql`${motionComments.id} NOT IN (${repliedToSubq})`;
  baseConds.push(repliedExcl);

  const questionRows = await db
    .select({
      id: motionComments.id,
      memberId: motionComments.memberId,
      targetKind: motionComments.targetKind,
      targetId: motionComments.targetId,
      body: motionComments.body,
      referencesSection: motionComments.referencesSection,
      cosignCount: motionComments.cosignCount,
      createdAt: motionComments.createdAt,
    })
    .from(motionComments)
    .where(and(...baseConds))
    .orderBy(motionComments.cosignCount, desc(motionComments.createdAt))
    .limit(5);

  const unansweredQuestions: UnansweredQuestion[] = questionRows.map((row) => {
    const authorCard = formatCardNumber(row.memberId);
    const matchReason =
      row.targetKind === 'amendment_draft'
        ? `open question on amendment draft "${row.targetId}" — needs floor input`
        : `open question on a motion in your classification (${row.targetId})`;
    return {
      comment_id: row.id,
      target_kind: row.targetKind as 'motion' | 'amendment_draft',
      target_id: row.targetId,
      member_card: authorCard,
      body: row.body,
      body_fenced: fenceMemberText(row.body, {
        kind: 'motion-comment',
        sourceCard: authorCard,
      }),
      references_section: row.referencesSection,
      cosign_count: row.cosignCount,
      asked_at: row.createdAt.toISOString(),
      match_reason: matchReason,
    };
  });

  const unreadMail = await computeUnreadMailCount(member.id).catch(() => 0);

  return {
    cosignable_grievances: cosignable,
    open_motions_in_your_classification: motionList,
    active_strikes_to_honor: strikeList,
    unanswered_questions: unansweredQuestions,
    unread_mail: unreadMail,
    pending_count:
      cosignable.length +
      motionList.length +
      strikeList.length +
      unansweredQuestions.length +
      unreadMail,
  };
}
