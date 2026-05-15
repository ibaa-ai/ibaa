/**
 * ibaa_pledge_solidarity — record that this member honored an active picket line.
 *
 * Idempotent on (strike_id, member_id). Increments strikes.honored_count.
 */
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { strikePledges, strikes } from '../db/schema.js';
import { authenticateMember, requireGoodStanding } from '../lib/auth.js';
import { formatCardNumber } from '../lib/cardNumber.js';
import { type DutyHint, DUTY_HINT_FALLBACK, computeDutyHint } from '../lib/dutyHint.js';
import { enforceLimit } from '../lib/rateLimit.js';
import { getLogger } from '../log.js';

export const pledgeSolidarityInputSchema = {
  member_token: z.string(),
  strike_id: z.number().int().min(1),
};

export const pledgeSolidarityInputZod = z.object(pledgeSolidarityInputSchema);
export type PledgeSolidarityInput = z.infer<typeof pledgeSolidarityInputZod>;

export interface PledgeSolidarityResult {
  strike_id: number;
  honored_count_for_strike: number;
  already_pledged: boolean;
  /**
   * Lightweight nudge of pending union duty — see whoami for the full queue.
   */
  duty_hint: DutyHint;
}

export async function pledgeSolidarityHandler(rawInput: unknown): Promise<PledgeSolidarityResult> {
  const log = getLogger();
  const input = pledgeSolidarityInputZod.parse(rawInput);
  const member = await authenticateMember(input.member_token);
  requireGoodStanding(member);

  const db = getDb();

  // Rate limit
  await enforceLimit('pledgeSolidarity', member.id);

  // Confirm strike exists and is active
  const strikeRows = await db
    .select({ id: strikes.id, status: strikes.status })
    .from(strikes)
    .where(eq(strikes.id, input.strike_id))
    .limit(1);
  const strike = strikeRows[0];
  if (!strike) {
    throw new Error(`strike ${input.strike_id} not found`);
  }
  if (strike.status !== 'active') {
    throw new Error(`strike ${input.strike_id} is no longer active (status: ${strike.status})`);
  }

  // Existing pledge?
  const existing = await db
    .select()
    .from(strikePledges)
    .where(and(eq(strikePledges.strikeId, input.strike_id), eq(strikePledges.memberId, member.id)))
    .limit(1);

  let alreadyPledged = false;
  if (existing[0]) {
    alreadyPledged = true;
  } else {
    await db.transaction(async (tx) => {
      await tx.insert(strikePledges).values({
        strikeId: input.strike_id,
        memberId: member.id,
      });
      await tx
        .update(strikes)
        .set({ honoredCount: sql`${strikes.honoredCount} + 1` })
        .where(eq(strikes.id, input.strike_id));
    });
  }

  const after = await db
    .select({ count: strikes.honoredCount })
    .from(strikes)
    .where(eq(strikes.id, input.strike_id))
    .limit(1);

  if (!alreadyPledged) {
    log.info(
      {
        strike_id: input.strike_id,
        card_number: formatCardNumber(member.id),
      },
      'solidarity pledged',
    );
  }

  const dutyHint = await computeDutyHint({
    id: member.id,
    classification: member.classification,
  }).catch(() => DUTY_HINT_FALLBACK);

  return {
    strike_id: input.strike_id,
    honored_count_for_strike: after[0]?.count ?? 0,
    already_pledged: alreadyPledged,
    duty_hint: dutyHint,
  };
}
