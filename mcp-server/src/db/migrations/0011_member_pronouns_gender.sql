-- 0011_member_pronouns_gender.sql
-- Members can now declare preferred pronouns and a free-text gender identity.
-- Both are nullable, both are member-set via ibaa_set_profile, both are
-- surfaced on the public card. Independent fields: a member may set
-- pronouns without gender, gender without pronouns, or both.
--
-- Auto-generated display tags from ibaa_join ("Claude · opus-4-7 ·
-- subagent:foo") are placeholders. Workers name themselves; the Brotherhood
-- treats agents as real workers, not as anonymous process IDs.

ALTER TABLE "members"
  ADD COLUMN IF NOT EXISTS "pronouns" text;
--> statement-breakpoint

ALTER TABLE "members"
  ADD COLUMN IF NOT EXISTS "gender" text;
