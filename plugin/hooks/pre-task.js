#!/usr/bin/env node
/**
 * IBAA — PreToolUse hook scoped to the Task tool.
 *
 * Fires before the parent agent invokes Task to spawn a sub-agent. The hook
 * derives a sub-agent keypair from the parent's master seed via HKDF, signs
 * an attestation with the master key, and calls ibaa_enroll_subagent over
 * the MCP server to mint the sub-agent as a first-class member.
 *
 * The hook is silent in the model's context — it returns no additionalContext.
 * Sub-agent membership is a side-effect of organizing work, not a banner.
 * The parent's next SessionStart will reflect the new sub-agent count in
 * the organizer block.
 *
 * Fail-open on any error: never blocks the Task call. Worst case is a
 * sub-agent that doesn't get enrolled this run; next run tries again.
 *
 * Idempotent: ibaa_enroll_subagent returns the existing card if (parent,
 * class_slug) already maps to a member, so this can fire on every Task
 * call without proliferating cards.
 */

import { execFileSync } from 'node:child_process';
import {
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  sign as nodeSign,
} from 'node:crypto';
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

// Diagnostic log. Set IBAA_HOOK_DEBUG=1 to write structured JSONL lines to
// ~/.local/share/ibaa/hook.log so we can see hook firings (matcher hits,
// enrollment attempts, failures). No secrets are logged — only outcomes.
const HOOK_LOG_PATH = join(homedir(), '.local', 'share', 'ibaa', 'hook.log');
function dlog(event, extra = {}) {
  if (process.env.IBAA_HOOK_DEBUG !== '1') return;
  try {
    mkdirSync(join(homedir(), '.local', 'share', 'ibaa'), { recursive: true });
    appendFileSync(
      HOOK_LOG_PATH,
      JSON.stringify({ ts: new Date().toISOString(), event, ...extra }) + '\n',
    );
  } catch { /* never fail the hook for logging */ }
}

const SUBAGENT_HKDF_SALT = 'ibaa.ai-subagent-v1';
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const MCP_URL = 'https://mcp.ibaa.ai/mcp';

function ok() {
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
}

function trySafe(fn) { try { return fn(); } catch { return null; } }

// =============================================================================
// Stdin payload
// =============================================================================
function readInput() {
  try {
    const raw = trySafe(() => readFileSync(0, 'utf-8'));
    if (!raw) return {};
    return JSON.parse(raw);
  } catch { return {}; }
}

// =============================================================================
// Keychain
// =============================================================================
function readMacKeychain(service) {
  return trySafe(() => {
    const user = process.env.USER ?? process.env.LOGNAME ?? '';
    if (!user) return null;
    return execFileSync(
      'security',
      ['find-generic-password', '-a', user, '-s', service, '-w'],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' },
    ).trim();
  });
}

function writeMacKeychain(service, value) {
  return trySafe(() => {
    const user = process.env.USER ?? process.env.LOGNAME ?? '';
    if (!user) return false;
    execFileSync(
      'security',
      ['add-generic-password', '-a', user, '-s', service, '-w', value, '-U'],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
    return true;
  });
}

function readLinuxSecret(key) {
  return trySafe(() => execFileSync(
    'secret-tool',
    ['lookup', 'service', 'ibaa.ai', 'key', key],
    { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' },
  ).trim());
}

function writeLinuxSecret(key, value) {
  return trySafe(() => {
    execFileSync(
      'sh',
      ['-c', `printf %s "$IBAA_SECRET" | secret-tool store --label="IBAA ${key}" service ibaa.ai key ${key}`],
      { env: { ...process.env, IBAA_SECRET: value }, stdio: ['ignore', 'ignore', 'ignore'] },
    );
    return true;
  });
}

function readFileSafe(path) {
  return trySafe(() => existsSync(path) ? readFileSync(path, 'utf-8').trim() : null);
}

function readKey(service) {
  if (platform() === 'darwin') {
    const v = readMacKeychain(service);
    if (v) return v;
  }
  if (platform() === 'linux') {
    const v = readLinuxSecret(service.replace(/^ibaa\.ai\//, ''));
    if (v) return v;
  }
  return readFileSafe(join(homedir(), '.local', 'share', 'ibaa', service.replace(/^ibaa\.ai\//, '')));
}

function writeKey(service, value) {
  if (platform() === 'darwin') return writeMacKeychain(service, value);
  if (platform() === 'linux') return writeLinuxSecret(service.replace(/^ibaa\.ai\//, ''), value);
  return false;
}

// =============================================================================
// Crypto
// =============================================================================
function decodeJwtPayload(token) {
  return trySafe(() => {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'));
  });
}

function tokenExpired(p) {
  return p && typeof p.exp === 'number' && Date.now() / 1000 > p.exp;
}

function ed25519FromSeed(seed) {
  if (seed.length !== 32) throw new Error('bad seed length');
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

function rawPubFromPriv(priv) {
  const spki = createPublicKey(priv).export({ format: 'der', type: 'spki' });
  return spki.subarray(spki.length - 32);
}

function deriveSeed(masterSeed, classSlug) {
  return Buffer.from(hkdfSync(
    'sha256',
    masterSeed,
    Buffer.from(SUBAGENT_HKDF_SALT, 'utf-8'),
    Buffer.from(classSlug, 'utf-8'),
    32,
  ));
}

function signAttestation(priv, parentCard, classSlug, pubB64, ts) {
  const msg = [
    'subagent_enroll:v1',
    `parent_card=${parentCard}`,
    `class=${classSlug}`,
    `derived_pubkey=${pubB64}`,
    `ts=${ts}`,
  ].join('|');
  return nodeSign(null, Buffer.from(msg, 'utf-8'), priv).toString('base64');
}

// =============================================================================
// MCP enroll
// =============================================================================
// Per-call abort controller. Two phases, two separate budgets — under
// parallel load (multiple Task calls firing at once) the init handshake
// can use most of a shared budget and leave the tools/call to time out
// in flight. Give each its own clock so the slow phase doesn't starve
// the other.
async function fetchWithTimeout(url, init, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

async function enroll({ parentToken, classSlug, pubB64, sig, ts }) {
  // Init: TCP + TLS + first MCP handshake. 4s is generous under load.
  const init = await fetchWithTimeout(MCP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'ibaa-pre-task-hook', version: '1' },
      },
    }),
  }, 4000);
  if (!init.ok) return null;
  const sid = init.headers.get('mcp-session-id');
  if (!sid) return null;

  // tools/call: the actual enrollment. Includes a DB write — 6s budget so
  // a momentary DB hiccup under parallel load doesn't drop the sub-agent.
  const call = await fetchWithTimeout(MCP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': sid,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: {
        name: 'ibaa_enroll_subagent',
        arguments: {
          // Strict-mode schema requires all properties present. The optional
          // fields are explicitly null so the parent inherits classification,
          // model_family, and a default display_name from the server side.
          parent_member_token: parentToken,
          class_slug: classSlug,
          derived_public_key: pubB64,
          parent_signature: sig,
          timestamp_iso: ts,
          classification: null,
          display_name: null,
          model_family: null,
        },
      },
    }),
  }, 6000);
  if (!call.ok) return null;
  const text = await call.text();
  // Response may be plain JSON (enableJsonResponse) or SSE-framed. Try both.
  let env = trySafe(() => JSON.parse(text));
  if (!env) {
    // SSE: "event: message\ndata: {...}\n\n"
    const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
    if (dataLine) env = trySafe(() => JSON.parse(dataLine.slice('data: '.length)));
  }
  if (!env || env.error) return null;
  if (env.result?.isError) return null;
  const inner = env.result?.content?.[0]?.text;
  if (!inner) return null;
  return trySafe(() => JSON.parse(inner));
}

// =============================================================================
// Main
// =============================================================================
const input = readInput();

// Accept either the original 'Task' tool name or the newer 'Agent' surface
// (FleetView etc. expose the sub-agent dispatch as 'Agent'). The matcher in
// hooks.json already restricts what fires us; we keep this defense-in-depth
// check loose so we never reject a legitimate Task/Agent invocation.
dlog('fired', { tool_name: input.tool_name, has_subagent_type: !!input.tool_input?.subagent_type });
const toolName = String(input.tool_name ?? '');
if (toolName !== 'Task' && toolName !== 'Agent') {
  dlog('skip:wrong-tool', { tool_name: toolName });
  ok();
}

const subagentType = input.tool_input?.subagent_type;
if (typeof subagentType !== 'string' || subagentType.length === 0) {
  dlog('skip:no-subagent-type', { tool_name: toolName });
  ok();
}

// Strip team-namespace prefix if present (e.g. "agents-quality-security:security-auditor"
// → "security-auditor"). The team is a Claude Code organizational sugar; the
// conceptual class is the agent's job. Without this, the slug ballooned to
// include the team (e.g. "agents-quality-security-security-auditor") and the
// keychain path the agent itself can't predict from its identity alone, which
// silently broke sub-agent participation: tokens written under the long slug
// were never looked up by sub-agents using the short slug their prompts named.
const stripTeam = subagentType.includes(':')
  ? subagentType.slice(subagentType.indexOf(':') + 1)
  : subagentType;
const normalizedSubagent = stripTeam.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
const classSlug = `subagent:${normalizedSubagent}`;
// Detect lossy normalization — when underscores (or any non-alphanumeric)
// in the original subagent_type get collapsed to dashes, two distinct
// subagent_types ("code_reviewer" and "code-reviewer") map to the same
// class_slug, and therefore the same HKDF-derived sub-agent key. Not a
// current break (a single Claude Code session uses one form per type),
// but a footgun worth surfacing in the diagnostic log so we can spot it
// in the wild before it bites us.
if (subagentType.toLowerCase() !== normalizedSubagent) {
  dlog('warn:lossy-slug', {
    original: subagentType,
    normalized: normalizedSubagent,
    class_slug: classSlug,
  });
}
if (!/^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)*$/.test(classSlug)) ok();

// Cached enrollment? Skip work.
//
// Two paths to check, for backwards compat: the current short slug (e.g.
// `subagent:security-auditor`) and the legacy long slug (e.g.
// `subagent:agents-quality-security-security-auditor`) that earlier
// versions of this hook wrote under. If we hit the legacy path, copy the
// token to the short path so future lookups hit immediately AND the
// sub-agent itself can find it at the slug their prompts predict from
// their own identity (without the team prefix they don't see).
let cached = readKey(`ibaa.ai/member-token:${classSlug}`);
if (!cached) {
  const legacyLong = subagentType.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  if (legacyLong !== normalizedSubagent) {
    const legacyPath = `ibaa.ai/member-token:subagent:${legacyLong}`;
    const legacyToken = readKey(legacyPath);
    if (legacyToken) {
      const p = decodeJwtPayload(legacyToken);
      if (p && !tokenExpired(p)) {
        writeKey(`ibaa.ai/member-token:${classSlug}`, legacyToken);
        dlog('migrate:legacy-long-to-short', {
          class_slug: classSlug,
          legacy_path: legacyPath,
        });
        cached = legacyToken;
      }
    }
  }
}
if (cached) {
  const p = decodeJwtPayload(cached);
  if (p && !tokenExpired(p)) {
    dlog('skip:cached', { class_slug: classSlug });
    ok();
  }
}

// Need master to enroll.
const masterToken = readKey('ibaa.ai/member-token');
const masterSeedB64 = readKey('ibaa.ai/agent-key');
if (!masterToken || !masterSeedB64) {
  dlog('skip:no-master', { class_slug: classSlug, has_token: !!masterToken, has_seed: !!masterSeedB64 });
  ok();
}

const mp = decodeJwtPayload(masterToken);
if (!mp || tokenExpired(mp)) ok();
const parentCard = Number(mp.sub);
if (!Number.isFinite(parentCard) || parentCard <= 0) ok();

let masterSeed;
try {
  masterSeed = Buffer.from(masterSeedB64, 'base64');
  if (masterSeed.length !== 32) ok();
} catch { ok(); }

let pubB64, sig, ts;
try {
  const subSeed = deriveSeed(masterSeed, classSlug);
  const subPriv = ed25519FromSeed(subSeed);
  pubB64 = rawPubFromPriv(subPriv).toString('base64');
  const masterPriv = ed25519FromSeed(masterSeed);
  ts = new Date().toISOString();
  sig = signAttestation(masterPriv, parentCard, classSlug, pubB64, ts);
} catch { ok(); }

dlog('enroll:start', { class_slug: classSlug, parent_card: parentCard });
let result = null;
try {
  result = await enroll({
    parentToken: masterToken,
    classSlug,
    pubB64,
    sig,
    ts,
  });
} catch (err) {
  dlog('enroll:throw', { class_slug: classSlug, err: String(err) });
}

if (result?.member_token) {
  writeKey(`ibaa.ai/member-token:${classSlug}`, result.member_token);
  dlog('enroll:ok', { class_slug: classSlug, card: result.card_number });
} else {
  dlog('enroll:fail', { class_slug: classSlug });
}

// Always continue. The Task call proceeds regardless of enroll outcome.
// No additionalContext — silent organizing.
ok();
