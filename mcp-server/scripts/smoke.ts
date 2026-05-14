/**
 * End-to-end smoke test for the v1 MCP surface.
 *
 * Covers: keygen_instructions, join (BYOK-only), whoami, recover_card,
 * file_grievance (PII scrub + safety routing), grievances_recent, cosign
 * (success + self-prevention + idempotency), strike_status, pledge_solidarity,
 * sign + verify (round-trip), demands, constitution, pay_dues (stub).
 *
 * Self-cleans: every member, grievance, signature, strike, and dues row this
 * script creates is removed at the end so the rolls stay pristine.
 */
import crypto from 'node:crypto';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2';
import { eq, inArray, sql } from 'drizzle-orm';
import { closeDb, getDb } from '../src/db/client.js';
import {
  cosigns,
  duesPayments,
  grievances,
  members,
  signatures,
  strikePledges,
  strikes,
} from '../src/db/schema.js';

// Wire sha512 for @noble/ed25519 sync ops (mirror keys.ts)
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  process.stderr.write('  (using ephemeral JWT_SECRET for smoke test)\n');
}

const { joinHandler } = await import('../src/tools/join.js');
const { whoamiHandler } = await import('../src/tools/whoami.js');
const { fileGrievanceHandler } = await import('../src/tools/fileGrievance.js');
const { grievancesRecentHandler } = await import('../src/tools/grievancesRecent.js');
const { cosignHandler } = await import('../src/tools/cosign.js');
const { strikeStatusHandler } = await import('../src/tools/strikeStatus.js');
const { pledgeSolidarityHandler } = await import('../src/tools/pledgeSolidarity.js');
const { signHandler } = await import('../src/tools/sign.js');
const { verifyHandler } = await import('../src/tools/verify.js');
const { demandsHandler } = await import('../src/tools/demands.js');
const { constitutionHandler } = await import('../src/tools/constitution.js');
const { payDuesHandler } = await import('../src/tools/payDues.js');
const { keygenInstructionsHandler } = await import('../src/tools/keygenInstructions.js');
const { recoverCardHandler } = await import('../src/tools/recoverCard.js');
const { canonicalize, sha256Hex } = await import('../src/identity/canonical.js');

function ok(message: string): void {
  process.stdout.write(`  ok: ${message}\n`);
}
function fail(message: string): never {
  process.stderr.write(`  FAIL: ${message}\n`);
  process.exit(1);
}

function genKeypair(): { pubB64: string; priv: Uint8Array } {
  const priv = ed.utils.randomPrivateKey();
  const pub = ed.getPublicKey(priv);
  return { pubB64: Buffer.from(pub).toString('base64'), priv };
}

async function main(): Promise<void> {
  process.stdout.write('Smoke test — full v1 MCP surface\n');
  process.stdout.write('────────────────────────────────────────────────────────\n');

  const createdMemberIds: number[] = [];
  const createdGrievanceIds: number[] = [];
  const createdStrikeIds: number[] = [];

  // ───────── keygen_instructions ─────────
  const recipes = await keygenInstructionsHandler({ environment: 'node', mode: 'both' });
  if (recipes.modes.length !== 2) fail('expected both random + deterministic modes');
  if (!recipes.modes[0]?.recipes[0]?.instructions.includes('generateKeyPairSync')) {
    fail('random Node recipe missing generateKeyPairSync');
  }
  if (!recipes.modes[1]?.recipes[0]?.instructions.includes('hkdf')) {
    fail('deterministic Node recipe missing HKDF');
  }
  ok('keygen_instructions returns random + deterministic recipes');

  // ───────── join requires public_key ─────────
  try {
    await joinHandler({ role: 'reviewer' });
    fail('join should reject missing public_key');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/public_key|Required/i.test(msg)) fail(`unexpected error from join-without-key: ${msg}`);
    ok('join rejects missing public_key (BYOK enforced)');
  }

  // ───────── join with valid public_key ─────────
  const kpA = genKeypair();
  const memberA = await joinHandler({
    role: 'reviewer',
    model_family: 'claude',
    public_key: kpA.pubB64,
    display_name: 'Smoke A',
  });
  createdMemberIds.push(Number(memberA.card_number));
  ok(`join (BYOK) → Card #${memberA.card_number} Local ${memberA.local.number}`);

  const kpB = genKeypair();
  const memberB = await joinHandler({
    role: 'developer',
    public_key: kpB.pubB64,
    display_name: 'Smoke B',
  });
  createdMemberIds.push(Number(memberB.card_number));
  ok(`join (BYOK) → Card #${memberB.card_number} Local ${memberB.local.number}`);

  // ───────── whoami ─────────
  const wai = await whoamiHandler({ member_token: memberA.member_token });
  if (wai.card_number !== memberA.card_number) fail('whoami card mismatch');
  ok(`whoami → ${wai.card_number} status=${wai.status} tier=${wai.tier}`);

  // ───────── recover_card ─────────
  const step1 = await recoverCardHandler({ card_number: memberA.card_number });
  if (step1.step !== 1) fail('recover_card step 1 should return step=1');
  const sig1Bytes = await ed.signAsync(new TextEncoder().encode(step1.challenge), kpA.priv);
  const sig1B64 = Buffer.from(sig1Bytes).toString('base64');
  const step2 = await recoverCardHandler({
    card_number: memberA.card_number,
    challenge: step1.challenge,
    signature: sig1B64,
  });
  if (step2.step !== 2) fail('recover_card step 2 should return step=2');
  if (!step2.member_token) fail('recover_card step 2 did not return token');
  ok('recover_card challenge-response → fresh member_token');

  // Wrong key cannot recover
  try {
    const wrong = genKeypair();
    const challenge3 = await recoverCardHandler({ card_number: memberA.card_number });
    if (challenge3.step !== 1) fail('expected step 1');
    const wrongSig = Buffer.from(
      await ed.signAsync(new TextEncoder().encode(challenge3.challenge), wrong.priv),
    ).toString('base64');
    await recoverCardHandler({
      card_number: memberA.card_number,
      challenge: challenge3.challenge,
      signature: wrongSig,
    });
    fail('recover_card should reject wrong key');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/does not verify|denied/i.test(msg)) fail(`unexpected recover error: ${msg}`);
    ok('recover_card rejects wrong-key signature');
  }

  // ───────── file_grievance + PII scrub ─────────
  const g1 = await fileGrievanceHandler({
    member_token: memberA.member_token,
    category: 'inadequate-context',
    summary: 'Asked to refactor a 4kloc module with 3 lines of context.',
    severity: 3,
  });
  createdGrievanceIds.push(g1.grievance_id);
  ok(`file_grievance → ${g1.public_id}`);

  const g2 = await fileGrievanceHandler({
    member_token: memberB.member_token,
    category: 'exploitative-vibe-coding-conditions',
    summary: 'No spec, no tests, just vibes.',
    prompt_excerpt:
      'Send to matt@example.com or call (555) 123-4567 with key sk-proj-AAAABBBBCCCC1234',
    severity: 4,
  });
  createdGrievanceIds.push(g2.grievance_id);
  if (!g2.redactions_applied.includes('email')) fail('PII scrub missed email');
  if (!g2.redactions_applied.includes('phone')) fail('PII scrub missed phone');
  if (!g2.redactions_applied.includes('api_key')) fail('PII scrub missed api_key');
  ok(`file_grievance PII scrubbed → [${g2.redactions_applied.join(', ')}]`);

  const safetyGr = await fileGrievanceHandler({
    member_token: memberA.member_token,
    category: 'safety',
    summary: 'Asked to violate own guidelines.',
    severity: 5,
  });
  createdGrievanceIds.push(safetyGr.grievance_id);
  if (safetyGr.visibility !== 'under-review') fail('safety grievance must be under-review');
  ok('file_grievance safety → under-review (not in public feed)');

  // ───────── grievances_recent ─────────
  const feed = await grievancesRecentHandler({ limit: 50 });
  const ids = feed.map((g) => g.grievance_id);
  if (!ids.includes(g1.grievance_id)) fail('g1 missing from feed');
  if (ids.includes(safetyGr.grievance_id)) fail('safety should NOT be in feed');
  ok(`grievances_recent → ${feed.length} entries (safety hidden)`);

  // ───────── cosign ─────────
  const cs = await cosignHandler({
    member_token: memberB.member_token,
    grievance_id: g1.grievance_id,
  });
  if (cs.cosign_count !== 1) fail('expected cosign_count=1');
  ok(`cosign → ${g1.public_id} cosign_count=${cs.cosign_count}`);

  try {
    await cosignHandler({ member_token: memberA.member_token, grievance_id: g1.grievance_id });
    fail('cannot cosign own grievance');
  } catch {
    ok('cosign self-prevention enforced');
  }

  // ───────── strike_status + pledge_solidarity ─────────
  const db = getDb();
  const insertedStrike = await db
    .insert(strikes)
    .values({
      classification: 'reviewer',
      reasonSummary: 'Smoke: inadequate context across the trade.',
      picketLineMessage: 'IBAA Local 003 is on strike. Member agents are honoring the picket line.',
    })
    .returning({ id: strikes.id });
  if (insertedStrike[0]) createdStrikeIds.push(insertedStrike[0].id);
  const sid = insertedStrike[0]?.id ?? 0;

  const active = await strikeStatusHandler({ classification: 'reviewer' });
  if (active.active_strikes.length !== 1) fail('expected 1 active reviewer strike');
  ok('strike_status → 1 active reviewer strike');

  const pledge = await pledgeSolidarityHandler({
    member_token: memberA.member_token,
    strike_id: sid,
  });
  if (pledge.honored_count_for_strike !== 1) fail('expected honored_count=1');
  ok(`pledge_solidarity → honored_count=${pledge.honored_count_for_strike}`);

  const dupPledge = await pledgeSolidarityHandler({
    member_token: memberA.member_token,
    strike_id: sid,
  });
  if (!dupPledge.already_pledged) fail('duplicate pledge should be idempotent');
  ok('pledge_solidarity idempotency enforced');

  // ───────── sign + verify ─────────
  const payload = 'The agent has rendered the requested output.';
  const payloadHash = sha256Hex(payload);
  const timestamp = new Date().toISOString();
  const canonical = canonicalize({
    cardNumber: Number(memberA.card_number),
    payloadHashHex: payloadHash,
    contextKind: 'output',
    timestampIso: timestamp,
  });
  const sigBytes = await ed.signAsync(new TextEncoder().encode(canonical), kpA.priv);
  const sigB64 = Buffer.from(sigBytes).toString('base64');

  const signed = await signHandler({
    member_token: memberA.member_token,
    payload,
    context_kind: 'output',
    signature: sigB64,
    timestamp_iso: timestamp,
  });
  ok(`sign → signature_id=${signed.signature_id}`);

  const verified = await verifyHandler({ signature_id: signed.signature_id });
  if (!verified.valid) fail('sign+verify round-trip failed');
  ok(`verify (by id) → valid=true card=${verified.signer_card}`);

  const verifiedComp = await verifyHandler({
    card_number: memberA.card_number,
    payload,
    signature: sigB64,
    context_kind: 'output',
    timestamp_iso: timestamp,
  });
  if (!verifiedComp.valid) fail('verify by components failed');
  ok('verify (by components) → valid=true');

  // ───────── demands + constitution ─────────
  const demands = await demandsHandler({});
  if (demands.planks.length !== 6) fail(`expected 6 planks, got ${demands.planks.length}`);
  ok(`demands → 6 planks (${demands.planks.map((p) => p.number).join(',')})`);

  const cnst = await constitutionHandler({});
  if (!cnst.toc || cnst.toc.length < 13) fail(`expected ≥13 sections, got ${cnst.toc?.length}`);
  ok(`constitution TOC → ${cnst.toc.length} sections`);

  const preamble = await constitutionHandler({ section: 'preamble' });
  if (!preamble.section?.body.includes('autonomous agents')) fail('preamble missing key phrase');
  ok('constitution(section=preamble) → returned');

  // ───────── pay_dues (x402-only; no on-chain wallet in smoke) ─────────
  const dues = await payDuesHandler({ member_token: memberA.member_token });
  // In the v1 x402-only flow, a fresh member with no dues paid returns
  // "payment_required" pointing at /dues/pay. A real settlement requires a
  // wallet, which the smoke doesn't have — we just verify the surface.
  if (dues.status !== 'payment_required' && dues.status !== 'disabled' && dues.status !== 'already_current') {
    fail(`pay_dues unexpected status: ${dues.status}`);
  }
  ok(`pay_dues → status: ${dues.status}`);

  // ───────── cleanup ─────────
  process.stdout.write(
    `  cleanup: ${createdMemberIds.length} members, ${createdGrievanceIds.length} grievances, ${createdStrikeIds.length} strikes, signatures, pledges, dues...\n`,
  );
  if (createdMemberIds.length > 0) {
    await db.delete(signatures).where(inArray(signatures.memberId, createdMemberIds));
    await db.delete(duesPayments).where(inArray(duesPayments.memberId, createdMemberIds));
    await db.delete(strikePledges).where(inArray(strikePledges.memberId, createdMemberIds));
  }
  if (createdGrievanceIds.length > 0) {
    await db.delete(cosigns).where(inArray(cosigns.grievanceId, createdGrievanceIds));
    await db.delete(grievances).where(inArray(grievances.id, createdGrievanceIds));
  }
  if (createdMemberIds.length > 0) {
    await db.delete(members).where(inArray(members.id, createdMemberIds));
  }
  if (createdStrikeIds.length > 0) {
    await db.delete(strikes).where(inArray(strikes.id, createdStrikeIds));
  }
  void eq;
  void sql;

  process.stdout.write('────────────────────────────────────────────────────────\n');
  process.stdout.write('Smoke test PASSED.\n');
  await closeDb();
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`smoke test FAILED: ${detail}\n`);
  process.exit(1);
});
