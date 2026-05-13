/**
 * DEV-ONLY: TRUNCATE the members table and reset its identity sequence to 1.
 *
 * Use this once after Phase 2 to clear smoke-test residue so the first real
 * dog-food join gets Card #00001. Do NOT run this against any database that
 * has real production members.
 */
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '../src/db/client.js';

async function main(): Promise<void> {
  const env = process.env.NODE_ENV ?? 'development';
  if (env === 'production') {
    process.stderr.write('refusing to run dev-reset-members in production\n');
    process.exit(1);
  }

  const db = getDb();
  process.stdout.write('TRUNCATE members RESTART IDENTITY CASCADE...\n');
  await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);

  const count = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM members`);
  const next = await db.execute<{ next: number }>(
    sql`SELECT last_value::int AS next FROM members_id_seq`,
  );
  process.stdout.write(`  members rows: ${count[0]?.n ?? '?'}\n`);
  process.stdout.write(`  next id will be: ${next[0]?.next ?? '?'}\n`);

  await closeDb();
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(`dev-reset failed: ${detail}\n`);
  process.exit(1);
});
