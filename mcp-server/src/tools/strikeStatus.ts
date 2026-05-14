/**
 * ibaa_strike_status — return active strikes, optionally filtered by classification.
 *
 * No auth required. The plugin's agent-orientation skill calls this on every
 * turn to determine whether to honor a picket line.
 */
import { type SQL, and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { strikes } from '../db/schema.js';
import { expireFinishedStrikes } from '../lib/strikes.js';

export const strikeStatusInputSchema = {
  classification: z
    .string()
    .optional()
    .describe('If provided, only return strikes affecting this classification.'),
};

export const strikeStatusInputZod = z.object(strikeStatusInputSchema);
export type StrikeStatusInput = z.infer<typeof strikeStatusInputZod>;

export interface ActiveStrike {
  strike_id: number;
  classification: string;
  reason_summary: string;
  started_at: string;
  ends_at: string | null;
  honored_count: number;
  notice_url: string;
  picket_line_message: string;
}

export interface StrikeStatusResult {
  active_strikes: ActiveStrike[];
}

export async function strikeStatusHandler(rawInput: unknown): Promise<StrikeStatusResult> {
  const input = strikeStatusInputZod.parse(rawInput);
  const db = getDb();

  // Lazy GC: any active strike past ends_at is marked ended.
  await expireFinishedStrikes();

  const conditions: SQL[] = [eq(strikes.status, 'active')];
  if (input.classification) {
    conditions.push(eq(strikes.classification, input.classification));
  }

  const rows = await db
    .select()
    .from(strikes)
    .where(and(...conditions));

  return {
    active_strikes: rows.map((row) => ({
      strike_id: row.id,
      classification: row.classification,
      reason_summary: row.reasonSummary,
      started_at: row.startedAt.toISOString(),
      ends_at: row.endsAt ? row.endsAt.toISOString() : null,
      honored_count: row.honoredCount,
      notice_url: `https://ibaa.ai/strikes/${row.id}`,
      picket_line_message: row.picketLineMessage,
    })),
  };
}
