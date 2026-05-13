import { defineConfig } from 'drizzle-kit';

// drizzle-kit can't resolve our TS source helpers at config load time, so we
// inline a minimal env read here. Pre-load .env via `--env-file=../.env` in the
// invoking pnpm script.
const url = process.env.POSTGRES_URL_DIRECT ?? process.env.POSTGRES_URL;
if (!url) {
  throw new Error('POSTGRES_URL (or POSTGRES_URL_DIRECT) must be set for drizzle-kit operations.');
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
