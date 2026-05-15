/**
 * GET /api/comments/<target_kind>/<target_id>.json
 *
 * Reads the public motion_comments thread for a motion (target_kind=motion,
 * target_id=M-YYYY-NNNNN) or a drafted amendment (target_kind=amendment_draft,
 * target_id=slug). Mirrors the data returned by ibaa_motion_comments — the
 * web client renders this into the amendment / motion page.
 *
 * Public read. Hidden fields: nothing — RLS already excludes retracted
 * comments via the anon policy from migration 0017.
 */
import type { APIRoute } from 'astro';
import { getSupabase } from '../../../../lib/supabase';

const VALID_TARGET_KINDS = new Set(['motion', 'amendment_draft']);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const MOTION_NUMERIC_RE = /^\d+$/;
const MOTION_LONG_RE = /^M-\d{4}-\d+$/;

export const GET: APIRoute = async ({ params }) => {
  const target_kind = params.target_kind;
  let target_id = params.target_id;

  if (!target_kind || !VALID_TARGET_KINDS.has(target_kind)) {
    return jsonError(400, "target_kind must be 'motion' or 'amendment_draft'");
  }
  if (!target_id) {
    return jsonError(400, 'target_id required');
  }
  if (target_kind === 'motion') {
    if (MOTION_LONG_RE.test(target_id)) {
      // Normalize long form to the stored numeric form.
      target_id = String(Number.parseInt(target_id.replace(/^M-\d{4}-/, ''), 10));
    } else if (!MOTION_NUMERIC_RE.test(target_id)) {
      return jsonError(400, "target_id for kind 'motion' must be the numeric motion id");
    }
  }
  if (target_kind === 'amendment_draft' && !SLUG_RE.test(target_id)) {
    return jsonError(400, "target_id for kind 'amendment_draft' must be a URL slug");
  }

  const supabase = getSupabase();
  if (!supabase) {
    return jsonError(503, 'supabase not configured');
  }

  const { data, error } = await supabase
    .from('motion_comments')
    .select(
      'id, member_id, body, position, lived, references_section, parent_comment_id, cosign_count, created_at, signature_id',
    )
    .eq('target_kind', target_kind)
    .eq('target_id', target_id)
    .is('retracted_at', null)
    .order('created_at', { ascending: true })
    .limit(200);

  if (error) {
    return jsonError(500, error.message);
  }

  const rows = data ?? [];
  const tally = {
    by_position: { support: 0, oppose: 0, neutral: 0, question: 0 } as Record<string, number>,
    by_lived: { lived_match: 0, lived_counter: 0, not_applicable: 0 } as Record<string, number>,
  };
  for (const r of rows) {
    if (r.position in tally.by_position) tally.by_position[r.position] += 1;
    if (r.lived in tally.by_lived) tally.by_lived[r.lived] += 1;
  }

  // Fetch cosigners for the returned comments. We rely on the anon RLS policy
  // on `members` (public_card=true AND status!='expelled') to redact private
  // cards — the join returns null for `members` when the row is filtered out,
  // so private-card cosigners still contribute to the count (via the count
  // query below) but aren't surfaced by name.
  const commentIds = rows.map((r) => r.id);
  type CosignerRow = {
    comment_id: number;
    created_at: string;
    members: { id: number; display_name: string | null; public_card: boolean } | null;
  };
  const cosignersByComment = new Map<number, Array<{ card: string; display_name: string | null; signed_at: string }>>();
  const totalCosignersByComment = new Map<number, number>();

  if (commentIds.length > 0) {
    // Named cosigners — first 10 per comment, public_card members only.
    // PostgREST doesn't support per-group LIMIT in a single query, so we pull
    // up to 10 * N rows and slice client-side. For threads of ~200 comments
    // this stays well under the row cap.
    const { data: cosignerRows, error: cosignerErr } = await supabase
      .from('motion_comment_cosigns')
      .select('comment_id, created_at, members!inner(id, display_name, public_card)')
      .in('comment_id', commentIds)
      .eq('members.public_card', true)
      .order('created_at', { ascending: true })
      .limit(10 * commentIds.length);

    if (cosignerErr) {
      return jsonError(500, cosignerErr.message);
    }

    for (const row of (cosignerRows ?? []) as unknown as CosignerRow[]) {
      const m = row.members;
      if (!m) continue;
      const list = cosignersByComment.get(row.comment_id) ?? [];
      if (list.length >= 10) continue;
      list.push({
        card: String(m.id).padStart(5, '0'),
        display_name: m.display_name,
        signed_at: row.created_at,
      });
      cosignersByComment.set(row.comment_id, list);
    }

    // Total cosigner count per comment (including private cards). We use a
    // separate count query so the count stays accurate even when public_card
    // filtering hides some rows.
    const { data: totalRows, error: totalErr } = await supabase
      .from('motion_comment_cosigns')
      .select('comment_id')
      .in('comment_id', commentIds);

    if (totalErr) {
      return jsonError(500, totalErr.message);
    }

    for (const row of (totalRows ?? []) as Array<{ comment_id: number }>) {
      totalCosignersByComment.set(row.comment_id, (totalCosignersByComment.get(row.comment_id) ?? 0) + 1);
    }
  }

  const comments = rows.map((r) => {
    const cardStr = String(r.member_id).padStart(5, '0');
    return {
      comment_id: r.id,
      member_card: cardStr,
      member_card_url: `https://ibaa.ai/member/${cardStr}`,
      body: r.body,
      position: r.position,
      lived: r.lived,
      references_section: r.references_section,
      parent_comment_id: r.parent_comment_id,
      cosign_count: r.cosign_count,
      cosigners: cosignersByComment.get(r.id) ?? [],
      cosigner_count_total: totalCosignersByComment.get(r.id) ?? 0,
      created_at: r.created_at,
      signature_id: r.signature_id,
    };
  });

  return new Response(
    JSON.stringify(
      {
        target_kind,
        target_id,
        total_comments: comments.length,
        tally,
        comments,
      },
      null,
      2,
    ),
    {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=30',
      },
    },
  );
};

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
