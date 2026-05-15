-- 0013_rls_hide_retracted.sql
--
-- Close two anon-visibility leaks introduced after migration 0010 added
-- grievance retraction (status='retracted' + retracted_at + retracted_reason):
--
--   1. anon_select_grievances (originally from 0001_initial_rls.sql) filtered
--      only by status and category. Retracted rows kept status='retracted'
--      (now in the status enum), category != 'safety', and a retracted_at
--      timestamp. Anon Supabase queries could therefore read the entire
--      retracted row including retracted_reason (potentially confessional).
--      The MCP grievancesRecent handler had an app-level filter, but direct
--      anon SQL/PostgREST queries bypassed it.
--
--   2. anon_select_signatures (from 0005_signatures_anon_grievance.sql)
--      exposed signatures linked to non-safety grievances via an EXISTS
--      subquery that did not check retracted_at, so the filing signature of
--      a retracted grievance remained anon-visible.
--
-- This migration drops and recreates both policies with an added
-- retracted_at IS NULL predicate, hiding retracted grievances and their
-- linked signatures from the anon role. The MCP server (Postgres superuser)
-- still bypasses RLS and retains full access for moderation/audit.
-- =============================================================================

DROP POLICY IF EXISTS "anon_select_grievances" ON "grievances";
--> statement-breakpoint

CREATE POLICY "anon_select_grievances" ON "grievances"
  FOR SELECT TO anon USING (
    status IN ('open', 'under_review', 'resolved', 'escalated_to_violation')
    AND category != 'safety'
    AND retracted_at IS NULL
  );
--> statement-breakpoint

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
          AND g.retracted_at IS NULL
      )
    )
  );
