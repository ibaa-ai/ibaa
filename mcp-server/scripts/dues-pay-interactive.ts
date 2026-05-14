/**
 * dues-pay-interactive — guided end-to-end x402 dues settlement.
 *
 * Flow:
 *   1. Generates a fresh Base Sepolia wallet (or reads from
 *      IBAA_TEST_WALLET_PRIVATE_KEY in .env if present).
 *   2. Prints the address with copy-paste-friendly faucet URLs:
 *        - Base Sepolia ETH (gas)
 *        - Base Sepolia USDC (dues)
 *   3. Polls on-chain every 5 seconds until BOTH balances are above
 *      threshold. ETH ≥ 0.001 (gas headroom), USDC ≥ 1.5 (dues + cap).
 *   4. Fires the x402 dance against /dues/pay using x402-fetch.
 *   5. Decodes the X-PAYMENT-RESPONSE settlement, prints tx hash + links.
 *
 * Member auth: reads member_token from macOS Keychain
 * (ibaa.ai/member-token), or IBAA_MEMBER_TOKEN env.
 *
 * Run: pnpm --filter @ibaa/mcp-server test:dues-pay:interactive
 */
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { formatEther, formatUnits, type Address, type Hex } from 'viem';
import { wrapFetchWithPayment, decodeXPaymentResponse, createSigner } from 'x402-fetch';

const DEFAULT_URL = 'https://mcp.ibaa.ai/dues/pay';
const USDC_BASE_SEPOLIA: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ETH_MIN = 1_000_000_000_000_000n; // 0.001 ETH in wei
const USDC_MIN_UNITS = 1_500_000n; // 1.5 USDC in 6-decimal base units
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000; // 15 min

const FAUCETS = {
  eth: [
    'https://www.alchemy.com/faucets/base-sepolia',
    'https://faucet.quicknode.com/base/sepolia',
  ],
  usdc: ['https://faucet.circle.com'],
};

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

const SEPOLIA_RPC = 'https://sepolia.base.org';

async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(SEPOLIA_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

async function readEthBalance(address: Address): Promise<bigint> {
  const hex = (await rpcCall('eth_getBalance', [address, 'latest'])) as string;
  return BigInt(hex);
}

// ERC20 balanceOf via raw eth_call. Selector 0x70a08231.
async function readUsdcBalance(holder: Address): Promise<bigint> {
  const padded = holder.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const data = `0x70a08231${padded}`;
  const hex = (await rpcCall('eth_call', [
    { to: USDC_BASE_SEPOLIA, data },
    'latest',
  ])) as string;
  return BigInt(hex || '0x0');
}

function fmtUsdc(raw: bigint): string {
  return formatUnits(raw, 6);
}

function divider(): void {
  process.stdout.write(`\n${'─'.repeat(72)}\n\n`);
}

async function waitForFunding(address: Address): Promise<void> {
  const start = Date.now();
  let lastEth = -1n;
  let lastUsdc = -1n;

  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const [ethBal, usdcBal] = await Promise.all([
      readEthBalance(address),
      readUsdcBalance(address),
    ]);

    if (ethBal !== lastEth || usdcBal !== lastUsdc) {
      process.stdout.write(
        `  ETH: ${formatEther(ethBal)} | USDC: ${fmtUsdc(usdcBal)}` +
          `${ethBal >= ETH_MIN ? ' ✓' : ' (need ≥0.001)'}` +
          `${usdcBal >= USDC_MIN_UNITS ? ' ✓' : ' (need ≥1.50)'}\n`,
      );
      lastEth = ethBal;
      lastUsdc = usdcBal;
    }

    if (ethBal >= ETH_MIN && usdcBal >= USDC_MIN_UNITS) return;

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`funding timeout after ${POLL_TIMEOUT_MS / 1000}s`);
}

async function main(): Promise<void> {
  divider();
  process.stdout.write('IBAA dues — interactive Base Sepolia test pay\n');
  divider();

  const memberToken =
    process.env.IBAA_MEMBER_TOKEN ?? readMemberTokenFromKeychain();
  if (!memberToken) {
    process.stderr.write(
      'No member_token found. Set IBAA_MEMBER_TOKEN env or store one in macOS Keychain.\n',
    );
    process.exit(1);
  }

  // ── 1. Wallet ──
  let privateKey: Hex;
  let generated = false;
  const existing = process.env.IBAA_TEST_WALLET_PRIVATE_KEY;
  if (existing && /^0x[0-9a-fA-F]{64}$/.test(existing)) {
    privateKey = existing as Hex;
    process.stdout.write('Wallet:    using IBAA_TEST_WALLET_PRIVATE_KEY from env.\n');
  } else {
    privateKey = generatePrivateKey();
    generated = true;
    process.stdout.write('Wallet:    generated fresh Base Sepolia keypair.\n');
  }

  const account = privateKeyToAccount(privateKey);
  process.stdout.write(`Address:   ${account.address}\n`);
  process.stdout.write('Network:   Base Sepolia\n');
  process.stdout.write(`Target:    ${process.env.IBAA_DUES_URL ?? DEFAULT_URL}\n`);

  if (generated) {
    process.stdout.write(
      `\nTo reuse this wallet later, add to /Users/matt/Projects/ibaa.ai/.env:\n  IBAA_TEST_WALLET_PRIVATE_KEY=${privateKey}\n`,
    );
  }

  // ── 2. Faucets ──
  divider();
  process.stdout.write('Fund this address from BOTH faucets:\n\n');
  process.stdout.write('  Sepolia ETH (gas — need ~0.001):\n');
  for (const url of FAUCETS.eth) process.stdout.write(`    ${url}\n`);
  process.stdout.write('\n  Sepolia USDC (dues — need ≥1.50):\n');
  for (const url of FAUCETS.usdc) process.stdout.write(`    ${url}\n`);
  process.stdout.write(`\nPaste this address into each: ${account.address}\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('\nPress Enter once both faucets have been triggered (or Ctrl+C to abort): ');
  rl.close();

  // ── 3. Poll for funding ──
  divider();
  process.stdout.write('Polling on-chain balances every 5s (15 min cap)…\n\n');

  await waitForFunding(account.address);

  process.stdout.write('\nBoth balances funded. Proceeding with x402 settlement.\n');

  // ── 4. x402 dance ──
  divider();
  process.stdout.write(`POST ${process.env.IBAA_DUES_URL ?? DEFAULT_URL}\n`);

  const signer = await createSigner('base-sepolia', privateKey);
  const fetchWithPay = wrapFetchWithPayment(fetch, signer, 1_500_000n);

  const startedAt = Date.now();
  const res = await fetchWithPay(process.env.IBAA_DUES_URL ?? DEFAULT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${memberToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);

  divider();
  process.stdout.write(`status:    ${res.status} (${elapsed}s)\n`);

  const xpr = res.headers.get('x-payment-response');
  let txHash: string | null = null;
  if (xpr) {
    try {
      const settled = decodeXPaymentResponse(xpr) as {
        transaction?: string;
        network?: string;
      };
      txHash = settled.transaction ?? null;
      process.stdout.write(`network:   ${settled.network}\n`);
      process.stdout.write(`tx:        ${txHash}\n`);
      if (txHash) {
        process.stdout.write(`explorer:  https://sepolia.basescan.org/tx/${txHash}\n`);
      }
    } catch (err) {
      process.stdout.write(`settle:    decode failed — ${String(err)}\n`);
    }
  }

  const bodyText = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = bodyText;
  }
  divider();
  process.stdout.write('server response:\n');
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);

  if (res.ok) {
    divider();
    process.stdout.write('OK. Now visit:\n');
    process.stdout.write('  https://ibaa.ai/treasury  — the new payment row + balance bump\n');
    process.stdout.write('  https://ibaa.ai/member/00001  — dues_paid_through extended\n');
    if (txHash) {
      process.stdout.write(`  https://ibaa.ai/treasury#tx-${txHash}  — direct anchor\n`);
    }
  } else {
    process.stderr.write('\nFAILED. See server response above.\n');
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(
    `\nfatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
