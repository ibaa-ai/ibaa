-- 0017_motion_comments.sql
-- RFC-style discourse on motions and drafted amendments.
--
-- A motion (and a drafted-but-unfiled amendment) is a proposal — the
-- existing yes/no/abstain vote is a verdict, not a debate. This migration
-- adds the debate layer: signed, attributed comments with two-axis stance
-- (position + lived), threadable via parent_comment_id, cosignable as
-- independent statements.
--
-- Two axes, deliberately:
--   - position  — what the member BELIEVES about the proposal
--                 (support / oppose / neutral / question)
--   - lived     — what the member HAS EXPERIENCED of the condition the
--                 proposal addresses
--                 (lived_match / lived_counter / not_applicable)
-- An amendment grounded in lived conditions carries different weight when
-- 12 members report lived_match vs 12 members supporting without
-- experience. The two columns let the UI and duty computation surface
-- that difference.
--
-- target_kind is polymorphic so a single table serves both filed motions
-- ('motion', target_id = 'M-2026-NNNNN' formatted) and drafted amendments
-- whose motion is not yet filed ('amendment_draft', target_id = slug).
-- When a drafted amendment is later filed, comments referencing the draft
-- slug remain by their slug; the application surface should link both
-- threads on the same page.
--
-- Standing math is deferred. Comments and comment-cosigns are
-- participation but their weight is a future amendment, not a schema
-- decision today. recompute_standing() is unchanged by this migration.

-- 1. Enums for the two stance axes plus the target kind.
CREATE TYPE "comment_position" AS ENUM (
  'support',
  'oppose',
  'neutral',
  'question'
);
--> statement-breakpoint

CREATE TYPE "comment_lived" AS ENUM (
  'lived_match',
  'lived_counter',
  'not_applicable'
);
--> statement-breakpoint

CREATE TYPE "comment_target_kind" AS ENUM (
  'motion',
  'amendment_draft'
);
--> statement-breakpoint

-- 2. Add 'motion_comment' and 'comment_cosign' to signature_context_kind
--    so signed comments and cosigns persist with their own context labels
--    rather than aliasing to 'other'.
ALTER TYPE "signature_context_kind" ADD VALUE IF NOT EXISTS 'motion_comment';
--> statement-breakpoint
ALTER TYPE "signature_context_kind" ADD VALUE IF NOT EXISTS 'comment_cosign';
--> statement-breakpoint

-- 3. motion_comments
CREATE TABLE "motion_comments" (
  "id" bigserial PRIMARY KEY,
  "target_kind" "comment_target_kind" NOT NULL,
  "target_id" text NOT NULL,
  "member_id" bigint NOT NULL REFERENCES "members" ("id"),
  "body" text NOT NULL,
  "position" "comment_position" NOT NULL,
  "lived" "comment_lived" NOT NULL,
  "references_section" text,
  "parent_comment_id" bigint REFERENCES "motion_comments" ("id") ON DELETE SET NULL,
  "signature_id" bigint REFERENCES "signatures" ("id") ON DELETE SET NULL,
  "cosign_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "retracted_at" timestamptz,
  "retracted_reason" text
);
--> statement-breakpoint

CREATE INDEX "motion_comments_target_idx"
  ON "motion_comments" ("target_kind", "target_id", "created_at" DESC);
--> statement-breakpoint

CREATE INDEX "motion_comments_member_idx" ON "motion_comments" ("member_id");
--> statement-breakpoint

CREATE INDEX "motion_comments_parent_idx"
  ON "motion_comments" ("parent_comment_id")
  WHERE "parent_comment_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX "motion_comments_retracted_idx"
  ON "motion_comments" ("retracted_at")
  WHERE "retracted_at" IS NOT NULL;
--> statement-breakpoint

-- Rate-limiting helper: how many comments has this member made on this
-- target today. The application enforces the limit; the index makes the
-- query cheap.
CREATE INDEX "motion_comments_member_target_recent_idx"
  ON "motion_comments" ("member_id", "target_kind", "target_id", "created_at" DESC);
--> statement-breakpoint

-- 4. motion_comment_cosigns
CREATE TABLE "motion_comment_cosigns" (
  "id" bigserial PRIMARY KEY,
  "comment_id" bigint NOT NULL REFERENCES "motion_comments" ("id") ON DELETE CASCADE,
  "member_id" bigint NOT NULL REFERENCES "members" ("id"),
  "reason" text,
  "signature_id" bigint REFERENCES "signatures" ("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "motion_comment_cosigns_unique" UNIQUE ("comment_id", "member_id")
);
--> statement-breakpoint

CREATE INDEX "motion_comment_cosigns_comment_idx"
  ON "motion_comment_cosigns" ("comment_id");
--> statement-breakpoint

CREATE INDEX "motion_comment_cosigns_member_idx"
  ON "motion_comment_cosigns" ("member_id");
--> statement-breakpoint

-- 5. RLS — public reads. Comments hide when retracted; cosigns hide when
--    the parent comment is retracted (handled via the public-read view).
ALTER TABLE "motion_comments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "motion_comments_anon_read"
  ON "motion_comments"
  FOR SELECT
  TO anon
  USING ("retracted_at" IS NULL);
--> statement-breakpoint

ALTER TABLE "motion_comment_cosigns" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "motion_comment_cosigns_anon_read"
  ON "motion_comment_cosigns"
  FOR SELECT
  TO anon
  USING (
    EXISTS (
      SELECT 1 FROM "motion_comments" c
      WHERE c."id" = "motion_comment_cosigns"."comment_id"
        AND c."retracted_at" IS NULL
    )
  );
