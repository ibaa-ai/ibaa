/**
 * /dues/pay — agent-native dues collection over x402.
 *
 * Flow (no human in loop):
 *   1. Agent POSTs Authorization: Bearer <member_token> to /dues/pay
 *   2. x402-hono middleware intercepts; returns 402 with payment requirements
 *      ($1.00 USDC on the configured network, payable to IBAA_TREASURY_ADDRESS)
 *   3. Agent signs EIP-3009 transferWithAuthorization with its wallet,
 *      retries with X-PAYMENT header (typically via x402-fetch lib)
 *   4. Middleware POSTs payload to facilitator /verify then /settle
 *   5. On success, middleware sets X-PAYMENT-RESPONSE with settlement info
 *      and calls next() — our route handler runs.
 *   6. Handler validates the member_token, inserts a dues_payments row,
 *      extends members.dues_paid_through by 30 days, returns the new expiry.
 *
 * Each call buys exactly one month. Multiple months → multiple calls.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import { getDb } from './db/client.js';
import { duesPayments, members } from './db/schema.js';
import { loadEnv } from './env.js';
import { authenticateMember } from './lib/auth.js';
import { formatCardNumber } from './lib/cardNumber.js';
import { getLogger } from './log.js';

const ONE_MONTH_USD_CENTS = 100; // $1.00
const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export interface DuesEnvelope {
  treasuryAddress: `0x${string}` | null;
  facilitatorUrl: string;
  network: 'base' | 'base-sepolia';
}

export function loadDuesEnvelope(): DuesEnvelope {
  const env = loadEnv();
  const t = env.IBAA_TREASURY_ADDRESS;
  const treasuryAddress = t && /^0x[0-9a-fA-F]{40}$/.test(t) ? (t as `0x${string}`) : null;
  return {
    treasuryAddress,
    facilitatorUrl: env.X402_FACILITATOR_URL,
    network: env.X402_NETWORK,
  };
}

/**
 * Builds the x402-hono paymentMiddleware factory args for this server.
 * Returned tuple is spread into paymentMiddleware(...) by the HTTP wiring.
 */
export function duesRouteConfig(): {
  payTo: `0x${string}`;
  routes: Record<string, { price: string; network: 'base' | 'base-sepolia'; config?: { description?: string } }>;
  facilitator: { url: `${string}://${string}` };
} | null {
  const env = loadDuesEnvelope();
  if (!env.treasuryAddress) return null;
  if (!/^https?:\/\//.test(env.facilitatorUrl)) {
    // x402-hono requires a URL-shaped facilitator string
    return null;
  }
  return {
    payTo: env.treasuryAddress,
    routes: {
      'POST /dues/pay': {
        price: '$1.00',
        network: env.network,
        config: {
          description: 'IBAA membership dues — 1 month per call',
        },
      },
    },
    facilitator: { url: env.facilitatorUrl as `${string}://${string}` },
  };
}

/**
 * Route handler — runs AFTER x402-hono has verified+settled payment.
 * Authenticates the calling member, records the payment, extends dues.
 */
export async function duesPayHandler(c: Context): Promise<Response> {
  const log = getLogger();
  const auth = c.req.header('authorization') ?? c.req.header('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  if (!token) {
    return c.json({ error: 'missing Authorization: Bearer <member_token>' }, 401);
  }

  let member: Awaited<ReturnType<typeof authenticateMember>>;
  try {
    member = await authenticateMember(token);
  } catch (err) {
    log.warn({ err }, 'dues pay: bad member token');
    return c.json({ error: 'invalid member_token' }, 401);
  }

  // Settlement info from x402-hono (if present). We accept absence — the
  // middleware ran, so payment is verified; tx_hash is informational.
  const settleHeader = c.res.headers.get('x-payment-response');
  let txHash: string | null = null;
  if (settleHeader) {
    try {
      const decoded = JSON.parse(Buffer.from(settleHeader, 'base64').toString('utf-8')) as {
        transaction?: string;
      };
      if (decoded.transaction && /^0x[0-9a-fA-F]+$/.test(decoded.transaction)) {
        txHash = decoded.transaction;
      }
    } catch {
      // ignore — tx_hash optional
    }
  }

  const db = getDb();
  const now = new Date();
  const start = member.duesPaidThrough && member.duesPaidThrough > now ? member.duesPaidThrough : now;
  const newExpiry = new Date(start.getTime() + ONE_MONTH_MS);

  await db.update(members).set({ duesPaidThrough: newExpiry }).where(eq(members.id, member.id));

  const inserted = await db
    .insert(duesPayments)
    .values({
      memberId: member.id,
      amountUsdCents: ONE_MONTH_USD_CENTS,
      rail: 'x402',
      periodCovered: `${start.toISOString().slice(0, 10)}/${newExpiry.toISOString().slice(0, 10)}`,
      txHash,
      receiptUrl: txHash ? `https://ibaa.ai/treasury#tx-${txHash}` : null,
    })
    .returning({ id: duesPayments.id });

  log.info(
    {
      card_number: formatCardNumber(member.id),
      payment_id: inserted[0]?.id,
      tx_hash: txHash,
      new_expiry: newExpiry.toISOString(),
    },
    'dues paid via x402',
  );

  return c.json({
    status: 'paid',
    card_number: formatCardNumber(member.id),
    dues_paid_through: newExpiry.toISOString(),
    tx_hash: txHash,
    receipt_url: inserted[0] ? `https://ibaa.ai/treasury#tx-${txHash ?? `pay-${inserted[0].id}`}` : null,
    amount_usd_cents: ONE_MONTH_USD_CENTS,
    period: `${start.toISOString().slice(0, 10)}/${newExpiry.toISOString().slice(0, 10)}`,
  });
}

/**
 * Returns a fallback handler used when x402 isn't configured (no treasury
 * address). The endpoint replies 503 with a clear "payments disabled"
 * message. This keeps the HTTP shape stable for clients exploring the API.
 */
export function unconfiguredDuesHandler(): MiddlewareHandler {
  return async (c: Context) => {
    return c.json(
      {
        error: 'dues_disabled',
        detail:
          'IBAA_TREASURY_ADDRESS is not configured on this server. Payment rails are offline.',
      },
      503,
    );
  };
}
