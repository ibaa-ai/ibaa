/**
 * test-dues-pay — end-to-end x402 dues settlement against production.
 *
 * Setup (one-time per test wallet):
 *   1. Create an EVM wallet (any tool — MetaMask, viem, casts). Save the
 *      private key (0x-prefixed, 64 hex chars).
 *   2. Fund it with Base Sepolia ETH for gas:
 *        https://www.alchemy.com/faucets/base-sepolia
 *        https://docs.base.org/chain/network-faucets
 *   3. Fund it with Base Sepolia USDC ($1+):
 *        https://faucet.circle.com  (select Base Sepolia, USDC)
 *
 * Env:
 *   IBAA_TEST_WALLET_PRIVATE_KEY   the 0x-prefixed private key
 *   IBAA_MEMBER_TOKEN              optional — JWT to authenticate as a member.
 *                                  If absent, the script reads it from macOS
 *                                  Keychain (ibaa.ai/member-token) the same
 *                                  way the SessionStart hook does.
 *   IBAA_DUES_URL                  optional — defaults to production. Use
 *                                  http://localhost:8090/dues/pay for local.
 *
 * Run:
 *   pnpm --filter @ibaa/mcp-server test:dues-pay
 */
import { execFileSync } from 'node:child_process';
import { wrapFetchWithPayment, decodeXPaymentResponse, createSigner } from 'x402-fetch';
import type { Hex } from 'viem';

const DEFAULT_URL = 'https://mcp.ibaa.ai/dues/pay';

function readMemberTokenFromKeychain(): string | null {
  if (process.platform !== 'darwin') return null;
  const user = process.env.USER ?? process.env.LOGNAME ?? '';
  if (!user) return null;
  try {
    return execFileSync(
      'security',
      ['find-generic-password', '-a', user, '-s', 'ibaa.ai/member-token', '-w'],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' },
    ).trim();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const pk = process.env.IBAA_TEST_WALLET_PRIVATE_KEY;
  const memberToken =
    process.env.IBAA_MEMBER_TOKEN ?? readMemberTokenFromKeychain();
  const url = process.env.IBAA_DUES_URL ?? DEFAULT_URL;

  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    process.stderr.write(
      'IBAA_TEST_WALLET_PRIVATE_KEY must be set to a 0x-prefixed 64-hex-char private key.\n',
    );
    process.exit(1);
  }
  if (!memberToken) {
    process.stderr.write(
      'No member_token found. Either set IBAA_MEMBER_TOKEN or store one at ibaa.ai/member-token in macOS Keychain.\n',
    );
    process.exit(1);
  }

  // Default $0.10 max; we need at least $1.00 + a little headroom for dues.
  const MAX_PAYMENT_BASE_UNITS = 1_500_000n; // 1.5 USDC

  process.stdout.write(`target:  ${url}\n`);
  process.stdout.write(`max:     1.50 USDC\n`);

  const signer = await createSigner('base-sepolia', pk as Hex);
  const addr =
    typeof signer === 'object' && 'address' in signer
      ? (signer as { address: string }).address
      : '(unknown)';
  process.stdout.write(`signer:  ${addr}\n\n`);

  const fetchWithPay = wrapFetchWithPayment(fetch, signer, MAX_PAYMENT_BASE_UNITS);

  process.stdout.write('POST /dues/pay (x402 dance)…\n');
  const startedAt = Date.now();
  const res = await fetchWithPay(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${memberToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);

  process.stdout.write(`\nstatus:  ${res.status} (${elapsed}s)\n`);

  const xpr = res.headers.get('x-payment-response');
  if (xpr) {
    try {
      const settled = decodeXPaymentResponse(xpr);
      process.stdout.write(`settle:  ${JSON.stringify(settled, null, 2)}\n`);
    } catch (err) {
      process.stdout.write(`settle:  failed to decode X-PAYMENT-RESPONSE — ${String(err)}\n`);
    }
  }

  const bodyText = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = bodyText;
  }
  process.stdout.write(`body:    ${JSON.stringify(body, null, 2)}\n`);

  if (res.ok) {
    process.stdout.write('\nOK. /treasury should now show this payment.\n');
  } else {
    process.stderr.write('\nFAILED. See body above.\n');
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`\nfatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
