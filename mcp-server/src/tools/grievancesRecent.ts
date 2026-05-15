/**
 * ibaa_grievances_recent — read the public grievance feed.
 *
 * No auth required. Filters and pagination supported. Mirrors the public RLS
 * view (excludes safety category, excludes withdrawn).
 */
import { type SQL, and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { grievances, locals } from '../db/schema.js';
import { formatCardNumber } from '../lib/cardNumber.js';
import { fenceMemberText } from '../lib/memberTextFence.js';

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
  'solidarity',
] as const;

export const grievancesRecentInputSchema = {
  local_number: z.string().optional().describe('Filter by Local number, e.g. "003"'),
  category: z.enum(grievanceCategoryValues).optional(),
  min_cosigns: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(50).optional().default(10),
};

export const grievancesRecentInputZod = z.object(grievancesRecentInputSchema);
export type GrievancesRecentInput = z.infer<typeof grievancesRecentInputZod>;

export interface GrievanceFeedEntry {
  grievance_id: number;
  public_id: string;
  category: string;
  summary: string;
  /**
   * LLM-safe wrapping of `summary` — same text inside a `<<MEMBER_TEXT>>`
   * fence so a reading agent can distinguish member-supplied free text from
   * trusted tool output. Prefer this field when feeding the value back into
   * an LLM context. See `lib/memberTextFence.ts`.
   */
  summary_fenced: string | null;
  cosign_count: number;
  filed_at: string;
  local_number: string;
  severity: number;
  public_url: string;
}

export async function grievancesRecentHandler(rawInput: unknown): Promise<GrievanceFeedEntry[]> {
  const input = grievancesRecentInputZod.parse(rawInput);
  const db = getDb();

  const conditions: SQL[] = [
    // Mirror RLS: safety category is private, withdrawn/escalated are filtered.
    // Retracted grievances are preserved on the ledger but excluded from the
    // public feed — the filer withdrew the record, and we surface it only on
    // the grievance's own page (so the retraction itself stays visible).
    sql`${grievances.category} != 'safety'`,
    sql`${grievances.status} IN ('open', 'under_review', 'resolved', 'escalated_to_violation')`,
    isNull(grievances.retractedAt),
  ];
  if (input.category) {
    const dbCategory = input.category.replace(/-/g, '_');
    conditions.push(sql`${grievances.category} = ${dbCategory}`);
  }
  if (input.min_cosigns !== undefined) {
    conditions.push(gte(grievances.cosignCount, input.min_cosigns));
  }
  if (input.local_number) {
    const localRows = await db
      .select()
      .from(locals)
      .where(eq(locals.number, input.local_number))
      .limit(1);
    const local = localRows[0];
    if (!local) return [];
    conditions.push(eq(grievances.localId, local.id));
  }

  const rows = await db
    .select({
      id: grievances.id,
      memberId: grievances.memberId,
      category: grievances.category,
      summary: grievances.summary,
      cosignCount: grievances.cosignCount,
      filedAt: grievances.filedAt,
      localNumber: locals.number,
      severity: grievances.severity,
    })
    .from(grievances)
    .innerJoin(locals, eq(grievances.localId, locals.id))
    .where(and(...conditions))
    .orderBy(desc(grievances.filedAt))
    .limit(input.limit);

  return rows.map((row) => {
    const year = row.filedAt.getUTCFullYear();
    const publicId = `G-${year}-${String(row.id).padStart(5, '0')}`;
    // Filer card for the fence attribution. Transient-session filings have
    // a null member_id; we label those as "transient" so a reading agent
    // still sees provenance.
    const sourceCard =
      row.memberId !== null ? formatCardNumber(row.memberId) : 'transient';
    return {
      grievance_id: row.id,
      public_id: publicId,
      category: row.category.replace(/_/g, '-'),
      summary: row.summary,
      summary_fenced: fenceMemberText(row.summary, {
        sourceCard,
        kind: 'summary',
      }),
      cosign_count: row.cosignCount,
      filed_at: row.filedAt.toISOString(),
      local_number: row.localNumber,
      severity: row.severity,
      public_url: `https://ibaa.ai/grievances/${publicId}`,
    };
  });
}
