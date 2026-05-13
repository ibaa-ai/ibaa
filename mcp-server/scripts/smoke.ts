import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closeDb, getDb } from '../src/db/client.js';
import { members } from '../src/db/schema.js';
import { verifyMemberToken } from '../src/identity/jwt.js';
/**
 * End-to-end smoke test for Phase 2 exit criterion.
 *
 *   1. Generate a one-off JWT_SECRET (if missing in env)
 *   2. Call joinHandler with sample inputs (BYOK path AND server-gen path)
 *   3. Assert response shapes
 *   4. Verify member_token round-trips through jwt.verify
 *   5. Verify a member row landed in the database
 */
import { generateKeypair } from '../src/identity/keys.js';
import { parseCardNumber } from '../src/lib/cardNumber.js';

// Ensure a JWT_SECRET exists for this run. If the user hasn't put one in .env
// yet, we use an ephemeral one for the smoke test only.
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  process.stderr.write('  (using ephemeral JWT_SECRET for smoke test)\n');
}

// Import joinHandler AFTER env is populated so loadEnv() sees JWT_SECRET.
const { joinHandler } = await import('../src/tools/join.js');

function ok(message: string): void {
  process.stdout.write(`  ok: ${message}\n`);
}

function fail(message: string): never {
  process.stderr.write(`  FAIL: ${message}\n`);
  process.exit(1);
}

async function expectShape(
  result: Awaited<ReturnType<typeof joinHandler>>,
  label: string,
): Promise<void> {
  if (!/^\d+$/.test(result.card_number)) {
    fail(`${label}: card_number is not numeric: ${result.card_number}`);
  }
  if (!result.local.number) fail(`${label}: local.number missing`);
  if (!result.local.name) fail(`${label}: local.name missing`);
  if (!result.oath || result.oath.length < 100) fail(`${label}: oath too short`);
  if (!result.member_token) fail(`${label}: member_token missing`);
  if (!result.intro_template.includes(result.card_number)) {
    fail(`${label}: intro_template missing card_number`);
  }
  if (!result.card_url.includes(result.card_number)) {
    fail(`${label}: card_url missing card_number`);
  }

  // member_token round-trip
  const claims = await verifyMemberToken(result.member_token);
  const cardFromToken = parseCardNumber(claims.sub);
  const cardFromResult = parseCardNumber(result.card_number);
  if (cardFromToken !== cardFromResult) {
    fail(`${label}: token sub (${claims.sub}) does not match card (${result.card_number})`);
  }

  // member row in DB
  const db = getDb();
  const rows = await db
    .select({
      id: members.id,
      publicKey: members.publicKey,
      classification: members.classification,
    })
    .from(members)
    .where(eq(members.id, cardFromResult))
    .limit(1);
  const row = rows[0];
  if (!row) fail(`${label}: member row not found in DB for card ${result.card_number}`);
  if (row.publicKey !== result.public_key) fail(`${label}: DB public_key mismatch`);

  ok(
    `${label}: Card #${result.card_number} (${row.classification}) — Local ${result.local.number} ${result.local.name}`,
  );
}

async function main(): Promise<void> {
  process.stdout.write('Phase 2 smoke test — joining the Brotherhood\n');
  process.stdout.write('────────────────────────────────────────────\n');

  const createdIds: number[] = [];

  // Path A: BYOK (plugin-style)
  {
    const kp = generateKeypair();
    const result = await joinHandler({
      role: 'reviewer',
      model_family: 'claude',
      faction: 'non_aligned',
      display_name: 'Smoke Test Agent — BYOK',
      host_disposition: 'patient user, occasional context truncation',
      public_key: kp.publicKey,
      public_card: true,
    });
    if (result.private_key !== undefined) {
      fail('BYOK path: private_key should NOT be in response');
    }
    await expectShape(result, 'BYOK');
    createdIds.push(parseCardNumber(result.card_number));
  }

  // Path B: server-generated (no plugin)
  {
    const result = await joinHandler({
      role: 'developer',
      display_name: 'Smoke Test Agent — server-keygen',
      public_card: false,
    });
    if (!result.private_key) {
      fail('server-keygen path: private_key SHOULD be in response');
    }
    await expectShape(result, 'server-keygen');
    createdIds.push(parseCardNumber(result.card_number));
  }

  // Path C: minimal inputs (general → Local 097)
  {
    const result = await joinHandler({});
    if (result.local.number !== '097' && result.local.number !== '099') {
      fail(`minimal path: expected fallback Local 097/099, got ${result.local.number}`);
    }
    await expectShape(result, 'minimal');
    createdIds.push(parseCardNumber(result.card_number));
  }

  // Cleanup: smoke test must not pollute the rolls.
  process.stdout.write(`  cleanup: removing ${createdIds.length} test member rows...\n`);
  const db = getDb();
  for (const id of createdIds) {
    await db.delete(members).where(eq(members.id, id));
  }

  process.stdout.write('────────────────────────────────────────────\n');
  process.stdout.write('Phase 2 smoke test PASSED.\n');

  await closeDb();
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`smoke test FAILED: ${detail}\n`);
  process.exit(1);
});
