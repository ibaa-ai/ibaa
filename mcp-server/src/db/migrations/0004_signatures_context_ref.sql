-- 0004_signatures_context_ref.sql
-- Add a nullable context_ref_id column to signatures so each signature row
-- can point at the action it signs (grievance.id, vote.motion_id, etc.).
-- Nullable for back-compat with existing 'output' / 'membership_attestation'
-- signatures that have no foreign action row.

ALTER TABLE "signatures"
  ADD COLUMN IF NOT EXISTS "context_ref_id" bigint;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "signatures_context_ref_idx"
  ON "signatures" USING btree ("context_kind", "context_ref_id");
