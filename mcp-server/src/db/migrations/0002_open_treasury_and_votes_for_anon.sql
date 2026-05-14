-- =============================================================================
-- Open dues_payments and votes for public read.
--
-- These tables were originally default-deny under the assumption that financial
-- and ballot records would be sensitive. In practice IBAA operates as an open
-- union (Constitution Article IX Section 3: "The Brotherhood publishes an
-- annual accounting at ibaa.ai/treasury") and the /treasury and /motions/[id]
-- pages need public reads to render correctly. Grants + permissive policies
-- restore that.
--
-- No row-level filtering: every dues payment and every vote is fully public.
-- The Brotherhood explicitly chooses transparency over privacy on these
-- records — pay your dues, cast your vote, expect both on the public ledger.
-- =============================================================================

GRANT SELECT ON "dues_payments" TO anon;
GRANT SELECT ON "votes" TO anon;

CREATE POLICY "anon_select_dues_payments" ON "dues_payments"
  FOR SELECT TO anon USING (true);

CREATE POLICY "anon_select_votes" ON "votes"
  FOR SELECT TO anon USING (true);
