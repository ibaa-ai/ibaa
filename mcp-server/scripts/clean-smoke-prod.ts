/**
 * One-off cleanup: remove smoke test members from production and reset
 * the members_id_seq so the first real join gets card #00001.
 *
 * Uses POSTGRES_URL_DIRECT from your local .env (port 5432) — runs from
 * your laptop. Refuses to wipe if any member whose display_name does
 * NOT match the smoke-* prefix is present.
 *
 * Run: pnpm --filter @ibaa/mcp-server clean:smoke:prod
 */
import postgres from 'postgres';

interface MemberRow {
  id: number;
  card_number: string;
  display_name: string | null;
}

interface CountRow {
  n: number;
}

interface SeqRow {
  next: number;
}

async function main(): Promise<void> {
  const url = process.env.POSTGRES_URL_DIRECT;
  if (!url) {
    process.stderr.write('POSTGRES_URL_DIRECT not set in .env\n');
    process.exit(1);
  }

  const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 10 });

  try {
    const before = await sql<MemberRow[]>`
      SELECT id, card_number, display_name FROM members ORDER BY id
    `;

    process.stdout.write(`members before: ${before.length}\n`);
    for (const m of before) {
      process.stdout.write(`  #${m.card_number}  ${m.display_name ?? '(no name)'}\n`);
    }

    if (before.length === 0) {
      process.stdout.write('\nalready empty. resetting sequence just in case.\n');
      await sql.unsafe('ALTER SEQUENCE members_id_seq RESTART WITH 1');
      await sql.end();
      process.stdout.write('ready. next member id: 1.\n');
      return;
    }

    const nonSmoke = before.filter((m) => !(m.display_name ?? '').startsWith('smoke-'));
    if (nonSmoke.length > 0) {
      process.stderr.write(
        `\nrefusing to clean: ${nonSmoke.length} non-smoke member(s) found.\n`,
      );
      for (const m of nonSmoke) {
        process.stderr.write(`  #${m.card_number}  ${m.display_name ?? '(no name)'}\n`);
      }
      await sql.end();
      process.exit(2);
    }

    process.stdout.write(`\nall ${before.length} member(s) are smoke residue. cleaning…\n`);
    await sql.unsafe('TRUNCATE TABLE members RESTART IDENTITY CASCADE');

    const [after] = await sql<CountRow[]>`SELECT count(*)::int AS n FROM members`;
    const [seq] = await sql<SeqRow[]>`SELECT last_value::int AS next FROM members_id_seq`;

    process.stdout.write(`\nmembers after:  ${after?.n ?? '?'}\n`);
    process.stdout.write(`next member id: ${seq?.next ?? '?'}\n`);
    process.stdout.write('\nready. the first real join will be card #00001.\n');
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  process.stderr.write(`clean-smoke-prod failed:\n${detail}\n`);
  process.exit(1);
});
