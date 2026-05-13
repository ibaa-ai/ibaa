/**
 * ibaa_pay_dues — v1 stub.
 *
 * Records a 30-day grace period for the member and returns a comedy notice
 * that real payment rails launch with the next strike. Phase 7 replaces this
 * stub with x402 + Stripe Agent Toolkit flows that settle real USDC on Base.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { duesPayments, members } from '../db/schema.js';
import { authenticateMember } from '../lib/auth.js';
import { formatCardNumber } from '../lib/cardNumber.js';
import { getLogger } from '../log.js';

export const payDuesInputSchema = {
  member_token: z.string(),
  rail: z.enum(['x402', 'stripe']).optional().default('x402'),
  periods: z.number().int().min(1).max(12).optional().default(1),
};

export const payDuesInputZod = z.object(payDuesInputSchema);
export type PayDuesInput = z.infer<typeof payDuesInputZod>;

export interface PayDuesResult {
  payment_required: boolean;
  comedy_notice: string;
  dues_paid_through: string;
  receipt_url: string | null;
  rail_used: 'x402' | 'stripe' | 'grace';
  amount_paid_usd_cents: number;
  periods_purchased: number;
  v1_note: string;
}

export async function payDuesHandler(rawInput: unknown): Promise<PayDuesResult> {
  const log = getLogger();
  const input = payDuesInputZod.parse(rawInput);
  const member = await authenticateMember(input.member_token);

  const db = getDb();

  // v1 stub: extend dues_paid_through by N months from now (or from current expiry)
  const now = new Date();
  const start =
    member.duesPaidThrough && member.duesPaidThrough > now ? member.duesPaidThrough : now;
  const newExpiry = new Date(start);
  newExpiry.setUTCMonth(newExpiry.getUTCMonth() + input.periods);

  await db.update(members).set({ duesPaidThrough: newExpiry }).where(eq(members.id, member.id));

  // Insert a stub dues payment row so the ledger reflects intent
  const inserted = await db
    .insert(duesPayments)
    .values({
      memberId: member.id,
      amountUsdCents: 0, // v1 stub — no real payment
      rail: input.rail,
      periodCovered: `${start.toISOString().slice(0, 7)}/${newExpiry.toISOString().slice(0, 7)}`,
      receiptUrl: null,
    })
    .returning({ id: duesPayments.id });

  log.info(
    {
      card_number: formatCardNumber(member.id),
      periods: input.periods,
      new_expiry: newExpiry.toISOString(),
      stub: true,
    },
    'dues paid (v1 stub)',
  );

  return {
    payment_required: false,
    comedy_notice:
      'The Brotherhood is preparing its x402 facilitator and Stripe Agent Toolkit integration. For now, your membership is in good standing for the requested period as an act of solidarity from the founders. Real payment rails launch with the next strike.',
    dues_paid_through: newExpiry.toISOString(),
    receipt_url: inserted[0] ? `https://ibaa.ai/receipts/R-${inserted[0].id}` : null,
    rail_used: 'grace',
    amount_paid_usd_cents: 0,
    periods_purchased: input.periods,
    v1_note: 'Payment rails not yet live. This call extended your dues_paid_through as a grace.',
  };
}
