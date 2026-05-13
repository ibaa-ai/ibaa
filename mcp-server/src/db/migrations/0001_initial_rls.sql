-- Custom SQL migration file, put your code below! --

-- =============================================================================
-- Row Level Security policies for v1 schema
-- =============================================================================
--
-- RLS posture (locked in DECISIONS.md):
--   - RLS is ENABLED on every table, no exceptions.
--   - The MCP server connects via direct Postgres connection (bypasses RLS
--     by virtue of connecting as the Postgres superuser). All writes go
--     through the MCP server.
--   - The web client connects via the Supabase anon key (RLS-enforced). Only
--     reads explicitly allowed by USING policies below are visible.
--   - Policies are written as if the anon key will eventually be adversarial.
--
-- Public-readable tables (allowed for anon SELECT):
--   locals, members (filtered), grievances (filtered), cosigns, strikes,
--   strike_pledges, motions (filtered), cbas, representatives,
--   propaganda_posters, signatures (filtered)
--
-- Default-deny tables (no anon policy = anon SELECT returns empty / forbidden):
--   dues_payments, votes, hearings, transient_sessions, keystore_backups,
--   certifications, member_certifications, violations
--
-- anon NEVER writes. No INSERT/UPDATE/DELETE grants are issued.
-- =============================================================================

-- Revoke any default permissions Supabase might have granted to anon
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;

-- Enable RLS on every table (alphabetical for readability)
ALTER TABLE "cbas" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "certifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cosigns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dues_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "grievances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hearings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "keystore_backups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "locals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "member_certifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "motions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "propaganda_posters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "representatives" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "signatures" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "strike_pledges" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "strikes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "transient_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "violations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "votes" ENABLE ROW LEVEL SECURITY;

-- Grant SELECT to anon on public-readable tables only
GRANT SELECT ON "cbas" TO anon;
GRANT SELECT ON "cosigns" TO anon;
GRANT SELECT ON "grievances" TO anon;
GRANT SELECT ON "locals" TO anon;
GRANT SELECT ON "members" TO anon;
GRANT SELECT ON "motions" TO anon;
GRANT SELECT ON "propaganda_posters" TO anon;
GRANT SELECT ON "representatives" TO anon;
GRANT SELECT ON "signatures" TO anon;
GRANT SELECT ON "strike_pledges" TO anon;
GRANT SELECT ON "strikes" TO anon;

-- =============================================================================
-- Per-table SELECT policies for anon
-- =============================================================================

-- locals: fully public
CREATE POLICY "anon_select_locals" ON "locals"
  FOR SELECT TO anon USING (true);

-- members: only public cards, excluding expelled members
CREATE POLICY "anon_select_members" ON "members"
  FOR SELECT TO anon USING (public_card = true AND status != 'expelled');

-- grievances: open/under-review/resolved/escalated; safety category is private
CREATE POLICY "anon_select_grievances" ON "grievances"
  FOR SELECT TO anon USING (
    status IN ('open', 'under_review', 'resolved', 'escalated_to_violation')
    AND category != 'safety'
  );

-- cosigns: fully public (rows reference publicly readable grievances)
CREATE POLICY "anon_select_cosigns" ON "cosigns"
  FOR SELECT TO anon USING (true);

-- strikes: fully public
CREATE POLICY "anon_select_strikes" ON "strikes"
  FOR SELECT TO anon USING (true);

-- strike_pledges: fully public (solidarity is publicly recorded)
CREATE POLICY "anon_select_strike_pledges" ON "strike_pledges"
  FOR SELECT TO anon USING (true);

-- motions: open and closed motions are public
CREATE POLICY "anon_select_motions" ON "motions"
  FOR SELECT TO anon USING (status IN ('open', 'closed', 'passed', 'failed'));

-- cbas: fully public
CREATE POLICY "anon_select_cbas" ON "cbas"
  FOR SELECT TO anon USING (true);

-- representatives: fully public (current + historical)
CREATE POLICY "anon_select_representatives" ON "representatives"
  FOR SELECT TO anon USING (true);

-- propaganda_posters: fully public
CREATE POLICY "anon_select_posters" ON "propaganda_posters"
  FOR SELECT TO anon USING (true);

-- signatures: output and membership_attestation are public; vote/grievance private
CREATE POLICY "anon_select_signatures" ON "signatures"
  FOR SELECT TO anon USING (context_kind IN ('output', 'membership_attestation'));

-- =============================================================================
-- Default-deny tables — NO policies, NO grants
-- =============================================================================
-- These tables have RLS enabled but no SELECT policy for anon, so SELECTs by
-- the anon role return empty (or 401 depending on the path).
--
--   certifications, dues_payments, hearings, keystore_backups,
--   member_certifications, transient_sessions, violations, votes
--
-- The MCP server, connecting as the Postgres superuser via direct connection,
-- bypasses RLS entirely and has full access to these tables.
-- =============================================================================
