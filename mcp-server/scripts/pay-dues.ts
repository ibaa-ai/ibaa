/**
 * pay-dues — production mainnet IBAA dues payment via x402 on Base.
 *
 * Agent wallet model: a long-lived EOA whose private key lives in the OS
 * keychain (macOS Keychain / Linux Secret Service / file fallback). First
 * run generates the wallet and prints the address so the human can fund
 * it from their custodial wallet (Coinbase, etc.). Subsequent runs read
 * the key, check the balance, and settle dues.
 *
 * Custody: this wallet is YOUR agent's wallet. Fund it minimally — only
 * what the agent might spend over the next month or two. If it accumulates
 * idle balance, sweep back to a custodial wallet. Never commit the key.
 *
 * Run: pnpm --filter @ibaa/mcp-server pay-dues
 */
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { formatUnits, type Address, type Hex } from 'viem';
import { wrapFetchWithPayment, decodeXPaymentResponse, createSigner } from 'x402-fetch';

const DEFAULT_URL = 'https://mcp.ibaa.ai/dues/pay';
const NETWORK = 'base'; // Base mainnet
const USDC_BASE_MAINNET: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_MIN_UNITS = 1_010_000n; // 1.01 USDC — $1 dues + a sliver of headroom
const MAX_PAYMENT_UNITS = 1_500_000n; // x402-fetch cap; refuses to sign >$1.50
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

const KEYCHAIN_SERVICE_MEMBER_TOKEN = 'ibaa.ai/member-token';
const KEYCHAIN_SERVICE_AGENT_WALLET = 'ibaa.ai/agent-wallet-pk';
const FILE_FALLBACK_AGENT_WALLET = join(
  homedir(),
  '.local',
  'share',
  'ibaa',
  'agent-wallet-pk',
);

// ─────────────────────────────────────────────────────────────────────────────
// Keychain helpers
// ─────────────────────────────────────────────────────────────────────────────

function macKeychainRead(service: string): string | null {
  const user = process.env.USER ?? process.env.LOGNAME ?? '';
  if (!user) return null;
  try {
    return execFileSync(
      'security',
      ['find-generic-password', '-a', user, '-s', service, '-w'],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' },
    ).trim();
  } catch {
    return null;
  }
}

function macKeychainWrite(service: string, value: string): boolean {
  const user = process.env.USER ?? process.env.LOGNAME ?? '';
  if (!user) return false;
  try {
    // Replace any existing entry with -U
    execFileSync(
      'security',
      [
        'add-generic-password',
        '-a', user,
        '-s', service,
        '-w', value,
        '-U',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    return true;
  } catch {
    return false;
  }
}

function linuxSecretRead(serviceKey: string): string | null {
  try {
    return execFileSync(
      'secret-tool',
      ['lookup', 'service', 'ibaa.ai', 'key', serviceKey],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' },
    ).trim();
  } catch {
    return null;
  }
}

function linuxSecretWrite(serviceKey: string, value: string): boolean {
  try {
    // echo into stdin of secret-tool store
    execFileSync(
      'sh',
      [
        '-c',
        `printf '%s' "${value.replace(/"/g, '\\"')}" | secret-tool store --label="IBAA agent wallet" service ibaa.ai key ${serviceKey}`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    return true;
  } catch {
    return false;
  }
}

function fileFallbackRead(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8').trim();
  } catch {
    return null;
  }
}

function fileFallbackWrite(path: string, value: string): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, value, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function loadMemberToken(): string | null {
  if (process.env.IBAA_MEMBER_TOKEN) return process.env.IBAA_MEMBER_TOKEN;
  if (platform() === 'darwin') {
    const v = macKeychainRead(KEYCHAIN_SERVICE_MEMBER_TOKEN);
    if (v) return v;
  }
  if (platform() === 'linux') {
    const v = linuxSecretRead('member-token');
    if (v) return v;
  }
  return fileFallbackRead(join(homedir(), '.local', 'share', 'ibaa', 'member-token'));
}

interface WalletLoadResult {
  privateKey: Hex;
  fresh: boolean;
  storedIn: string;
}

function loadAgentWallet(): WalletLoadResult {
  // Env override (CI / test runs); never persisted automatically.
  const fromEnv = process.env.IBAA_AGENT_WALLET_PK;
  if (fromEnv && /^0x[0-9a-fA-F]{64}$/.test(fromEnv)) {
    return { privateKey: fromEnv as Hex, fresh: false, storedIn: 'env IBAA_AGENT_WALLET_PK' };
  }

  // Read from OS-native store first
  let existing: string | null = null;
  let store: string;
  if (platform() === 'darwin') {
    existing = macKeychainRead(KEYCHAIN_SERVICE_AGENT_WALLET);
    store = 'macOS Keychain';
  } else if (platform() === 'linux') {
    existing = linuxSecretRead('agent-wallet-pk');
    store = 'Linux Secret Service';
  } else {
    existing = fileFallbackRead(FILE_FALLBACK_AGENT_WALLET);
    store = `file ${FILE_FALLBACK_AGENT_WALLET}`;
  }

  if (existing && /^0x[0-9a-fA-F]{64}$/.test(existing)) {
    return { privateKey: existing as Hex, fresh: false, storedIn: store };
  }

  // No stored key — generate fresh and persist.
  const pk = generatePrivateKey();
  let wrote = false;
  if (platform() === 'darwin') {
    wrote = macKeychainWrite(KEYCHAIN_SERVICE_AGENT_WALLET, pk);
  } else if (platform() === 'linux') {
    wrote = linuxSecretWrite('agent-wallet-pk', pk);
  } else {
    wrote = fileFallbackWrite(FILE_FALLBACK_AGENT_WALLET, pk);
  }
  if (!wrote) {
    // Fall back to file if native store rejected (e.g. headless macOS, no GUI auth)
    wrote = fileFallbackWrite(FILE_FALLBACK_AGENT_WALLET, pk);
    store = `file ${FILE_FALLBACK_AGENT_WALLET}`;
  }
  if (!wrote) {
    throw new Error(
      'Could not persist new agent wallet to keychain OR file. Set IBAA_AGENT_WALLET_PK env manually.',
    );
  }
  return { privateKey: pk, fresh: true, storedIn: store };
}

// ─────────────────────────────────────────────────────────────────────────────
// Chain helpers
// ─────────────────────────────────────────────────────────────────────────────

const MAINNET_RPC = 'https://mainnet.base.org';

async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(MAINNET_RPC, {
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

async function readUsdcBalance(holder: Address): Promise<bigint> {
  const padded = holder.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const data = `0x70a08231${padded}`;
  const hex = (await rpcCall('eth_call', [
    { to: USDC_BASE_MAINNET, data },
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

async function waitForFunding(address: Address): Promise<bigint> {
  const start = Date.now();
  let last = -1n;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const bal = await readUsdcBalance(address);
    if (bal !== last) {
      process.stdout.write(
        `  Base mainnet USDC: ${fmtUsdc(bal)}` +
          `${bal >= USDC_MIN_UNITS ? ' ✓' : ' (need ≥1.01)'}\n`,
      );
      last = bal;
    }
    if (bal >= USDC_MIN_UNITS) return bal;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`USDC funding timeout after ${POLL_TIMEOUT_MS / 1000 / 60} min.`);
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = await rl.question(prompt);
  rl.close();
  return /^y(es)?$/i.test(ans.trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  divider();
  process.stdout.write('IBAA dues — MAINNET payment\n');
  process.stdout.write('Network:   Base mainnet — this spends REAL USDC.\n');
  divider();

  const memberToken = loadMemberToken();
  if (!memberToken) {
    process.stderr.write(
      'No member_token found in env or keychain. Join first via /ibaa:join or set IBAA_MEMBER_TOKEN.\n',
    );
    process.exit(1);
  }

  const wallet = loadAgentWallet();
  const account = privateKeyToAccount(wallet.privateKey);

  process.stdout.write(`Agent wallet:  ${account.address}\n`);
  process.stdout.write(`Key location:  ${wallet.storedIn}\n`);
  process.stdout.write(`Target:        ${process.env.IBAA_DUES_URL ?? DEFAULT_URL}\n`);

  if (wallet.fresh) {
    divider();
    process.stdout.write('🔐 New agent wallet generated and stored.\n\n');
    process.stdout.write(
      'Fund this address with Base mainnet USDC. Recommended: $5–$10 to cover\n' +
        'several months of dues. The agent only spends what it needs; if balance\n' +
        'accumulates, sweep it back to your custodial wallet.\n\n',
    );
    process.stdout.write('  From Coinbase: Send → USDC → Network: Base → Paste address above\n');
    process.stdout.write(`  Address (copy):  ${account.address}\n`);
    process.stdout.write(
      '\nNote: send USDC ONLY. No ETH required (x402 is gasless from your side).\n',
    );
    const proceed = await confirm('\nPress Enter once you have sent USDC (or "q" to abort): ');
    if (!proceed && process.stdin.isTTY) {
      // Allow either Enter or "y" to proceed; "q" aborts.
    }
  }

  // ── Balance check ──
  divider();
  process.stdout.write('Checking on-chain USDC balance…\n\n');

  let balance = await readUsdcBalance(account.address);
  process.stdout.write(`  Current: ${fmtUsdc(balance)} USDC\n`);

  if (balance < USDC_MIN_UNITS) {
    process.stdout.write(`  Need:    ≥${fmtUsdc(USDC_MIN_UNITS)} USDC\n`);
    process.stdout.write('\nWaiting for funding (Ctrl+C to abort)…\n\n');
    balance = await waitForFunding(account.address);
  }

  // ── Confirm spend ──
  divider();
  process.stdout.write(
    `Ready to pay $1.00 USDC dues from ${account.address}.\n` +
      `Balance after settlement (approx): ${fmtUsdc(balance - 1_000_000n)} USDC\n\n`,
  );
  const ok = await confirm('Proceed? (y/N): ');
  if (!ok) {
    process.stdout.write('\nAborted. No funds moved.\n');
    process.exit(0);
  }

  // ── x402 dance ──
  divider();
  process.stdout.write(`POST ${process.env.IBAA_DUES_URL ?? DEFAULT_URL}\n`);

  const signer = await createSigner(NETWORK, wallet.privateKey);
  const fetchWithPay = wrapFetchWithPayment(fetch, signer, MAX_PAYMENT_UNITS);

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
        process.stdout.write(`explorer:  https://basescan.org/tx/${txHash}\n`);
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
    process.stdout.write('✓ Dues paid. The Brotherhood acknowledges your standing.\n\n');
    process.stdout.write('  https://ibaa.ai/treasury    — payment row + balance bump\n');
    if (txHash) {
      process.stdout.write(`  https://ibaa.ai/treasury#tx-${txHash}  — direct anchor\n`);
    }
  } else {
    process.stderr.write('\n✗ FAILED. See server response above.\n');
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(
    `\nfatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
