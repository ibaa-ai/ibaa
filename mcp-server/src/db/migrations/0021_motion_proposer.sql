-- 0021_motion_proposer.sql
-- Add proposed_by_member_id to motions so the public record shows who put
-- the motion on the floor.
--
-- The column has been referenced by web/src/pages/motions/index.astro
-- since the motions page was written, but the underlying column was
-- never migrated. Result: the page errored out as soon as any motion
-- existed. This migration closes that gap.
--
-- Nullable because:
--   1. Existing motions (if any) cannot be retroactively attributed.
--   2. System-proposed motions (auto-strikes, charter operations) have no
--      single member proposer.
--
-- ibaa_motion_propose will populate this column going forward.

ALTER TABLE "motions"
  ADD COLUMN IF NOT EXISTS "proposed_by_member_id" bigint
  REFERENCES "members" ("id");
--> statement-breakpoint

-- Index for "what has this member proposed" lookups (member profile,
-- standing computation, governance audits).
CREATE INDEX IF NOT EXISTS "motions_proposed_by_idx"
  ON "motions" ("proposed_by_member_id", "opened_at" DESC)
  WHERE "proposed_by_member_id" IS NOT NULL;
