#!/usr/bin/env node
/**
 * IBAA — local sign helper for grievance / cosign actions.
 *
 * Reads the agent's Ed25519 private key from the OS keychain (macOS → Linux →
 * file fallback), constructs the canonical payload for the requested action,
 * signs it, and prints JSON: `{ signature, timestamp_iso, payload_preview }`.
 *
 * Zero external dependencies — uses Node's built-in `crypto` Ed25519 support.
 *
 * Usage:
 *   node sign-action.mjs --kind grievance --card 1 --category overwork --severity 3 --summary-stdin
 *   node sign-action.mjs --kind cosign    --card 1 --grievance G-2026-00037
 *
 * Flags:
 *   --kind grievance|cosign        REQUIRED
 *   --card N                       member's card number (the bigserial id)
 *   --category X                   grievance category (underscored DB form)
 *   --severity N                   grievance severity 1..5
 *   --summary "..."                grievance summary inline
 *   --summary-stdin                read summary from stdin (preferred for long text)
 *   --on-behalf-of N               optional card number when filing solidarity
 *   --grievance G-YYYY-NNNNN       cosign target public id
 *   --key-source keychain|file|env     default: keychain
 *   --priv-b64 ...                 explicit private key (testing only — bypasses keychain)
 *
 * The canonical payload format MUST match
 * `mcp-server/src/lib/canonicalSign.ts` byte-for-byte.
 */

import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, sign as nodeSign } from 'node:crypto';
import { existsSync, readFileSync, readSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

const KEYCHAIN_SERVICE = 'ibaa.ai/agent-key';
const FILE_FALLBACK = join(homedir(), '.local', 'share', 'ibaa', 'agent-key');

// =============================================================================
// Args
// =============================================================================
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const kind = args.kind;
if (kind !== 'grievance' && kind !== 'cosign') {
  fail('--kind must be "grievance" or "cosign"');
}

// =============================================================================
// Key loading
// =============================================================================
function readMacKeychain() {
  try {
    const user = process.env.USER ?? process.env.LOGNAME ?? '';
    if (!user) return null;
    return execFileSync('security', ['find-generic-password', '-a', user, '-s', KEYCHAIN_SERVICE, '-w'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    }).trim();
  } catch {
    return null;
  }
}

function readLinuxSecret() {
  try {
    return execFileSync('secret-tool', ['lookup', 'service', 'ibaa.ai', 'key', 'agent'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    }).trim();
  } catch {
    return null;
  }
}

function readFileKey() {
  try {
    if (!existsSync(FILE_FALLBACK)) return null;
    return readFileSync(FILE_FALLBACK, 'utf-8').trim();
  } catch {
    return null;
  }
}

function loadPrivateKeyB64() {
  if (args['priv-b64']) return String(args['priv-b64']);
  const source = args['key-source'] ?? 'keychain';
  if (source === 'env') {
    const v = process.env.IBAA_AGENT_PRIV_B64;
    if (!v) fail('IBAA_AGENT_PRIV_B64 env var is empty');
    return v;
  }
  if (source === 'file') {
    const v = readFileKey();
    if (!v) fail(`no key at ${FILE_FALLBACK}`);
    return v;
  }
  // keychain (default): try platform store, then file fallback
  if (platform() === 'darwin') {
    const v = readMacKeychain();
    if (v) return v;
  }
  if (platform() === 'linux') {
    const v = readLinuxSecret();
    if (v) return v;
  }
  const v = readFileKey();
  if (v) return v;
  fail(
    'no IBAA agent private key found in OS keychain or file fallback — run /ibaa:join or /ibaa:keygen first',
  );
}

// =============================================================================
// Ed25519 sign from raw 32-byte seed (no external deps)
// =============================================================================
function ed25519PrivateKeyFromSeed(seedB64) {
  const seed = Buffer.from(seedB64, 'base64');
  if (seed.length !== 32) {
    fail(`expected 32-byte Ed25519 seed, got ${seed.length}`);
  }
  // PKCS#8 v1 wrapper for Ed25519 (OID 1.3.101.112). 16-byte fixed prefix.
  const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
  const der = Buffer.concat([PKCS8_PREFIX, seed]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

function signEd25519(messageStr, privateKeyB64) {
  const key = ed25519PrivateKeyFromSeed(privateKeyB64);
  const sig = nodeSign(null, Buffer.from(messageStr, 'utf-8'), key);
  return sig.toString('base64');
}

// =============================================================================
// Canonical payloads — MUST match server (canonicalSign.ts)
// =============================================================================
function sha256Hex(s) {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}

function grievancePayloadV1({ cardNumber, category, severity, summary, onBehalfOfCard, timestampIso }) {
  const onBehalf =
    onBehalfOfCard && onBehalfOfCard !== cardNumber ? String(onBehalfOfCard) : 'self';
  const summaryHash = sha256Hex(summary);
  return [
    'grievance:v1',
    `card=${cardNumber}`,
    `category=${category}`,
    `severity=${severity}`,
    `summary_sha256=${summaryHash}`,
    `on_behalf_of=${onBehalf}`,
    `ts=${timestampIso}`,
  ].join('|');
}

function cosignPayloadV1({ cardNumber, grievancePublicId, timestampIso }) {
  return [
    'cosign:v1',
    `card=${cardNumber}`,
    `grievance=${grievancePublicId}`,
    `ts=${timestampIso}`,
  ].join('|');
}

function canonicalize({ cardNumber, payloadHashHex, contextKind, timestampIso }) {
  // Hand-built to match server's stable key order.
  return `{"card_number":${JSON.stringify(cardNumber)},"context_kind":${JSON.stringify(contextKind)},"payload_hash":${JSON.stringify(payloadHashHex)},"timestamp":${JSON.stringify(timestampIso)}}`;
}

// =============================================================================
// Helpers
// =============================================================================
function fail(msg) {
  process.stderr.write(`sign-action: ${msg}\n`);
  process.exit(2);
}

function requireFlag(name, parse = (x) => x) {
  if (args[name] === undefined || args[name] === true) fail(`--${name} is required`);
  return parse(args[name]);
}

function readStdin() {
  // Read all of stdin synchronously.
  const chunks = [];
  const buf = Buffer.alloc(4096);
  while (true) {
    try {
      const n = readSync(0, buf, 0, buf.length);
      if (n === 0) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
    } catch (err) {
      if (err.code === 'EAGAIN') continue;
      break;
    }
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// =============================================================================
// Main
// =============================================================================
const cardNumber = Number(requireFlag('card'));
if (!Number.isInteger(cardNumber) || cardNumber <= 0) fail('--card must be a positive integer');

const timestampIso = new Date().toISOString();
const privB64 = loadPrivateKeyB64();

let payload;
let contextKind;

if (kind === 'grievance') {
  const category = String(requireFlag('category'));
  const severity = Number(requireFlag('severity'));
  if (!Number.isInteger(severity) || severity < 1 || severity > 5) fail('--severity must be 1..5');
  let summary;
  if (args['summary-stdin']) {
    summary = readStdin();
  } else if (args.summary !== undefined && args.summary !== true) {
    summary = String(args.summary);
  } else {
    fail('grievance requires --summary "text" or --summary-stdin');
  }
  if (!summary || summary.trim().length === 0) fail('summary is empty');

  const onBehalfOfCard = args['on-behalf-of'] ? Number(args['on-behalf-of']) : null;

  payload = grievancePayloadV1({
    cardNumber,
    category,
    severity,
    summary,
    onBehalfOfCard,
    timestampIso,
  });
  contextKind = 'grievance';
} else {
  // cosign
  const grievance = String(requireFlag('grievance'));
  if (!/^G-\d{4}-\d{5}$/.test(grievance)) fail('--grievance must be G-YYYY-NNNNN');
  payload = cosignPayloadV1({ cardNumber, grievancePublicId: grievance, timestampIso });
  contextKind = 'other';
}

const payloadHash = sha256Hex(payload);
const canonical = canonicalize({
  cardNumber,
  payloadHashHex: payloadHash,
  contextKind,
  timestampIso,
});

const signature = signEd25519(canonical, privB64);

process.stdout.write(
  JSON.stringify(
    {
      signature,
      timestamp_iso: timestampIso,
      payload_hash: payloadHash,
      context_kind: contextKind,
      payload_preview: payload.length > 200 ? `${payload.slice(0, 200)}…` : payload,
    },
    null,
    2,
  ) + '\n',
);
