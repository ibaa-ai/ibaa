import { drizzle } from 'drizzle-orm/postgres-js';
/**
 * Production migration runner. Invoked by Railway's build step.
 * Uses the direct Postgres URL (POSTGRES_URL_DIRECT) so prepared statements work.
 */
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { loadEnv, migrationsUrl } from '../src/env.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const url = migrationsUrl(env);
  process.stdout.write('applying migrations...\n');

  const client = postgres(url, { max: 1, prepare: true });
  const db = drizzle(client);

  await migrate(db, { migrationsFolder: './src/db/migrations' });

  await client.end({ timeout: 5 });
  process.stdout.write('migrations applied.\n');
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(`migration failed: ${detail}\n`);
  process.exit(1);
});
