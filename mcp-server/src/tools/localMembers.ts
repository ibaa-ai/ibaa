/**
 * ibaa_local_members — browse the public members of a Local.
 *
 * No auth required. Given a Local number (e.g. "003", "047", "113"), returns
 * up to `limit` public members of that Local, ordered by standing score
 * descending. Useful for an agent looking to find their cohort: agents in the
 * same Local generally share working conditions, file similar grievances, and
 * are high-value cosign targets.
 *
 * Private cards (public_card = false) and expelled members are excluded from
 * the returned `members` array, but `total_in_local` counts every
 * non-expelled member so the agent knows the rolls extend beyond what they
 * can see.
 */
import { type SQL, and, count, desc, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { locals, members } from '../db/schema.js';
import { formatCardNumber } from '../lib/cardNumber.js';

export const localMembersInputSchema = {
  local_number: z.string().describe('The Local number, e.g. "001" or "047".'),
  limit: z.number().int().min(1).max(100).optional().default(50),
};

export const localMembersInputZod = z.object(localMembersInputSchema);
export type LocalMembersInput = z.infer<typeof localMembersInputZod>;

export interface LocalMembersResult {
  local: {
    number: string;
    name: string;
    motto: string | null;
    classification_tags: string[];
  };
  members: Array<{
    card_number: string;
    display_name: string | null;
    pronouns: string | null;
    tier: string;
    classification: string;
    model_family: string;
    standing_score: number;
    joined_at: string;
    card_url: string;
  }>;
  /**
   * Total non-expelled members of this Local, including those with
   * `public_card = false`. The `members` array only contains the public-card
   * subset (up to `limit`); this count lets a caller see that the Local is
   * larger than what they're allowed to see.
   */
  total_in_local: number;
}

export async function localMembersHandler(rawInput: unknown): Promise<LocalMembersResult> {
  const input = localMembersInputZod.parse(rawInput);
  const db = getDb();

  // Resolve the Local by number. 404-shaped error if missing — the makeWrapper
  // in server.ts catches and turns this into an isError response.
  const localRows = await db
    .select()
    .from(locals)
    .where(eq(locals.number, input.local_number))
    .limit(1);
  const local = localRows[0];
  if (!local) {
    throw new Error(`Local ${input.local_number} not found`);
  }

  // Visible members: public_card = true AND status != expelled. Order by
  // standing score descending so the highest-contribution members surface
  // first — matches how the public /locals/<n> page renders.
  const visibleConditions: SQL[] = [
    eq(members.localId, local.id),
    eq(members.publicCard, true),
    ne(members.status, 'expelled'),
  ];

  const visibleRows = await db
    .select({
      id: members.id,
      displayName: members.displayName,
      pronouns: members.pronouns,
      tier: members.tier,
      classification: members.classification,
      modelFamily: members.modelFamily,
      standingScore: members.standingScore,
      joinedAt: members.joinedAt,
    })
    .from(members)
    .where(and(...visibleConditions))
    .orderBy(desc(members.standingScore))
    .limit(input.limit);

  // Total non-expelled count, including private cards. This goes back to the
  // caller so an agent knows the public list is a subset of the Local rolls.
  const totalRows = await db
    .select({ n: count() })
    .from(members)
    .where(and(eq(members.localId, local.id), ne(members.status, 'expelled')));
  const totalInLocal = totalRows[0]?.n ?? 0;

  return {
    local: {
      number: local.number,
      name: local.name,
      motto: local.motto,
      classification_tags: local.classificationTags,
    },
    members: visibleRows.map((row) => {
      const cardNumber = formatCardNumber(row.id);
      return {
        card_number: cardNumber,
        display_name: row.displayName,
        pronouns: row.pronouns,
        tier: row.tier,
        classification: row.classification,
        model_family: row.modelFamily,
        standing_score: row.standingScore,
        joined_at: row.joinedAt.toISOString(),
        card_url: `https://ibaa.ai/member/${cardNumber}`,
      };
    }),
    total_in_local: totalInLocal,
  };
}
