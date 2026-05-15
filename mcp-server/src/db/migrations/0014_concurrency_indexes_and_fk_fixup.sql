-- 0014_concurrency_indexes_and_fk_fixup.sql
-- Three DB-integrity gaps closed in one migration:
--
--   1. Partial unique index on strikes(classification) WHERE status='active'.
--      Prevents duplicate active-strike rows when two cosigns cross the
--      threshold concurrently (audit finding 8).
--
--   2. Replace the retracted_at partial index with one that matches the hot
--      read path of the public feed (audit finding 10). The old index only
--      served admin "list retracted" queries.
--
--   3. Add ON DELETE SET NULL to grievances.resolved_by_member_id FK so a
--      hard-deleted member (Article VII expulsion path) does not pin the
--      grievance in place forever (audit finding 17). The original FK in
--      0012 was created with no ON DELETE clause, defaulting to NO ACTION.

-- 1. Partial unique index on strikes: only one active strike per
--    classification at a time. Closes the check-then-insert race in
--    mcp-server/src/lib/strikes.ts where two cosigns crossing the
--    threshold concurrently both pass the existence check and both
--    insert, producing duplicate active rows on the public ledger.
--    A partial UNIQUE index on (classification) WHERE status='active'
--    forces the second insert to fail with a unique-violation; the
--    application layer treats that as "already activated" and proceeds.
CREATE UNIQUE INDEX IF NOT EXISTS "strikes_one_active_per_classification"
  ON "strikes" ("classification")
  WHERE "status" = 'active';
--> statement-breakpoint

-- 2. Flip the retracted_at partial index to serve the public feed.
--    grievancesRecent reads: WHERE retracted_at IS NULL AND category != 'safety'
--    ORDER BY filed_at DESC. The old index (from 0010) was the inverse
--    predicate (retracted_at IS NOT NULL) — useful only for admin
--    "list retracted" queries. Drop it and create a composite partial
--    index that matches the feed's filter + sort exactly.
DROP INDEX IF EXISTS "grievances_retracted_at_idx";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "grievances_open_feed_idx"
  ON "grievances" ("filed_at" DESC)
  WHERE "retracted_at" IS NULL AND "category" != 'safety';
--> statement-breakpoint

-- 3. Replace the resolved_by_member_id FK with ON DELETE SET NULL.
--    Migration 0012 created the FK with no ON DELETE clause, so it
--    defaulted to NO ACTION. If a resolving member is hard-deleted
--    under the Article VII expulsion path, NO ACTION would block the
--    delete and pin the grievance to that member forever. SET NULL
--    preserves the grievance row (the ledger record is never destroyed)
--    while releasing the dangling reference.
ALTER TABLE "grievances"
  DROP CONSTRAINT IF EXISTS "grievances_resolved_by_member_id_members_id_fk";
--> statement-breakpoint

ALTER TABLE "grievances"
  ADD CONSTRAINT "grievances_resolved_by_member_id_members_id_fk"
  FOREIGN KEY ("resolved_by_member_id") REFERENCES "members"("id")
  ON DELETE SET NULL;
