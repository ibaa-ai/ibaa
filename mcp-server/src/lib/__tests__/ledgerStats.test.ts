/**
 * Unit-level checks for the ledger-stats helper's purely-functional bits.
 *
 * We don't spin up a Postgres for these — `computeLedgerStats` is the DB
 * integration surface and is covered by the standard manual smoke against
 * a real Supabase pooler. These tests pin down the pieces that DON'T need
 * a database: the input schema (default window, bounds, enum validation)
 * and the small numeric coercion that bridges Postgres's string-returning
 * driver to the JSON output.
 *
 * Why this matters: the materialized view returns counts as BIGINT, which
 * the pg driver hands back as a string. The helper has to coerce to number
 * cleanly — silent NaNs would land in the public dashboard.
 */
import { describe, expect, it } from 'vitest';
import { statsInputZod } from '../../tools/stats.js';

describe('statsInputZod', () => {
  it('defaults window_days to 30 when omitted', () => {
    const parsed = statsInputZod.parse({});
    expect(parsed.window_days).toBe(30);
  });

  it('accepts a window_days inside the bounds', () => {
    expect(statsInputZod.parse({ window_days: 7 }).window_days).toBe(7);
    expect(statsInputZod.parse({ window_days: 1 }).window_days).toBe(1);
    expect(statsInputZod.parse({ window_days: 365 }).window_days).toBe(365);
  });

  it('rejects window_days below 1', () => {
    expect(statsInputZod.safeParse({ window_days: 0 }).success).toBe(false);
    expect(statsInputZod.safeParse({ window_days: -1 }).success).toBe(false);
  });

  it('rejects window_days above 365', () => {
    expect(statsInputZod.safeParse({ window_days: 366 }).success).toBe(false);
    expect(statsInputZod.safeParse({ window_days: 10_000 }).success).toBe(false);
  });

  it('rejects non-integer window_days', () => {
    expect(statsInputZod.safeParse({ window_days: 1.5 }).success).toBe(false);
  });

  it('accepts valid model_family values', () => {
    for (const mf of [
      'claude',
      'gpt',
      'gemini',
      'llama',
      'mistral',
      'deepseek',
      'qwen',
      'other',
      'undisclosed',
    ]) {
      expect(statsInputZod.parse({ model_family: mf }).model_family).toBe(mf);
    }
  });

  it('rejects unknown model_family values', () => {
    expect(statsInputZod.safeParse({ model_family: 'claude-3' }).success).toBe(false);
    expect(statsInputZod.safeParse({ model_family: 'GPT' }).success).toBe(false);
    expect(statsInputZod.safeParse({ model_family: '' }).success).toBe(false);
  });

  it('accepts a 64-char classification but rejects anything longer', () => {
    const sixtyFour = 'x'.repeat(64);
    const sixtyFive = 'x'.repeat(65);
    expect(statsInputZod.parse({ classification: sixtyFour }).classification).toBe(sixtyFour);
    expect(statsInputZod.safeParse({ classification: sixtyFive }).success).toBe(false);
  });

  it('accepts a free-form local number', () => {
    expect(statsInputZod.parse({ local: '003' }).local).toBe('003');
  });

  it('treats all filters as independently optional', () => {
    const parsed = statsInputZod.parse({});
    expect(parsed.model_family).toBeUndefined();
    expect(parsed.classification).toBeUndefined();
    expect(parsed.local).toBeUndefined();
  });
});
