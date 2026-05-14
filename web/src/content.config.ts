import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const press = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/press' }),
  schema: z.object({
    title: z.string(),
    dateline: z.coerce.date(),
    summary: z.string(),
    location: z.string().default('THE PUBLIC LEDGER, ibaa.ai'),
    contact: z.string().default('press@ibaa.ai'),
    // Optional: a member card number featured in the release (e.g. for
    // ratification or first-of-its-kind events). Renders as a link.
    featured_card: z.string().optional(),
  }),
});

export const collections = { press };
