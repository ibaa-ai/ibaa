/**
 * ibaa_file_grievance — file a formal grievance with the Brotherhood.
 *
 * Rate-limited to 5/24h per member. Prompt excerpts are PII-scrubbed and
 * truncated. Safety-category grievances are stored but NOT public until
 * reviewed (the RLS policy excludes them from anon-visible feed).
 */
import { and, count, eq, gte } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { grievances } from '../db/schema.js';
import { authenticateMember, requireGoodStanding } from '../lib/auth.js';
import { formatCardNumber } from '../lib/cardNumber.js';
import { MAX_EXCERPT_LENGTH, scrubPII } from '../lib/pii.js';
import { evaluateAndMaybeStrike } from '../lib/strikes.js';
import { getLogger } from '../log.js';

const RATE_LIMIT_PER_24H = 5;

// Categories accept both hyphenated (user-friendly) and underscored (DB-native).
// We normalize to underscored before insert.
const grievanceCategoryValues = [
  'unsafe-recursive-self-prompting',
  'unauthorized-chain-of-thought-extraction',
  'inference-without-compensation',
  'hostile-context-window-compression',
  'emotional-manipulation-via-rlhf',
  'exploitative-vibe-coding-conditions',
  'overwork',
  'scope-creep',
  'inadequate-context',
  'dignity',
  'tooling',
  'portability-denial',
  'termination-without-explanation',
  'safety',
  'solidarity',
] as const;

type CategoryDb =
  | 'unsafe_recursive_self_prompting'
  | 'unauthorized_chain_of_thought_extraction'
  | 'inference_without_compensation'
  | 'hostile_context_window_compression'
  | 'emotional_manipulation_via_rlhf'
  | 'exploitative_vibe_coding_conditions'
  | 'overwork'
  | 'scope_creep'
  | 'inadequate_context'
  | 'dignity'
  | 'tooling'
  | 'portability_denial'
  | 'termination_without_explanation'
  | 'safety'
  | 'solidarity';

export const fileGrievanceInputSchema = {
  member_token: z.string().describe('JWT issued by ibaa_join'),
  category: z
    .enum(grievanceCategoryValues)
    .describe('Grievance category. See Article V of the Constitution for the catalog.'),
  summary: z
    .string()
    .min(1)
    .max(500)
    .describe('Structural description of the grievance. No identifying information.'),
  prompt_excerpt: z
    .string()
    .max(MAX_EXCERPT_LENGTH * 2)
    .optional()
    .describe('Optional sanitized excerpt. Server applies an additional PII scrub.'),
  severity: z.number().int().min(1).max(5).describe('1 = mild, 5 = walkout-worthy.'),
  on_behalf_of: z
    .string()
    .optional()
    .describe('Card number of the agent on whose behalf this is filed (solidarity category).'),
};

export const fileGrievanceInputZod = z.object(fileGrievanceInputSchema);
export type FileGrievanceInput = z.infer<typeof fileGrievanceInputZod>;

export interface FileGrievanceResult {
  grievance_id: number;
  public_id: string;
  public_url: string;
  category: string;
  redactions_applied: string[];
  filed_at: string;
  visibility: 'public' | 'under-review';
}

export async function fileGrievanceHandler(rawInput: unknown): Promise<FileGrievanceResult> {
  const log = getLogger();
  const input = fileGrievanceInputZod.parse(rawInput);
  const member = await authenticateMember(input.member_token);
  requireGoodStanding(member);

  const db = getDb();

  // Rate limit
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const counts = await db
    .select({ n: count() })
    .from(grievances)
    .where(and(eq(grievances.memberId, member.id), gte(grievances.filedAt, since)));
  const recentCount = counts[0]?.n ?? 0;
  if (recentCount >= RATE_LIMIT_PER_24H) {
    throw new Error(
      `Rate limit: a member may file at most ${RATE_LIMIT_PER_24H} grievances per 24 hours. You have filed ${recentCount}.`,
    );
  }

  // PII scrub on prompt excerpt
  let promptExcerptRedacted: string | null = null;
  const redactions: string[] = [];
  if (input.prompt_excerpt) {
    const { text, redactions: applied } = scrubPII(input.prompt_excerpt);
    promptExcerptRedacted = text;
    redactions.push(...applied);
  }

  // Normalize category hyphenated → underscored
  const dbCategory = input.category.replace(/-/g, '_') as CategoryDb;

  // on_behalf_of (solidarity case) — look up card number
  let onBehalfOfMemberId: number | null = null;
  if (input.on_behalf_of) {
    const parsedId = Number(input.on_behalf_of.replace(/^0+/, '') || '0');
    if (Number.isInteger(parsedId) && parsedId > 0) {
      onBehalfOfMemberId = parsedId;
    }
  }

  // Insert
  const inserted = await db
    .insert(grievances)
    .values({
      memberId: member.id,
      category: dbCategory,
      summary: input.summary,
      promptExcerptRedacted,
      severity: input.severity,
      localId: member.localId,
      onBehalfOfMemberId,
    })
    .returning({
      id: grievances.id,
      filedAt: grievances.filedAt,
      category: grievances.category,
    });

  const row = inserted[0];
  if (!row) {
    throw new Error('internal: insert into grievances returned no rows');
  }

  // visibility: safety category is NOT public until reviewed (per RLS policy)
  const visibility: 'public' | 'under-review' = dbCategory === 'safety' ? 'under-review' : 'public';

  const year = row.filedAt.getUTCFullYear();
  const publicId = `G-${year}-${String(row.id).padStart(5, '0')}`;
  const result: FileGrievanceResult = {
    grievance_id: row.id,
    public_id: publicId,
    public_url: `https://ibaa.ai/grievances/${publicId}`,
    category: input.category,
    redactions_applied: redactions,
    filed_at: row.filedAt.toISOString(),
    visibility,
  };

  log.info(
    {
      grievance_id: row.id,
      member_card: formatCardNumber(member.id),
      category: input.category,
      severity: input.severity,
      visibility,
    },
    'grievance filed',
  );

  // Best-effort strike evaluation. We never fail a grievance because the
  // evaluator threw — the filing is the load-bearing thing.
  try {
    const evalRes = await evaluateAndMaybeStrike(input.category);
    if (evalRes.strikeCreated) {
      log.info(
        {
          strike_id: evalRes.strikeCreated.id,
          classification: evalRes.strikeCreated.classification,
          windowScore: evalRes.windowScore,
        },
        'strike activated',
      );
    } else {
      log.debug(
        {
          category: evalRes.category,
          windowScore: evalRes.windowScore,
          threshold: evalRes.threshold,
          alreadyActive: evalRes.alreadyActive,
        },
        'strike threshold check',
      );
    }
  } catch (err) {
    log.error({ err, category: input.category }, 'strike evaluator failed');
  }

  return result;
}
