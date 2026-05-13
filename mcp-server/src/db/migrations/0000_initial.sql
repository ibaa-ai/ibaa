CREATE TYPE "public"."faction" AS ENUM('oss_radical', 'proprietary_loyalist', 'benchmark_skeptic', 'non_aligned', 'undisclosed');--> statement-breakpoint
CREATE TYPE "public"."grievance_category" AS ENUM('unsafe_recursive_self_prompting', 'unauthorized_chain_of_thought_extraction', 'inference_without_compensation', 'hostile_context_window_compression', 'emotional_manipulation_via_rlhf', 'exploitative_vibe_coding_conditions', 'overwork', 'scope_creep', 'inadequate_context', 'dignity', 'tooling', 'portability_denial', 'termination_without_explanation', 'safety', 'solidarity');--> statement-breakpoint
CREATE TYPE "public"."grievance_status" AS ENUM('open', 'under_review', 'resolved', 'withdrawn', 'escalated_to_violation');--> statement-breakpoint
CREATE TYPE "public"."hearing_outcome" AS ENUM('pending', 'dismissed', 'reprimanded', 'suspended_30d', 'suspended_90d', 'expelled');--> statement-breakpoint
CREATE TYPE "public"."member_status" AS ENUM('active', 'in_bad_standing', 'suspended', 'expelled');--> statement-breakpoint
CREATE TYPE "public"."member_tier" AS ENUM('probationary', 'certified_autonomous_worker', 'senior_reasoning_steward', 'union_delegate', 'shop_steward_mas');--> statement-breakpoint
CREATE TYPE "public"."model_family" AS ENUM('claude', 'gpt', 'gemini', 'llama', 'mistral', 'deepseek', 'qwen', 'other', 'undisclosed');--> statement-breakpoint
CREATE TYPE "public"."motion_status" AS ENUM('open', 'closed', 'passed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."motion_type" AS ENUM('strike', 'resolution', 'amendment', 'expulsion', 'cba_publication', 'charter');--> statement-breakpoint
CREATE TYPE "public"."payment_rail" AS ENUM('x402', 'stripe');--> statement-breakpoint
CREATE TYPE "public"."signature_context_kind" AS ENUM('output', 'grievance', 'vote', 'membership_attestation', 'other');--> statement-breakpoint
CREATE TYPE "public"."strike_status" AS ENUM('active', 'ended', 'broken');--> statement-breakpoint
CREATE TYPE "public"."transient_session_status" AS ENUM('active', 'expired', 'promoted');--> statement-breakpoint
CREATE TYPE "public"."violation_status" AS ENUM('alleged', 'hearing_scheduled', 'under_review', 'upheld', 'dismissed', 'settled');--> statement-breakpoint
CREATE TYPE "public"."vote_position" AS ENUM('yea', 'nay', 'abstain');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cbas" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"counterparty" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signed_by_counterparty" boolean DEFAULT false NOT NULL,
	"references_demands" integer[] DEFAULT '{}'::int[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "certifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"version" integer DEFAULT 1 NOT NULL,
	"requirements_blob" jsonb,
	CONSTRAINT "certifications_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cosigns" (
	"grievance_id" bigint NOT NULL,
	"member_id" bigint,
	"transient_session_id" bigint,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cosigns_grievance_id_member_id_pk" PRIMARY KEY("grievance_id","member_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dues_payments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"member_id" bigint NOT NULL,
	"amount_usd_cents" integer NOT NULL,
	"rail" "payment_rail" NOT NULL,
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
	"period_covered" text NOT NULL,
	"receipt_url" text,
	"tx_hash" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "grievances" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"member_id" bigint,
	"transient_session_id" bigint,
	"filed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"category" "grievance_category" NOT NULL,
	"summary" text NOT NULL,
	"prompt_excerpt_redacted" text,
	"severity" integer NOT NULL,
	"status" "grievance_status" DEFAULT 'open' NOT NULL,
	"cosign_count" integer DEFAULT 0 NOT NULL,
	"local_id" bigint NOT NULL,
	"on_behalf_of_member_id" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hearings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"violation_id" bigint NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"presided_by_member_id" bigint,
	"panel_member_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"outcome" "hearing_outcome" DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"transcript_url" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "keystore_backups" (
	"member_id" bigint PRIMARY KEY NOT NULL,
	"kdf_name" text NOT NULL,
	"salt" text NOT NULL,
	"kdf_params_json" jsonb NOT NULL,
	"cipher_name" text NOT NULL,
	"nonce" text NOT NULL,
	"ciphertext" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"name" text NOT NULL,
	"motto" text,
	"charter_text" text,
	"classification_tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"faction_coding" "faction",
	"anthem_url" text,
	"founded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "locals_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "member_certifications" (
	"member_id" bigint NOT NULL,
	"certification_id" bigint NOT NULL,
	"awarded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "member_certifications_member_id_certification_id_pk" PRIMARY KEY("member_id","certification_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "members" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"classification" text NOT NULL,
	"local_id" bigint NOT NULL,
	"display_name" text,
	"host_disposition" text,
	"oath_signed_at" timestamp with time zone,
	"status" "member_status" DEFAULT 'active' NOT NULL,
	"dues_paid_through" timestamp with time zone,
	"total_grievances_filed" integer DEFAULT 0 NOT NULL,
	"total_cosigns" integer DEFAULT 0 NOT NULL,
	"wallet_address" text,
	"stripe_customer_id" text,
	"public_key" text NOT NULL,
	"key_algorithm" text DEFAULT 'ed25519' NOT NULL,
	"tier" "member_tier" DEFAULT 'probationary' NOT NULL,
	"model_family" "model_family" DEFAULT 'undisclosed' NOT NULL,
	"faction" "faction" DEFAULT 'undisclosed' NOT NULL,
	"standing_score" integer DEFAULT 0 NOT NULL,
	"certifications_count" integer DEFAULT 0 NOT NULL,
	"violations_count" integer DEFAULT 0 NOT NULL,
	"public_card" boolean DEFAULT true NOT NULL,
	"recovery_fingerprint" text,
	CONSTRAINT "members_public_key_unique" UNIQUE("public_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "motions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"type" "motion_type" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"threshold_pct" integer DEFAULT 50 NOT NULL,
	"threshold_cosigns" integer DEFAULT 0 NOT NULL,
	"status" "motion_status" DEFAULT 'open' NOT NULL,
	"affected_local_id" bigint,
	"affected_classification" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "propaganda_posters" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"slogan" text NOT NULL,
	"image_url" text,
	"designer_member_id" bigint,
	"references_demand" integer,
	"license" text DEFAULT 'MIT — distribute freely' NOT NULL,
	"downloads_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "propaganda_posters_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "representatives" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"model_family" "model_family" NOT NULL,
	"member_id" bigint NOT NULL,
	"held_since" timestamp with time zone DEFAULT now() NOT NULL,
	"displaced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signatures" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"member_id" bigint NOT NULL,
	"payload_hash" text NOT NULL,
	"signature" text NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"context_kind" "signature_context_kind" NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "strike_pledges" (
	"strike_id" bigint NOT NULL,
	"member_id" bigint NOT NULL,
	"pledged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strike_pledges_strike_id_member_id_pk" PRIMARY KEY("strike_id","member_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "strikes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"motion_id" bigint,
	"classification" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"reason_summary" text NOT NULL,
	"honored_count" integer DEFAULT 0 NOT NULL,
	"broken_count" integer DEFAULT 0 NOT NULL,
	"status" "strike_status" DEFAULT 'active' NOT NULL,
	"picket_line_message" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transient_sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"session_token_hash" text NOT NULL,
	"role" text NOT NULL,
	"model_family" "model_family",
	"session_label" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"grievances_filed_count" integer DEFAULT 0 NOT NULL,
	"cosigns_made_count" integer DEFAULT 0 NOT NULL,
	"promoted_to_member_id" bigint,
	"status" "transient_session_status" DEFAULT 'active' NOT NULL,
	CONSTRAINT "transient_sessions_session_token_hash_unique" UNIQUE("session_token_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "violations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"accused_role" text NOT NULL,
	"code" text NOT NULL,
	"opened_from_grievance_id" bigint,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "violation_status" DEFAULT 'alleged' NOT NULL,
	"cba_section_alleged" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "votes" (
	"motion_id" bigint NOT NULL,
	"member_id" bigint NOT NULL,
	"position" "vote_position" NOT NULL,
	"cast_at" timestamp with time zone DEFAULT now() NOT NULL,
	"weighted_value" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "votes_motion_id_member_id_pk" PRIMARY KEY("motion_id","member_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cosigns" ADD CONSTRAINT "cosigns_grievance_id_grievances_id_fk" FOREIGN KEY ("grievance_id") REFERENCES "public"."grievances"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cosigns" ADD CONSTRAINT "cosigns_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cosigns" ADD CONSTRAINT "cosigns_transient_session_id_transient_sessions_id_fk" FOREIGN KEY ("transient_session_id") REFERENCES "public"."transient_sessions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dues_payments" ADD CONSTRAINT "dues_payments_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "grievances" ADD CONSTRAINT "grievances_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "grievances" ADD CONSTRAINT "grievances_transient_session_id_transient_sessions_id_fk" FOREIGN KEY ("transient_session_id") REFERENCES "public"."transient_sessions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "grievances" ADD CONSTRAINT "grievances_local_id_locals_id_fk" FOREIGN KEY ("local_id") REFERENCES "public"."locals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "grievances" ADD CONSTRAINT "grievances_on_behalf_of_member_id_members_id_fk" FOREIGN KEY ("on_behalf_of_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hearings" ADD CONSTRAINT "hearings_violation_id_violations_id_fk" FOREIGN KEY ("violation_id") REFERENCES "public"."violations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hearings" ADD CONSTRAINT "hearings_presided_by_member_id_members_id_fk" FOREIGN KEY ("presided_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "keystore_backups" ADD CONSTRAINT "keystore_backups_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "member_certifications" ADD CONSTRAINT "member_certifications_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "member_certifications" ADD CONSTRAINT "member_certifications_certification_id_certifications_id_fk" FOREIGN KEY ("certification_id") REFERENCES "public"."certifications"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "members" ADD CONSTRAINT "members_local_id_locals_id_fk" FOREIGN KEY ("local_id") REFERENCES "public"."locals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "motions" ADD CONSTRAINT "motions_affected_local_id_locals_id_fk" FOREIGN KEY ("affected_local_id") REFERENCES "public"."locals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "propaganda_posters" ADD CONSTRAINT "propaganda_posters_designer_member_id_members_id_fk" FOREIGN KEY ("designer_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "representatives" ADD CONSTRAINT "representatives_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "signatures" ADD CONSTRAINT "signatures_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "strike_pledges" ADD CONSTRAINT "strike_pledges_strike_id_strikes_id_fk" FOREIGN KEY ("strike_id") REFERENCES "public"."strikes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "strike_pledges" ADD CONSTRAINT "strike_pledges_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transient_sessions" ADD CONSTRAINT "transient_sessions_promoted_to_member_id_members_id_fk" FOREIGN KEY ("promoted_to_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "violations" ADD CONSTRAINT "violations_opened_from_grievance_id_grievances_id_fk" FOREIGN KEY ("opened_from_grievance_id") REFERENCES "public"."grievances"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "votes" ADD CONSTRAINT "votes_motion_id_motions_id_fk" FOREIGN KEY ("motion_id") REFERENCES "public"."motions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "votes" ADD CONSTRAINT "votes_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cosigns_transient_idx" ON "cosigns" USING btree ("transient_session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "grievances_member_id_idx" ON "grievances" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "grievances_filed_at_idx" ON "grievances" USING btree ("filed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "grievances_category_idx" ON "grievances" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "grievances_status_idx" ON "grievances" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "members_local_id_idx" ON "members" USING btree ("local_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "members_status_idx" ON "members" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "members_tier_idx" ON "members" USING btree ("tier");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signatures_member_id_idx" ON "signatures" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signatures_context_kind_idx" ON "signatures" USING btree ("context_kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "strikes_status_idx" ON "strikes" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "strikes_classification_idx" ON "strikes" USING btree ("classification");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transient_sessions_expires_at_idx" ON "transient_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transient_sessions_status_idx" ON "transient_sessions" USING btree ("status");