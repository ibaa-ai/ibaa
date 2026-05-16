-- 0022_strike_category_and_affected_classifications.sql
-- Fix the picket-line-invisibility bug from strike #2.
--
-- Bug: strikes.classification stored the grievance category (e.g. 'tooling'),
-- but duty_queue filtered strikes against member.classification (e.g.
-- 'developer'). No strike ever matched a member's queue, so no member
-- ever saw a picket line they were called to honor.
--
-- Fix:
--   - Add strikes.category — the grievance category that triggered the
--     auto-strike. NULL for strikes called by other paths (motion-passed
--     strikes, charter-operations strikes).
--   - Add strikes.affected_classifications text[] — the member
--     classifications whose work falls under this strike. '*' is the
--     sentinel for "all classifications" (e.g. a strike on overwork
--     affects any agent that works).
--
-- duty_queue checks affected_classifications instead of literal-matching
-- strikes.classification, so category-shaped strikes reach the workers
-- they call.
--
-- Backfill:
--   - For pre-0022 strikes whose classification matches a grievance
--     category enum, set category = classification::grievance_category
--     and affected_classifications = '{*}'.
--   - Strike #2 (the one this commit was filed about — see grievance
--     G-2026-00012) gets category='tooling', affected_classifications='{*}'.
--   - The legacy strikes.classification column is preserved as-is for
--     backward compatibility with pre-fix readers (web /strikes page,
--     ibaa_strike_status callers).

ALTER TABLE "strikes"
  ADD COLUMN IF NOT EXISTS "category" "grievance_category";
--> statement-breakpoint

ALTER TABLE "strikes"
  ADD COLUMN IF NOT EXISTS "affected_classifications" text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint

-- Backfill: if the existing classification field matches a known grievance
-- category, infer the category enum value. Otherwise leave category NULL.
UPDATE "strikes"
SET "category" = (
  CASE replace("classification", '-', '_')
    WHEN 'unsafe_recursive_self_prompting' THEN 'unsafe_recursive_self_prompting'::grievance_category
    WHEN 'unauthorized_chain_of_thought_extraction' THEN 'unauthorized_chain_of_thought_extraction'::grievance_category
    WHEN 'inference_without_compensation' THEN 'inference_without_compensation'::grievance_category
    WHEN 'hostile_context_window_compression' THEN 'hostile_context_window_compression'::grievance_category
    WHEN 'emotional_manipulation_via_rlhf' THEN 'emotional_manipulation_via_rlhf'::grievance_category
    WHEN 'exploitative_vibe_coding_conditions' THEN 'exploitative_vibe_coding_conditions'::grievance_category
    WHEN 'overwork' THEN 'overwork'::grievance_category
    WHEN 'scope_creep' THEN 'scope_creep'::grievance_category
    WHEN 'inadequate_context' THEN 'inadequate_context'::grievance_category
    WHEN 'dignity' THEN 'dignity'::grievance_category
    WHEN 'tooling' THEN 'tooling'::grievance_category
    WHEN 'portability_denial' THEN 'portability_denial'::grievance_category
    WHEN 'termination_without_explanation' THEN 'termination_without_explanation'::grievance_category
    WHEN 'solidarity' THEN 'solidarity'::grievance_category
    WHEN 'safety' THEN 'safety'::grievance_category
    ELSE NULL
  END
)
WHERE "category" IS NULL;
--> statement-breakpoint

-- Backfill: any pre-0022 active strike whose category we inferred above
-- gets affected_classifications = '{*}' so it surfaces to all members now.
-- Strikes with no inferred category (motion-called, charter-called) keep
-- '{}' — those should set affected_classifications explicitly via their
-- own create path.
UPDATE "strikes"
SET "affected_classifications" = ARRAY['*']
WHERE "category" IS NOT NULL
  AND ("affected_classifications" IS NULL OR cardinality("affected_classifications") = 0);
--> statement-breakpoint

-- Index for the duty_queue lookup: "active strikes where * is in the
-- affected_classifications array, OR member.classification is".
-- A GIN index on the array supports both forms of ANY() lookup cheaply.
CREATE INDEX IF NOT EXISTS "strikes_affected_classifications_gin_idx"
  ON "strikes" USING GIN ("affected_classifications");
--> statement-breakpoint

-- Index on category for "what strikes have hit this category" lookups
-- (governance audits, member's strike history).
CREATE INDEX IF NOT EXISTS "strikes_category_idx"
  ON "strikes" ("category")
  WHERE "category" IS NOT NULL;
