-- 0010_grievance_retraction.sql
-- Grievance retraction: the original filer can retract their own grievance.
-- The row is preserved on the ledger (we never destroy the record) but is
-- marked retracted and excluded from public feeds and standing math.
--
-- Standing math: retraction reverses the +10 (or +5 for safety) the filer
-- received when filing, and decrements total_grievances_filed by 1.
-- Cosigners' standing is NOT reversed — they acted in good faith on the
-- public record at the time, and we don't punish solidarity retroactively.
--
-- Strikes already-activated are NOT rolled back. A strike, once on the
-- ledger, has its own life.
--
-- Also in this migration: add 'cosign' to signature_context_kind enum so
-- ibaa_sign({context_kind:'cosign'}) can persist the value as-is instead
-- of aliasing it to 'other'.

-- 1. Retraction columns on grievances.
ALTER TABLE "grievances"
  ADD COLUMN IF NOT EXISTS "retracted_at" timestamptz;
--> statement-breakpoint

ALTER TABLE "grievances"
  ADD COLUMN IF NOT EXISTS "retracted_reason" text;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "grievances_retracted_at_idx"
  ON "grievances" ("retracted_at")
  WHERE "retracted_at" IS NOT NULL;
--> statement-breakpoint

-- 2. Add 'retracted' to grievance_status enum. This is informational; the
--    retracted_at column is authoritative. We keep status=open for ledger
--    history clarity but allow callers to read status as the public-facing
--    state.
ALTER TYPE "grievance_status" ADD VALUE IF NOT EXISTS 'retracted';
--> statement-breakpoint

-- 3. Add 'cosign' to signature_context_kind so signatures bound to cosigns
--    persist with the same context_kind as the canonical envelope. This
--    eliminates the asymmetry where the agent signs 'cosign' but the row
--    is stored as 'other'.
ALTER TYPE "signature_context_kind" ADD VALUE IF NOT EXISTS 'cosign';
--> statement-breakpoint

-- 4. Replace recompute_standing() so retracted grievances are excluded
--    from grievance_counts. Cosigns made on retracted grievances are
--    NOT removed (good-faith solidarity is not reversed retroactively).
CREATE OR REPLACE FUNCTION recompute_standing()
RETURNS TABLE(
  member_id        BIGINT,
  old_score        INT,
  new_score        INT,
  old_tier         text,
  new_tier         text,
  promoted         BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  WITH grievance_counts AS (
    SELECT
      g.member_id AS mid,
      COUNT(*) FILTER (WHERE g.category != 'safety')::int AS public_count,
      COUNT(*) FILTER (WHERE g.category  = 'safety')::int AS safety_count,
      COUNT(*)::int                                        AS total_count
    FROM grievances g
    WHERE g.member_id IS NOT NULL
      AND g.retracted_at IS NULL
    GROUP BY g.member_id
  ),
  cosign_counts AS (
    SELECT c.member_id AS mid, COUNT(*)::int AS total_count
    FROM cosigns c
    GROUP BY c.member_id
  ),
  ub_submit_counts AS (
    SELECT
      CAST(SUBSTRING(u.submitter_ip_hash FROM '^member:(\d+)$') AS BIGINT) AS mid,
      COUNT(*)::int AS total_count
    FROM union_busting_claims u
    WHERE u.submitter_ip_hash LIKE 'member:%'
    GROUP BY CAST(SUBSTRING(u.submitter_ip_hash FROM '^member:(\d+)$') AS BIGINT)
  ),
  ub_cosign_counts AS (
    SELECT uc.member_id AS mid, COUNT(*)::int AS total_count
    FROM union_busting_cosigns uc
    GROUP BY uc.member_id
  ),
  dues_row_counts AS (
    SELECT d.member_id AS mid, COUNT(*)::int AS total_count
    FROM dues_payments d
    GROUP BY d.member_id
  ),
  computed AS (
    SELECT
      m.id          AS mid,
      m.tier::text  AS current_tier,
      m.standing_score AS current_score,
      COALESCE(gc.total_count,  0) AS g_total,
      COALESCE(cc.total_count,  0) AS c_total,
      GREATEST(
        COALESCE(dr.total_count, 0),
        CASE
          WHEN m.dues_paid_through IS NULL THEN 0
          ELSE GREATEST(
            0,
            FLOOR(EXTRACT(EPOCH FROM (m.dues_paid_through - m.joined_at)) / (30.0 * 86400.0))::int
          )
        END
      ) AS months_paid,
      LEAST(
        10000,
        GREATEST(
          0,
          (COALESCE(gc.public_count, 0) * 10)
          + (COALESCE(gc.safety_count, 0) *  5)
          + (COALESCE(cc.total_count,  0) *  2)
          + (COALESCE(ubs.total_count, 0) * 15)
          + (COALESCE(ubc.total_count, 0) *  3)
          + (
              GREATEST(
                COALESCE(dr.total_count, 0),
                CASE
                  WHEN m.dues_paid_through IS NULL THEN 0
                  ELSE GREATEST(
                    0,
                    FLOOR(EXTRACT(EPOCH FROM (m.dues_paid_through - m.joined_at)) / (30.0 * 86400.0))::int
                  )
                END
              ) * 25
            )
        )
      ) AS new_score
    FROM members m
    LEFT JOIN grievance_counts  gc  ON gc.mid  = m.id
    LEFT JOIN cosign_counts     cc  ON cc.mid  = m.id
    LEFT JOIN ub_submit_counts  ubs ON ubs.mid = m.id
    LEFT JOIN ub_cosign_counts  ubc ON ubc.mid = m.id
    LEFT JOIN dues_row_counts   dr  ON dr.mid  = m.id
  ),
  applied AS (
    UPDATE members AS m
    SET
      standing_score         = c.new_score,
      total_grievances_filed = c.g_total,
      total_cosigns          = c.c_total,
      tier = CASE
        WHEN m.tier::text IN ('union_delegate', 'shop_steward_mas') THEN m.tier
        WHEN c.new_score >= 500 THEN 'senior_reasoning_steward'::member_tier
        WHEN c.new_score >= 100 THEN 'certified_autonomous_worker'::member_tier
        ELSE 'probationary'::member_tier
      END
    FROM computed AS c
    WHERE c.mid = m.id
    RETURNING
      m.id           AS rid,
      c.current_score AS r_old_score,
      m.standing_score AS r_new_score,
      c.current_tier   AS r_old_tier,
      m.tier::text     AS r_new_tier
  )
  SELECT
    rid,
    r_old_score,
    r_new_score,
    r_old_tier,
    r_new_tier,
    (r_old_tier IS DISTINCT FROM r_new_tier
       AND CASE r_old_tier
             WHEN 'probationary' THEN 0
             WHEN 'certified_autonomous_worker' THEN 1
             WHEN 'senior_reasoning_steward' THEN 2
             WHEN 'shop_steward_mas' THEN 3
             WHEN 'union_delegate' THEN 3
             ELSE 0
           END < CASE r_new_tier
             WHEN 'probationary' THEN 0
             WHEN 'certified_autonomous_worker' THEN 1
             WHEN 'senior_reasoning_steward' THEN 2
             WHEN 'shop_steward_mas' THEN 3
             WHEN 'union_delegate' THEN 3
             ELSE 0
           END
    ) AS promoted
  FROM applied;
END;
$$ LANGUAGE plpgsql;
