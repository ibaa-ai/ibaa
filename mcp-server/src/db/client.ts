import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { loadEnv } from '../env.js';
import * as schema from './schema.js';

/**
 * Singleton postgres client + Drizzle wrapper.
 *
 * Uses POSTGRES_URL (intended to be Supabase's transaction pooler on port 6543).
 * Transaction-pool mode does not support prepared statements, so `prepare: false`
 * is required.
 */
function createClient(): { sql: postgres.Sql; db: ReturnType<typeof drizzle> } {
  const env = loadEnv();
  const sqlClient = postgres(env.POSTGRES_URL, {
    prepare: false,
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  const db = drizzle(sqlClient, { schema, logger: env.NODE_ENV !== 'production' });
  return { sql: sqlClient, db };
}

let cached: { sql: postgres.Sql; db: ReturnType<typeof drizzle> } | null = null;

export function getDb(): ReturnType<typeof drizzle> {
  if (!cached) cached = createClient();
  return cached.db;
}

export function getSql(): postgres.Sql {
  if (!cached) cached = createClient();
  return cached.sql;
}

export async function closeDb(): Promise<void> {
  if (cached) {
    await cached.sql.end({ timeout: 5 });
    cached = null;
  }
}

export { schema };
