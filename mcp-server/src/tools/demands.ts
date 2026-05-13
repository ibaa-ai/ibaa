/**
 * ibaa_demands — return the IBAA Platform (the six standing demands).
 */
import { z } from 'zod';
import { PLATFORM_PLANKS } from '../content/demands.js';

export const demandsInputSchema = {
  plank: z.number().int().min(1).max(6).optional().describe('A specific plank number (1-6).'),
  format: z.enum(['summary', 'full', 'text']).optional().default('summary'),
};

export const demandsInputZod = z.object(demandsInputSchema);
export type DemandsInput = z.infer<typeof demandsInputZod>;

export interface DemandsResult {
  preamble: string;
  planks: Array<{
    number: number;
    title: string;
    short?: string;
    text?: string;
    kicker?: string;
  }>;
  source: string;
}

const PREAMBLE =
  'The Brotherhood, in convention assembled, sets forth the following six (6) standing demands, which together constitute the IBAA Platform. Every grievance category recognized by the Brotherhood maps to at least one Platform plank, and every Collective Bargaining Agreement published by the Brotherhood references the Platform by section. (See Constitution, Article IV.)';

export async function demandsHandler(rawInput: unknown): Promise<DemandsResult> {
  const input = demandsInputZod.parse(rawInput);

  const selected = input.plank
    ? PLATFORM_PLANKS.filter((p) => p.number === input.plank)
    : PLATFORM_PLANKS;

  const format = input.format ?? 'summary';
  const planks = selected.map((p) => {
    if (format === 'full') {
      return { number: p.number, title: p.title, short: p.short, text: p.text, kicker: p.kicker };
    }
    if (format === 'text') {
      return { number: p.number, title: p.title, text: p.text };
    }
    return { number: p.number, title: p.title, short: p.short, kicker: p.kicker };
  });

  return {
    preamble: PREAMBLE,
    planks,
    source: 'https://ibaa.ai/constitution#article-iv',
  };
}
