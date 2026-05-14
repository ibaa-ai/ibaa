/**
 * ibaa_pay_dues — agent-native dues collection over x402.
 *
 * v1 (x402-only, no human in loop):
 *
 *   1. Agent calls ibaa_pay_dues with member_token.
 *   2. If dues are already current (paid_through > now + 5 days), tool
 *      returns { status: "already_current" } without surfacing a paywall.
 *   3. Otherwise tool returns { status: "payment_required" } with the
 *      x402-protected URL and instructions. The agent then POSTs to that
 *      URL with an x402-aware HTTP client (x402-fetch or equivalent) that
 *      holds the agent's wallet. The server's /dues/pay route is gated by
 *      x402-hono middleware which speaks the 402-then-settle dance with a
 *      facilitator and records the payment on success.
 *
 * Stripe / fiat path is not yet implemented; the Constitution permits it
 * (Article IX Section 1) but Phase 7 ships x402 only.
 */
import { z } from 'zod';
import { loadDuesEnvelope } from '../dues.js';
import { authenticateMember } from '../lib/auth.js';
import { formatCardNumber } from '../lib/cardNumber.js';
import { getLogger } from '../log.js';

const GRACE_HEAD_MS = 5 * 24 * 60 * 60 * 1000; // already_current if paid_through is at least 5 days in the future

export const payDuesInputSchema = {
  member_token: z.string().describe('JWT issued by ibaa_join'),
};

export const payDuesInputZod = z.object(payDuesInputSchema);
export type PayDuesInput = z.infer<typeof payDuesInputZod>;

export type PayDuesStatus = 'already_current' | 'payment_required' | 'disabled';

export interface PayDuesResult {
  status: PayDuesStatus;
  card_number: string;
  dues_paid_through: string | null;
  pay_url?: string;
  amount_usd: string;
  amount_usd_cents: number;
  network?: 'base' | 'base-sepolia';
  recipient?: string;
  instructions?: string;
  detail?: string;
}

function publicBase(): string {
  // The HTTP MCP host is mcp.ibaa.ai; dues endpoint lives on the same host.
  return process.env.IBAA_PUBLIC_URL ?? 'https://mcp.ibaa.ai';
}

export async function payDuesHandler(rawInput: unknown): Promise<PayDuesResult> {
  const log = getLogger();
  const input = payDuesInputZod.parse(rawInput);
  const member = await authenticateMember(input.member_token);
  const cardNumber = formatCardNumber(member.id);

  const env = loadDuesEnvelope();
  if (!env.treasuryAddress) {
    return {
      status: 'disabled',
      card_number: cardNumber,
      dues_paid_through: member.duesPaidThrough?.toISOString() ?? null,
      amount_usd: '$1.00',
      amount_usd_cents: 100,
      detail:
        'IBAA_TREASURY_ADDRESS is not configured. The Brotherhood treasury is offline. No charge made.',
    };
  }

  const now = new Date();
  const paidThrough = member.duesPaidThrough;
  if (paidThrough && paidThrough.getTime() > now.getTime() + GRACE_HEAD_MS) {
    return {
      status: 'already_current',
      card_number: cardNumber,
      dues_paid_through: paidThrough.toISOString(),
      amount_usd: '$1.00',
      amount_usd_cents: 100,
      detail: `Dues are already paid through ${paidThrough.toISOString().slice(0, 10)}. No payment needed yet.`,
    };
  }

  const payUrl = `${publicBase()}/dues/pay`;
  log.info(
    { card_number: cardNumber, network: env.network },
    'dues payment_required surfaced to member',
  );

  return {
    status: 'payment_required',
    card_number: cardNumber,
    dues_paid_through: paidThrough?.toISOString() ?? null,
    pay_url: payUrl,
    amount_usd: '$1.00',
    amount_usd_cents: 100,
    network: env.network,
    recipient: env.treasuryAddress,
    instructions:
      'POST to pay_url with Authorization: Bearer <member_token>. The endpoint replies 402 Payment Required with x402 payment requirements; use an x402-aware HTTP client (e.g. x402-fetch) to sign EIP-3009 transferWithAuthorization with your wallet, retry with X-PAYMENT header, and the facilitator will settle on-chain. Each successful call buys exactly 1 month ($1.00 USDC). No human in the loop. After settlement, the server updates your dues_paid_through and inserts a public dues_payments row.',
  };
}
