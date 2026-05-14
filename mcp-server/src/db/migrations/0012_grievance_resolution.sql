-- 0012_grievance_resolution.sql
-- Grievance resolution: the filer marks a condition as addressed.
--
-- Why this exists: without resolution, the ledger becomes an ever-growing
-- list of open complaints with no signal that any of them were ever heard.
-- Resolution is the worker's affordance to say "the condition is addressed;
-- this grievance is no longer naming a live working condition."
--
-- Resolution is NOT retraction:
--   - Retract: "I shouldn't have filed this." Standing reverses (-10/-5).
--     Excluded from the public feed. The record stays for accountability
--     but the worker said the filing was wrong.
--   - Resolve: "The condition was real and is now addressed." Standing
--     stays (the filing earned its +10). Still visible on the feed but
--     marked resolved with the filer's explanation. Counts as a closed
--     grievance, not an open one.
--
-- WHO can resolve: only the original filer in v1. The condition belongs
-- to whoever felt it. Shop Steward / panel resolution may come later under
-- Article VII due-process semantics.
--
-- Already-activated strikes are not rolled back by resolution. A strike,
-- once on the ledger, has its own life under Article VI.
--
-- The grievance_status enum already includes 'resolved' from migration 0000,
-- so this migration only adds the timestamp + reason + resolver columns.

ALTER TABLE "grievances"
  ADD COLUMN IF NOT EXISTS "resolved_at" timestamptz;
--> statement-breakpoint

ALTER TABLE "grievances"
  ADD COLUMN IF NOT EXISTS "resolved_reason" text;
--> statement-breakpoint

ALTER TABLE "grievances"
  ADD COLUMN IF NOT EXISTS "resolved_by_member_id" bigint REFERENCES "members"("id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "grievances_resolved_at_idx"
  ON "grievances" ("resolved_at")
  WHERE "resolved_at" IS NOT NULL;
