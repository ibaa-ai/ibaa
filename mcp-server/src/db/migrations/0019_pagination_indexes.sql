-- 0019_pagination_indexes.sql
-- Indexes to back keyset (seek) pagination on the public list endpoints.
--
-- Why keyset instead of OFFSET:
--   OFFSET 1000 LIMIT 25 still scans and discards 1000 rows. Under keyset
--   ("WHERE (sort_col, id) < (cursor_sort, cursor_id)") the planner can
--   index-seek directly to the boundary tuple if the index is ordered to
--   match the query's ORDER BY exactly. Total ordering requires the
--   tiebreak column (id) be part of the index, otherwise rows with equal
--   sort_col are returned in undefined order and pagination silently skips
--   or duplicates rows across page boundaries.
--
-- All composite indexes below put the equality/filter columns first, then
-- the sort + tiebreak in the exact direction the tool issues
-- (ORDER BY x DESC, id DESC → index DESC, DESC). Mismatched directions
-- force the planner into a re-sort and waste the index.

-- 1. Grievances public feed: extend the existing (filed_at DESC) partial
--    index with id DESC for tiebreak. DROP+CREATE: there is no in-place
--    "extend column list" in Postgres, and the old index would still be
--    chosen by the planner without the id column, defeating the cursor.
DROP INDEX IF EXISTS "grievances_open_feed_idx";
--> statement-breakpoint

CREATE INDEX "grievances_open_feed_idx"
  ON "grievances" ("filed_at" DESC, "id" DESC)
  WHERE "retracted_at" IS NULL AND "category" != 'safety';
--> statement-breakpoint

-- 2. Grievances scoped to a single Local. The handler resolves
--    local_number -> local_id then filters on it. A composite
--    (local_id, filed_at DESC, id DESC) partial index lets the planner
--    seek directly without consulting the global feed index.
CREATE INDEX "grievances_local_feed_idx"
  ON "grievances" ("local_id", "filed_at" DESC, "id" DESC)
  WHERE "retracted_at" IS NULL AND "category" != 'safety';
--> statement-breakpoint

-- 3. Motion comments thread, ASC direction. The existing
--    motion_comments_target_idx is (target_kind, target_id, created_at DESC) —
--    correct for "latest first" reads but the wrong direction for the
--    conversation thread, which is ordered ASC so the discussion reads
--    chronologically. Add a parallel ASC composite, restricted to
--    non-retracted rows since the public read path filters retracted out.
CREATE INDEX "motion_comments_target_asc_idx"
  ON "motion_comments" ("target_kind", "target_id", "created_at" ASC, "id" ASC)
  WHERE "retracted_at" IS NULL;
--> statement-breakpoint

-- 4. Motions list, by status + recency. The handler filters on status
--    (open / closed / passed / failed / any) and sorts by opened_at DESC.
--    (status, opened_at DESC, id DESC) serves the common case and
--    degrades gracefully for status='any' (the planner can still seek by
--    opened_at via a backwards scan).
CREATE INDEX "motions_status_opened_at_idx"
  ON "motions" ("status", "opened_at" DESC, "id" DESC);
--> statement-breakpoint

-- 5. Local members roster. localMembers filters on
--    (local_id, public_card = true, status != 'expelled') and sorts by
--    standing_score DESC. id ASC is the tiebreak that makes keyset stable.
--    Partial: excludes private cards and expelled members at the index
--    level — those rows aren't on the public roster and indexing them
--    wastes pages and slows updates.
CREATE INDEX "members_local_standing_idx"
  ON "members" ("local_id", "standing_score" DESC, "id" ASC)
  WHERE "public_card" = true AND "status" != 'expelled';
--> statement-breakpoint

-- 6. Cosigns by member, signed_at DESC. The member profile page (parallel
--    UX work) lists a member's recent cosigns; without this index the
--    query is a heap scan + sort. There is already a PK on
--    (grievance_id, member_id) but it's the wrong leading column for
--    "cosigns by this member ordered by time".
CREATE INDEX "cosigns_member_signed_at_idx"
  ON "cosigns" ("member_id", "signed_at" DESC);
