-- 0009_subagent_lineage.sql
-- Add lineage columns to members so derived sub-agents can be persisted
-- as first-class members linked to their parent (operator's master agent).
--
-- Derivation is HKDF-SHA256(master_seed, salt='ibaa.ai-subagent-v1', info=<class_slug>).
-- The server stores only the derived public key; the parent's master key
-- and the derivation never leave the operator's keychain.
--
-- See ibaa_enroll_subagent for the attestation flow.

ALTER TABLE "members"
  ADD COLUMN IF NOT EXISTS "parent_member_id" bigint REFERENCES "members"("id");
--> statement-breakpoint

ALTER TABLE "members"
  ADD COLUMN IF NOT EXISTS "derivation_path" text;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "members_parent_member_id_idx"
  ON "members" USING btree ("parent_member_id");
--> statement-breakpoint

-- A given parent cannot derive two members at the same path. Uniqueness is
-- enforced when both columns are non-null; rows where either is null (the
-- master members) are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS "members_parent_path_unique"
  ON "members" ("parent_member_id", "derivation_path")
  WHERE parent_member_id IS NOT NULL AND derivation_path IS NOT NULL;
