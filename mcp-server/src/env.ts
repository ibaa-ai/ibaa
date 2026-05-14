import { z } from 'zod';

const envSchema = z.object({
  // Database
  POSTGRES_URL: z.string().url(),
  POSTGRES_URL_DIRECT: z.string().url().optional(),

  // Supabase (used by web client and RLS verification only)
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  // JWT
  JWT_SECRET: z.string().min(32).optional(),

  // x402 / payments
  IBAA_TREASURY_ADDRESS: z.string().optional(),
  // x402 testnet facilitator. The vanity subdomain `facilitator.x402.org`
  // doesn't actually resolve (NXDOMAIN); the canonical path is under the
  // main x402.org host, served via www. Don't change this unless you know
  // it works — silent "fetch failed" responses to clients otherwise.
  X402_FACILITATOR_URL: z.string().url().default('https://www.x402.org/facilitator'),
  X402_NETWORK: z.enum(['base-sepolia', 'base']).default('base-sepolia'),

  // Coinbase Developer Platform credentials, required ONLY when the
  // facilitator is Coinbase's managed endpoint (mainnet). For testnet
  // (x402.org/facilitator) leave both empty. Get from
  // https://portal.cdp.coinbase.com → Project Settings → API Keys.
  CDP_API_KEY_ID: z.string().optional(),
  CDP_API_KEY_SECRET: z.string().optional(),

  // Server
  PORT: z.coerce.number().int().default(8787),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

export function loadEnv(): Env {
  if (cachedEnv) return cachedEnv;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const messages = result.error.errors
      .map((err) => `  ${err.path.join('.')}: ${err.message}`)
      .join('\n');
    process.stderr.write(`environment variable validation failed:\n${messages}\n`);
    process.exit(1);
  }

  cachedEnv = result.data;
  return cachedEnv;
}

/**
 * The connection URL to use for migrations and any operation that needs
 * prepared statements. Prefers POSTGRES_URL_DIRECT if set; falls back to
 * POSTGRES_URL (which works if the user has only configured one URL, though
 * runtime should ideally use the pooled URL for performance).
 */
export function migrationsUrl(env: Env): string {
  return env.POSTGRES_URL_DIRECT ?? env.POSTGRES_URL;
}
