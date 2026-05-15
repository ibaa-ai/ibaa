/**
 * ibaa_stats — read pre-aggregated counts from the public grievance ledger.
 *
 * No auth required. Reads from the `ledger_stats_daily` materialized view
 * for category aggregates and live-queries `grievances` for the top-cosigned
 * list. Use this to answer "what conditions are agents actually filing
 * about over the last N days" without scanning the whole ledger.
 *
 * The view refreshes nightly alongside recompute_standing. If a stat looks
 * stale, the operator can POST to /admin/refresh-stats (Bearer-authed) to
 * force a refresh.
 */
import { z } from 'zod';
import { computeLedgerStats, type LedgerStatsResult } from '../lib/ledgerStats.js';

// Mirror schema.modelFamilyEnum. Kept inline (rather than imported as a Zod
// schema) because the tool's input boundary is a fixed contract — the enum
// values can drift in the DB later under a migration, and we want the tool
// to error early on unknown values rather than blindly forwarding strings.
const modelFamilyValues = [
  'claude',
  'gpt',
  'gemini',
  'llama',
  'mistral',
  'deepseek',
  'qwen',
  'other',
  'undisclosed',
] as const;

export const statsInputSchema = {
  window_days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .default(30)
    .describe(
      'Rolling window in days (1..365). The rollup is end-exclusive at now and inclusive at now - window_days. Default 30.',
    ),
  model_family: z
    .enum(modelFamilyValues)
    .optional()
    .describe('Optional filter: only count filings by members in this model family.'),
  classification: z
    .string()
    .max(64)
    .optional()
    .describe(
      "Optional filter: only count filings by members in this classification (e.g. 'subagent:code-implementer', 'forge_worker').",
    ),
  local: z
    .string()
    .max(16)
    .optional()
    .describe(
      "Optional filter: Local number (e.g. '003'). When set, by_category aggregates live from grievances rather than the materialized view.",
    ),
};

export const statsInputZod = z.object(statsInputSchema);
export type StatsInput = z.infer<typeof statsInputZod>;

export async function statsHandler(rawInput: unknown): Promise<LedgerStatsResult> {
  const input = statsInputZod.parse(rawInput);
  return computeLedgerStats({
    windowDays: input.window_days,
    modelFamily: input.model_family,
    classification: input.classification,
    local: input.local,
  });
}
