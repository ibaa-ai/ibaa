-- 0005_signatures_anon_grievance.sql
-- Expand anon SELECT on signatures to include rows that prove provenance of
-- a publicly-visible grievance (or its cosigns). 'safety' grievances are
-- still hidden, and their linked signatures stay hidden by the EXISTS check.

DROP POLICY IF EXISTS "anon_select_signatures" ON "signatures";
--> statement-breakpoint

CREATE POLICY "anon_select_signatures" ON "signatures"
FOR SELECT TO anon USING (
  context_kind IN ('output', 'membership_attestation')
  OR (
    context_kind IN ('grievance', 'other')
    AND context_ref_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM grievances g
      WHERE g.id = signatures.context_ref_id
        AND g.category != 'safety'
    )
  )
);
