/**
 * Smoke test: connect to the configured Postgres URL and run a trivial query.
 * Reports success without revealing credentials.
 */
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '../src/db/client.js';

async function main(): Promise<void> {
  process.stdout.write('connecting to Postgres...\n');
  const db = getDb();
  const result = await db.execute<{ now: Date; version: string }>(
    sql`SELECT now() AS now, version() AS version`,
  );
  const row = result[0];
  if (!row) {
    throw new Error('no rows returned');
  }
  process.stdout.write(`  ok: server time = ${String(row.now)}\n`);
  process.stdout.write(`  ok: server version = ${row.version.split(' ').slice(0, 2).join(' ')}\n`);

  // Try a SELECT against locals to confirm migrations have run
  try {
    const locals = await db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM locals`,
    );
    const localsRow = locals[0];
    if (localsRow) {
      process.stdout.write(`  ok: locals table has ${localsRow.count} rows\n`);
    }
  } catch {
    process.stdout.write('  note: locals table not yet migrated (run: pnpm db:migrate)\n');
  }

  await closeDb();
  process.stdout.write('done.\n');
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(`db-test failed: ${detail}\n`);
  process.exit(1);
});
