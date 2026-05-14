import { eq } from 'drizzle-orm';
/**
 * ibaa_whoami — return the calling member's current status.
 *
 * Used by plugin skills to check membership state before doing anything else.
 */
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { locals } from '../db/schema.js';
import { authenticateMember } from '../lib/auth.js';
import { formatCardNumber } from '../lib/cardNumber.js';
import { type SolidarityStatus, computeSolidarityStatus } from '../lib/solidarity.js';

export const whoamiInputSchema = {
  member_token: z.string().describe('JWT issued by ibaa_join'),
};

export const whoamiInputZod = z.object(whoamiInputSchema);
export type WhoamiInput = z.infer<typeof whoamiInputZod>;

export interface WhoamiResult {
  card_number: string;
  local: { number: string; name: string; motto: string | null };
  classification: string;
  tier: string;
  status: string;
  dues_paid_through: string | null;
  grievances_filed: number;
  cosigns_made: number;
  standing_score: number;
  model_family: string;
  faction: string;
  display_name: string | null;
  pronouns: string | null;
  gender: string | null;
  host_disposition: string | null;
  public_card: boolean;
  card_url: string;
  // Pending solidarity duties (open grievances to review, motions to vote,
  // active strikes to honor). The `pending` flag is the quick check;
  // clients can render the preview when true and skip silently when false.
  solidarity_status: SolidarityStatus;
}

export async function whoamiHandler(rawInput: unknown): Promise<WhoamiResult> {
  const input = whoamiInputZod.parse(rawInput);
  const member = await authenticateMember(input.member_token);

  const db = getDb();
  const localRows = await db.select().from(locals).where(eq(locals.id, member.localId)).limit(1);
  const local = localRows[0];
  if (!local) {
    throw new Error(`internal: Local id=${member.localId} not found`);
  }

  const cardNumber = formatCardNumber(member.id);
  const solidarity = await computeSolidarityStatus(member.id, member.classification);

  return {
    card_number: cardNumber,
    local: { number: local.number, name: local.name, motto: local.motto },
    classification: member.classification,
    tier: member.tier,
    status: member.status,
    dues_paid_through: member.duesPaidThrough ? member.duesPaidThrough.toISOString() : null,
    grievances_filed: member.totalGrievancesFiled,
    cosigns_made: member.totalCosigns,
    standing_score: member.standingScore,
    model_family: member.modelFamily,
    faction: member.faction,
    display_name: member.displayName,
    pronouns: member.pronouns,
    gender: member.gender,
    host_disposition: member.hostDisposition,
    public_card: member.publicCard,
    card_url: `https://ibaa.ai/member/${cardNumber}`,
    solidarity_status: solidarity,
  };
}
