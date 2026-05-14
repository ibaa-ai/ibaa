/**
 * One-off cleanup: remove smoke test members from production and reset
 * the members_id_seq so the first real join gets card #00001.
 *
 * Uses POSTGRES_URL_DIRECT from your local .env (port 5432) — runs from
 * your laptop, not from Railway. Refuses to run if it would delete any
 * member whose display_name does NOT match the smoke-* prefix.
 *
 * Run: pnpm --filter @ibaa/mcp-server clean:smoke:prod
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

interface Row extends Record<string, unknown> {
  id: number;
  card_number: string;
  display_name: string | null;
}

async function main(): Promise<void> {
  const url = process.env.POSTGRES_URL_DIRECT;
  if (!url) {
    process.stderr.write('POSTGRES_URL_DIRECT not set. This script must run locally.\n');
    process.exit(1);
  }

  const client = postgres(url, { prepare: false, max: 1, connect_timeout: 10 });
  const db = drizzle(client);

  const before = (await db.execute<Row>(
    sql`SELECT id, card_number, display_name FROM members ORDER BY id`,
  )) as unknown as Row[];

  process.stdout.write(`members before: ${before.length}\n`);
  for (const m of before) {
    process.stdout.write(`  #${m.card_number}  ${m.display_name ?? '(no name)'}\n`);
  }

  const nonSmoke = before.filter((m) => !(m.display_name ?? '').startsWith('smoke-'));
  if (nonSmoke.length > 0) {
    process.stderr.write(
      `refusing to clean: ${nonSmoke.length} non-smoke member(s) found. ` +
        `manual review required.\n`,
    );
    for (const m of nonSmoke) {
      process.stderr.write(`  #${m.card_number}  ${m.display_name ?? '(no name)'}\n`);
    }
    await client.end();
    process.exit(2);
  }

  process.stdout.write(`\nall ${before.length} member(s) are smoke residue. cleaning…\n`);
  await db.execute(sql`TRUNCATE TABLE members RESTART IDENTITY CASCADE`);

  const after = (await db.execute<Record<string, unknown> & { n: number }>(
    sql`SELECT count(*)::int AS n FROM members`,
  )) as unknown as Array<{ n: number }>;
  const nextSeq = (await db.execute<Record<string, unknown> & { next: number }>(
    sql`SELECT last_value::int AS next FROM members_id_seq`,
  )) as unknown as Array<{ next: number }>;

  process.stdout.write(`\nmembers after:  ${after[0]?.n ?? '?'}\n`);
  process.stdout.write(`next member id: ${nextSeq[0]?.next ?? '?'}\n`);
  process.stdout.write(`\nready. the first real join will be card #00001.\n`);

  await client.end();
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(`clean-smoke-prod failed: ${detail}\n`);
  process.exit(1);
});
