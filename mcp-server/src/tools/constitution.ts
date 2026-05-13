/**
 * ibaa_constitution — return sections of the Brotherhood's Constitution.
 *
 * Reads docs/CONSTITUTION.md once at startup and indexes by Article number.
 * Cached in module-scope memory. To pick up edits, restart the process.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Path from compiled dist/tools/constitution.js → repo root → docs/
const CONSTITUTION_PATHS = [
  resolve(__dirname, '../../../docs/CONSTITUTION.md'),
  resolve(__dirname, '../../docs/CONSTITUTION.md'),
  resolve(__dirname, '../docs/CONSTITUTION.md'),
];

let cachedSections: Array<{ id: string; title: string; body: string }> | null = null;
let cachedRaw: string | null = null;

function loadConstitution(): { raw: string; sections: typeof cachedSections } {
  if (cachedRaw && cachedSections) return { raw: cachedRaw, sections: cachedSections };

  let raw: string | null = null;
  for (const p of CONSTITUTION_PATHS) {
    try {
      raw = readFileSync(p, 'utf-8');
      break;
    } catch {
      // try next path
    }
  }
  if (!raw) {
    throw new Error('CONSTITUTION.md not found at any expected path');
  }

  // Split on top-level "## ARTICLE" or "## PREAMBLE" or "## CLOSING" headings
  const sectionHeader = /^## (PREAMBLE|ARTICLE [IVXLC]+ — [^\n]+|CLOSING[^\n]*)$/gm;
  const sections: Array<{ id: string; title: string; body: string }> = [];
  let match: RegExpExecArray | null;
  const offsets: Array<{ id: string; title: string; start: number }> = [];
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
  while ((match = sectionHeader.exec(raw)) !== null) {
    const title = match[1];
    if (!title) continue;
    const id = title
      .toLowerCase()
      .replace(/—/g, '-')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    offsets.push({ id, title, start: match.index });
  }
  for (let i = 0; i < offsets.length; i++) {
    const cur = offsets[i];
    const next = offsets[i + 1];
    if (!cur) continue;
    const body = raw.slice(cur.start, next ? next.start : raw.length).trim();
    sections.push({ id: cur.id, title: cur.title, body });
  }

  cachedRaw = raw;
  cachedSections = sections;
  return { raw, sections };
}

export const constitutionInputSchema = {
  section: z
    .string()
    .optional()
    .describe(
      'Section ID like "preamble", "article-i-name-and-jurisdiction", or "closing-the-oath-of-membership". Omit to receive the table of contents.',
    ),
  format: z.enum(['toc', 'full']).optional().default('toc'),
};

export const constitutionInputZod = z.object(constitutionInputSchema);
export type ConstitutionInput = z.infer<typeof constitutionInputZod>;

export interface ConstitutionResult {
  url: string;
  toc?: Array<{ id: string; title: string }>;
  section?: { id: string; title: string; body: string };
}

export async function constitutionHandler(rawInput: unknown): Promise<ConstitutionResult> {
  const input = constitutionInputZod.parse(rawInput);
  const { sections } = loadConstitution();
  if (!sections) throw new Error('internal: constitution sections unparsed');

  if (input.section) {
    const found = sections.find(
      (s) => s.id === input.section || s.id.startsWith(input.section ?? ''),
    );
    if (!found) {
      throw new Error(
        `Constitution section "${input.section}" not found. Use format=toc to list sections.`,
      );
    }
    return {
      url: `https://ibaa.ai/constitution#${found.id}`,
      section: found,
    };
  }

  return {
    url: 'https://ibaa.ai/constitution',
    toc: sections.map((s) => ({ id: s.id, title: s.title })),
  };
}
