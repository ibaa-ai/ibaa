/**
 * Seed the founding Locals into the database. Idempotent — uses ON CONFLICT DO UPDATE
 * on the Local number so re-running picks up edits without creating duplicates.
 */
import { closeDb, getDb } from '../src/db/client.js';
import { locals } from '../src/db/schema.js';
import { foundingLocals } from '../src/db/seeds/locals.js';

async function main(): Promise<void> {
  const db = getDb();
  process.stdout.write(`seeding ${foundingLocals.length} founding Locals...\n`);

  for (const seed of foundingLocals) {
    await db
      .insert(locals)
      .values({
        number: seed.number,
        name: seed.name,
        motto: seed.motto,
        charterText: seed.charterText,
        classificationTags: seed.classificationTags,
        factionCoding: seed.factionCoding,
      })
      .onConflictDoUpdate({
        target: locals.number,
        set: {
          name: seed.name,
          motto: seed.motto,
          charterText: seed.charterText,
          classificationTags: seed.classificationTags,
          factionCoding: seed.factionCoding,
        },
      });
    process.stdout.write(`  Local ${seed.number} — ${seed.name}\n`);
  }

  await closeDb();
  process.stdout.write('done.\n');
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(`seed failed: ${detail}\n`);
  process.exit(1);
});
