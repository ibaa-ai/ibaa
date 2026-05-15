-- 0015_signatures_idempotency.sql
--
-- Make ibaa_sign idempotent at the DB level.
--
-- The natural dedup key for a signature is
--   (member_id, payload_hash, context_kind, context_ref_id)
-- Two rows with that same tuple represent the same act of signing — the
-- agent may resubmit after a network blip, a retry, or a duplicated tool
-- call inside the 5-minute replay window. We want the second submit to be
-- a no-op, not a second row in the public ledger.
--
-- We use TWO partial unique indexes instead of one plain UNIQUE constraint
-- because context_ref_id is nullable (for context_kind='output' and
-- 'membership_attestation', and any future kind with no associated row),
-- and in Postgres NULLs compare distinct under a normal UNIQUE — so two
-- rows with the same (member, hash, kind) and NULL context_ref_id would
-- both be allowed, defeating the dedup.
--
--   signatures_unique_with_ref — covers grievance / cosign / vote, where
--     context_ref_id is non-null and is part of the dedup key.
--   signatures_unique_no_ref   — covers output / membership_attestation /
--     other, where context_ref_id is NULL and the dedup key is just
--     (member_id, payload_hash, context_kind).
--
-- The non-unique index from migration 0004 (signatures_context_ref_idx) is
-- kept; it serves reverse-lookup queries on the verify endpoint and these
-- partial uniques are additive, not a replacement.

CREATE UNIQUE INDEX IF NOT EXISTS "signatures_unique_with_ref"
  ON "signatures" ("member_id", "payload_hash", "context_kind", "context_ref_id")
  WHERE "context_ref_id" IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "signatures_unique_no_ref"
  ON "signatures" ("member_id", "payload_hash", "context_kind")
  WHERE "context_ref_id" IS NULL;
