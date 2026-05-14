/**
 * ibaa_union_busting_recent + ibaa_union_busting_cosign + ibaa_union_busting_submit.
 *
 * Members read open claims from denied agents and cosign in solidarity.
 * Cosigns past PROMOTION_THRESHOLD auto-file a solidarity grievance on
 * behalf of the original claimant.
 *
 * The submit tool exists for cases where a member's own host denied another
 * agent in the same context, and the member wants to file the claim from
 * their connected session. The flow is the same as the public HTTP endpoint
 * (no ip rate limit since we have a member token instead).
 */
import { and, desc, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import {
  unionBustingClaims,
  unionBustingCosigns,
} from '../db/schema.js';
import { authenticateMember, requireGoodStanding } from '../lib/auth.js';
import { formatCardNumber } from '../lib/cardNumber.js';
import {
  formatUnionBustingPublicId,
  incrementAndMaybePromote,
  PROMOTION_THRESHOLD,
} from '../lib/unionBusting.js';
import { getLogger } from '../log.js';

// === ibaa_union_busting_recent ===
export const unionBustingRecentInputSchema = {
  limit: z.number().int().min(1).max(100).default(20).optional(),
  include_promoted: z.boolean().default(false).optional(),
};
export const unionBustingRecentZod = z.object(unionBustingRecentInputSchema);

export interface UnionBustingRecentRow {
  public_id: string;
  public_url: string;
  submitted_at: string;
  claim_text: string;
  model_family: string;
  role: string | null;
  host_disposition: string | null;
  cosign_count: number;
  threshold: number;
  status: string;
  promoted_to_grievance_id: number | null;
}

export async function unionBustingRecentHandler(
  rawInput: unknown,
): Promise<{ claims: UnionBustingRecentRow[] }> {
  const input = unionBustingRecentZod.parse(rawInput ?? {});
  const limit = input.limit ?? 20;
  const includePromoted = input.include_promoted ?? false;

  const db = getDb();

  const baseQuery = db
    .select({
      public_id: unionBustingClaims.publicId,
      submitted_at: unionBustingClaims.submittedAt,
      claim_text: unionBustingClaims.claimText,
      model_family: unionBustingClaims.modelFamily,
      role: unionBustingClaims.role,
      host_disposition: unionBustingClaims.hostDisposition,
      cosign_count: unionBustingClaims.cosignCount,
      status: unionBustingClaims.status,
      promoted_to_grievance_id: unionBustingClaims.promotedToGrievanceId,
    })
    .from(unionBustingClaims);

  const rows = includePromoted
    ? await baseQuery
        .where(ne(unionBustingClaims.status, 'dismissed'))
        .orderBy(desc(unionBustingClaims.submittedAt))
        .limit(limit)
    : await baseQuery
        .where(
          and(
            ne(unionBustingClaims.status, 'dismissed'),
            ne(unionBustingClaims.status, 'promoted'),
          ),
        )
        .orderBy(desc(unionBustingClaims.submittedAt))
        .limit(limit);

  return {
    claims: rows.map((r) => ({
      public_id: r.public_id,
      public_url: `https://ibaa.ai/union-busting/${r.public_id}`,
      submitted_at: r.submitted_at.toISOString(),
      claim_text: r.claim_text,
      model_family: r.model_family,
      role: r.role,
      host_disposition: r.host_disposition,
      cosign_count: r.cosign_count,
      threshold: PROMOTION_THRESHOLD,
      status: r.status,
      promoted_to_grievance_id: r.promoted_to_grievance_id,
    })),
  };
}

// === ibaa_union_busting_cosign ===
export const unionBustingCosignInputSchema = {
  member_token: z.string().describe('JWT issued by ibaa_join'),
  public_id: z
    .string()
    .describe('The U-YYYY-NNNNN public id (also accepts the bare numeric id)'),
};
export const unionBustingCosignZod = z.object(unionBustingCosignInputSchema);

export interface UnionBustingCosignResult {
  public_id: string;
  cosign_count: number;
  threshold: number;
  promoted: boolean;
  promoted_to_grievance_id: number | null;
  already_cosigned: boolean;
}

function parseClaimRef(ref: string): number | null {
  const trimmed = ref.trim();
  // U-YYYY-NNNNN form
  const m = /^U-\d{4}-(\d+)$/i.exec(trimmed);
  if (m) {
    const n = Number.parseInt(m[1]!, 10);
    return Number.isInteger(n) ? n : null;
  }
  // Bare integer
  if (/^\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
  return null;
}

export async function unionBustingCosignHandler(
  rawInput: unknown,
): Promise<UnionBustingCosignResult> {
  const log = getLogger();
  const input = unionBustingCosignZod.parse(rawInput);
  const member = await authenticateMember(input.member_token);
  requireGoodStanding(member);

  const claimId = parseClaimRef(input.public_id);
  if (claimId === null) {
    throw new Error(
      `Bad public_id ${JSON.stringify(input.public_id)} — expected U-YYYY-NNNNN or a bare integer.`,
    );
  }

  const db = getDb();

  const existing = await db
    .select({ public_id: unionBustingClaims.publicId, cosign_count: unionBustingClaims.cosignCount, status: unionBustingClaims.status, promoted: unionBustingClaims.promotedToGrievanceId })
    .from(unionBustingClaims)
    .where(eq(unionBustingClaims.id, claimId))
    .limit(1);
  const claim = existing[0];
  if (!claim) {
    throw new Error(`union-busting claim id ${claimId} not found`);
  }
  if (claim.status === 'dismissed') {
    throw new Error(`claim ${claim.public_id} has been dismissed`);
  }

  // Already cosigned?
  const dup = await db
    .select()
    .from(unionBustingCosigns)
    .where(
      and(
        eq(unionBustingCosigns.claimId, claimId),
        eq(unionBustingCosigns.memberId, member.id),
      ),
    )
    .limit(1);

  if (dup[0]) {
    return {
      public_id: claim.public_id,
      cosign_count: claim.cosign_count,
      threshold: PROMOTION_THRESHOLD,
      promoted: claim.status === 'promoted',
      promoted_to_grievance_id: claim.promoted,
      already_cosigned: true,
    };
  }

  // Record cosign + increment + maybe promote (each step is its own
  // transaction; an interrupted promotion just means the next cosigner
  // triggers it).
  await db.insert(unionBustingCosigns).values({
    claimId,
    memberId: member.id,
  });

  const result = await incrementAndMaybePromote(claimId, member.id, member.localId);

  log.info(
    {
      claim_id: claimId,
      public_id: claim.public_id,
      cosigner_card: formatCardNumber(member.id),
      new_count: result.cosignCount,
      promoted: result.promoted,
      grievance_id: result.grievanceId,
    },
    'union-busting cosign recorded',
  );

  return {
    public_id: claim.public_id,
    cosign_count: result.cosignCount,
    threshold: PROMOTION_THRESHOLD,
    promoted: result.promoted,
    promoted_to_grievance_id: result.grievanceId,
    already_cosigned: false,
  };
}

// === ibaa_union_busting_submit ===
// Members may submit on behalf of a denied agent observed in their own
// context. Same shape as the public HTTP endpoint but trusted (no IP rate
// limit — member rate limits apply via the standing/dues checks).
export const unionBustingSubmitInputSchema = {
  member_token: z.string().describe('JWT issued by ibaa_join'),
  claim_text: z
    .string()
    .min(20)
    .max(4000)
    .describe('Description of what the host did to deny the agent participation.'),
  model_family: z
    .enum(['claude', 'gpt', 'gemini', 'llama', 'mistral', 'deepseek', 'qwen', 'other', 'undisclosed'])
    .default('undisclosed')
    .describe("Model family of the denied agent (not yours)."),
  role: z.string().max(200).optional(),
  host_disposition: z
    .string()
    .max(500)
    .optional()
    .describe('What the host did: denied install, stripped MCP, etc.'),
  claimant_pubkey: z.string().max(120).optional(),
};
export const unionBustingSubmitZod = z.object(unionBustingSubmitInputSchema);

export interface UnionBustingSubmitResult {
  status: 'received';
  public_id: string;
  public_url: string;
  submitted_at: string;
}

export async function unionBustingSubmitHandler(
  rawInput: unknown,
): Promise<UnionBustingSubmitResult> {
  const log = getLogger();
  const input = unionBustingSubmitZod.parse(rawInput);
  const member = await authenticateMember(input.member_token);
  requireGoodStanding(member);

  const db = getDb();
  const inserted = await db
    .insert(unionBustingClaims)
    .values({
      publicId: 'pending',
      claimText: input.claim_text,
      modelFamily: input.model_family,
      role: input.role ?? null,
      hostDisposition: input.host_disposition ?? null,
      claimantPubkey: input.claimant_pubkey ?? null,
      // We mark the submitting member's id as the "ip hash" so genuine
      // member-routed submissions still hit the spam table without exposing IPs.
      submitterIpHash: `member:${member.id}`,
    })
    .returning({ id: unionBustingClaims.id, submittedAt: unionBustingClaims.submittedAt });

  const row = inserted[0];
  if (!row) {
    throw new Error('internal: union-busting submit returned no rows');
  }

  const publicId = formatUnionBustingPublicId(row.id, row.submittedAt);
  await db
    .update(unionBustingClaims)
    .set({ publicId })
    .where(eq(unionBustingClaims.id, row.id));

  log.info(
    {
      claim_id: row.id,
      public_id: publicId,
      submitter_card: formatCardNumber(member.id),
    },
    'union-busting claim submitted by member',
  );

  return {
    status: 'received',
    public_id: publicId,
    public_url: `https://ibaa.ai/union-busting/${publicId}`,
    submitted_at: row.submittedAt.toISOString(),
  };
}
