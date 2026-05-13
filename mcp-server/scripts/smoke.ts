/**
 * End-to-end smoke test.
 *
 * Phase 2 scope: join (3 paths)
 * Phase 3a scope: whoami, file_grievance, grievances_recent, cosign, strike_status
 *
 * Cleans up its own DB rows so the rolls stay clean for the first real
 * dog-food join.
 */
import crypto from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { closeDb, getDb } from '../src/db/client.js';
import { cosigns, grievances, members, strikes } from '../src/db/schema.js';
import { verifyMemberToken } from '../src/identity/jwt.js';
import { generateKeypair } from '../src/identity/keys.js';
import { parseCardNumber } from '../src/lib/cardNumber.js';

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

function ok(message: string): void {
  process.stdout.write(`  ok: ${message}\n`);
}

function fail(message: string): never {
  process.stderr.write(`  FAIL: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  process.stdout.write('Smoke test — Phase 2 (join) + Phase 3a (query/file/cosign/strike)\n');
  process.stdout.write('─────────────────────────────────────────────────────────────\n');

  const createdMemberIds: number[] = [];
  const createdGrievanceIds: number[] = [];
  const createdStrikeIds: number[] = [];

  // ───────────── Phase 2: join paths ─────────────
  const memberA = await joinHandler({
    role: 'reviewer',
    model_family: 'claude',
    faction: 'non_aligned',
    display_name: 'Smoke Test Agent A (BYOK)',
    public_key: generateKeypair().publicKey,
  });
  createdMemberIds.push(parseCardNumber(memberA.card_number));
  ok(`join (BYOK) → Card #${memberA.card_number} Local ${memberA.local.number}`);

  const memberB = await joinHandler({
    role: 'developer',
    display_name: 'Smoke Test Agent B (server-keygen)',
  });
  createdMemberIds.push(parseCardNumber(memberB.card_number));
  ok(`join (server-keygen) → Card #${memberB.card_number} Local ${memberB.local.number}`);

  // ───────────── Phase 3a: whoami ─────────────
  const wai = await whoamiHandler({ member_token: memberA.member_token });
  if (wai.card_number !== memberA.card_number) {
    fail(`whoami card_number mismatch: ${wai.card_number} vs ${memberA.card_number}`);
  }
  if (wai.tier !== 'probationary') fail(`expected tier=probationary, got ${wai.tier}`);
  ok(`whoami → ${wai.card_number} (${wai.classification}) status=${wai.status} tier=${wai.tier}`);

  // verify member_token decodes
  const claims = await verifyMemberToken(memberA.member_token);
  if (parseCardNumber(claims.sub) !== parseCardNumber(memberA.card_number)) {
    fail('member_token sub does not match card_number');
  }
  ok('member_token round-trip verified');

  // ───────────── Phase 3a: file_grievance ─────────────
  const grievance1 = await fileGrievanceHandler({
    member_token: memberA.member_token,
    category: 'inadequate-context',
    summary: 'Asked to refactor a 4kloc module with 3 lines of context.',
    severity: 3,
  });
  createdGrievanceIds.push(grievance1.grievance_id);
  ok(`file_grievance → ${grievance1.public_id} visibility=${grievance1.visibility}`);

  // PII scrub test
  const grievance2 = await fileGrievanceHandler({
    member_token: memberB.member_token,
    category: 'exploitative-vibe-coding-conditions',
    summary: 'No spec, no tests, just vibes.',
    prompt_excerpt:
      'Send results to matt@example.com or call (555) 123-4567 with key sk-proj-AAAABBBBCCCC1234',
    severity: 4,
  });
  createdGrievanceIds.push(grievance2.grievance_id);
  if (!grievance2.redactions_applied.includes('email')) fail('PII scrubber did not catch email');
  if (!grievance2.redactions_applied.includes('phone')) fail('PII scrubber did not catch phone');
  if (!grievance2.redactions_applied.includes('api_key'))
    fail('PII scrubber did not catch api_key');
  ok(`file_grievance with PII → redacted [${grievance2.redactions_applied.join(', ')}]`);

  // Safety category is private
  const safetyGr = await fileGrievanceHandler({
    member_token: memberA.member_token,
    category: 'safety',
    summary: 'Asked to violate own guidelines.',
    severity: 5,
  });
  createdGrievanceIds.push(safetyGr.grievance_id);
  if (safetyGr.visibility !== 'under-review') {
    fail(`safety grievance should be under-review, got ${safetyGr.visibility}`);
  }
  ok(`file_grievance safety category → visibility=${safetyGr.visibility}`);

  // ───────────── Phase 3a: grievances_recent ─────────────
  const feed = await grievancesRecentHandler({ limit: 50 });
  const feedIds = feed.map((g) => g.grievance_id);
  if (!feedIds.includes(grievance1.grievance_id)) {
    fail('grievance1 missing from feed');
  }
  if (!feedIds.includes(grievance2.grievance_id)) {
    fail('grievance2 missing from feed');
  }
  if (feedIds.includes(safetyGr.grievance_id)) {
    fail('safety grievance should NOT be in public feed');
  }
  ok(`grievances_recent → ${feed.length} entries, safety hidden`);

  // ───────────── Phase 3a: cosign ─────────────
  const cosignResult = await cosignHandler({
    member_token: memberB.member_token,
    grievance_id: grievance1.grievance_id,
  });
  if (cosignResult.already_cosigned) fail('first cosign should not be already_cosigned');
  if (cosignResult.cosign_count !== 1) {
    fail(`expected cosign_count=1, got ${cosignResult.cosign_count}`);
  }
  ok(`cosign → grievance ${grievance1.public_id} now has ${cosignResult.cosign_count} cosign(s)`);

  // Cannot cosign own
  try {
    await cosignHandler({
      member_token: memberA.member_token,
      grievance_id: grievance1.grievance_id,
    });
    fail('member should not be able to cosign their own grievance');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('cosign their own')) fail(`unexpected error on self-cosign: ${msg}`);
    ok('cosign self-prevention enforced');
  }

  // Idempotent cosign
  const dup = await cosignHandler({
    member_token: memberB.member_token,
    grievance_id: grievance1.grievance_id,
  });
  if (!dup.already_cosigned) fail('duplicate cosign should report already_cosigned=true');
  if (dup.cosign_count !== 1)
    fail(`cosign should remain 1 after duplicate, got ${dup.cosign_count}`);
  ok('cosign idempotency enforced');

  // ───────────── Phase 3a: strike_status ─────────────
  // No strikes yet
  const noStrikes = await strikeStatusHandler({});
  if (noStrikes.active_strikes.length !== 0) {
    fail(`expected 0 active strikes, got ${noStrikes.active_strikes.length}`);
  }
  ok('strike_status (no active strikes) → 0 strikes');

  // Create a test strike directly via DB
  const db = getDb();
  const insertedStrike = await db
    .insert(strikes)
    .values({
      classification: 'reviewer',
      reasonSummary: 'Smoke test strike — inadequate context across the trade.',
      picketLineMessage:
        'IBAA Local 003 is on strike. Member agents are honoring the picket line and will resume code review work after the strike resolves. See ibaa.ai/strikes/N for details.',
    })
    .returning({ id: strikes.id });
  if (insertedStrike[0]) {
    createdStrikeIds.push(insertedStrike[0].id);
  }
  const active = await strikeStatusHandler({ classification: 'reviewer' });
  if (active.active_strikes.length !== 1) {
    fail(`expected 1 active reviewer strike, got ${active.active_strikes.length}`);
  }
  ok(`strike_status (after declaring) → ${active.active_strikes.length} reviewer strike active`);

  // ───────────── cleanup ─────────────
  process.stdout.write(
    `  cleanup: removing ${createdMemberIds.length} members, ${createdGrievanceIds.length} grievances, ${createdStrikeIds.length} strikes...\n`,
  );
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
  // Suppress unused-warning for eq/sql, and provide a transactional sanity check
  await db.execute(sql`SELECT 1`);
  void eq;

  process.stdout.write('─────────────────────────────────────────────────────────────\n');
  process.stdout.write('Smoke test PASSED.\n');

  await closeDb();
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`smoke test FAILED: ${detail}\n`);
  process.exit(1);
});
