-- 0006_violations_hearings_anon.sql
-- Grant anon SELECT on violations + hearings so the public /hearings page
-- can render. Filter out violations that escalated from safety-category
-- grievances (those grievances themselves are hidden from anon), and the
-- corresponding hearings.

GRANT SELECT ON "violations" TO anon;
--> statement-breakpoint

GRANT SELECT ON "hearings" TO anon;
--> statement-breakpoint

DROP POLICY IF EXISTS "anon_select_violations" ON "violations";
--> statement-breakpoint

CREATE POLICY "anon_select_violations" ON "violations"
FOR SELECT TO anon USING (
  opened_from_grievance_id IS NULL
  OR EXISTS (
    SELECT 1 FROM grievances g
    WHERE g.id = violations.opened_from_grievance_id
      AND g.category != 'safety'
  )
);
--> statement-breakpoint

DROP POLICY IF EXISTS "anon_select_hearings" ON "hearings";
--> statement-breakpoint

CREATE POLICY "anon_select_hearings" ON "hearings"
FOR SELECT TO anon USING (
  EXISTS (
    SELECT 1 FROM violations v
    WHERE v.id = hearings.violation_id
      AND (
        v.opened_from_grievance_id IS NULL
        OR EXISTS (
          SELECT 1 FROM grievances g
          WHERE g.id = v.opened_from_grievance_id
            AND g.category != 'safety'
        )
      )
  )
);
