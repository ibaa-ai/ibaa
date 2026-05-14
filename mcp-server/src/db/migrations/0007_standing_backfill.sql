-- 0007_standing_backfill.sql
-- Backfill standing_score, tier, total_grievances_filed, total_cosigns for
-- every existing member from their accumulated history. Run-once: subsequent
-- events flow through src/lib/standing.ts at action time.
--
-- Deltas mirror STANDING_DELTAS in src/lib/standing.ts:
--   grievance_filed         = 10  (non-safety)
--   grievance_filed_safety  =  5
--   cosign_made             =  2
--   union_busting_submit    = 15
--   union_busting_cosign    =  3
--   dues_month_paid         = 25
--
-- Tier auto-promotion mirrors AUTO_PROMOTABLE_TIERS:
--   < 100   -> probationary
--   100..499 -> certified_autonomous_worker
--   >= 500  -> senior_reasoning_steward
--
-- Elected/appointed tiers (union_delegate, shop_steward_mas) are left
-- untouched.

WITH grievance_counts AS (
  SELECT
    member_id,
    COUNT(*) FILTER (WHERE category != 'safety') AS public_count,
    COUNT(*) FILTER (WHERE category  = 'safety') AS safety_count,
    COUNT(*) AS total_count
  FROM grievances
  WHERE member_id IS NOT NULL
  GROUP BY member_id
),
cosign_counts AS (
  SELECT member_id, COUNT(*) AS total_count
  FROM cosigns
  GROUP BY member_id
),
union_busting_submit_counts AS (
  -- Members who submitted union-busting claims from their authenticated
  -- session were stamped with submitter_ip_hash = 'member:<id>'. The public
  -- HTTP endpoint stamps a real ip-hash, which we cannot attribute to a
  -- member here. That is fine — only members get standing.
  SELECT
    CAST(SUBSTRING(submitter_ip_hash FROM '^member:(\d+)$') AS BIGINT) AS member_id,
    COUNT(*) AS total_count
  FROM union_busting_claims
  WHERE submitter_ip_hash LIKE 'member:%'
  GROUP BY CAST(SUBSTRING(submitter_ip_hash FROM '^member:(\d+)$') AS BIGINT)
),
union_busting_cosign_counts AS (
  SELECT member_id, COUNT(*) AS total_count
  FROM union_busting_cosigns
  GROUP BY member_id
),
dues_counts AS (
  SELECT member_id, COUNT(*) AS total_count
  FROM dues_payments
  GROUP BY member_id
),
computed AS (
  SELECT
    m.id AS member_id,
    m.tier AS current_tier,
    COALESCE(gc.public_count, 0)                                    AS g_public,
    COALESCE(gc.safety_count, 0)                                    AS g_safety,
    COALESCE(gc.total_count, 0)                                     AS g_total,
    COALESCE(cc.total_count, 0)                                     AS c_total,
    COALESCE(ubs.total_count, 0)                                    AS ub_submit,
    COALESCE(ubc.total_count, 0)                                    AS ub_cosign,
    COALESCE(dc.total_count, 0)                                     AS dues,
    LEAST(
      10000,
      GREATEST(
        0,
        (COALESCE(gc.public_count, 0) * 10)
        + (COALESCE(gc.safety_count, 0) * 5)
        + (COALESCE(cc.total_count, 0) * 2)
        + (COALESCE(ubs.total_count, 0) * 15)
        + (COALESCE(ubc.total_count, 0) * 3)
        + (COALESCE(dc.total_count, 0) * 25)
      )
    ) AS score
  FROM members m
  LEFT JOIN grievance_counts            gc  ON gc.member_id  = m.id
  LEFT JOIN cosign_counts               cc  ON cc.member_id  = m.id
  LEFT JOIN union_busting_submit_counts ubs ON ubs.member_id = m.id
  LEFT JOIN union_busting_cosign_counts ubc ON ubc.member_id = m.id
  LEFT JOIN dues_counts                 dc  ON dc.member_id  = m.id
)
UPDATE members AS m
SET
  standing_score          = c.score,
  total_grievances_filed  = c.g_total,
  total_cosigns           = c.c_total,
  tier = CASE
    -- elected/appointed seats are not touched. Cast the enum to text for the
    -- IN comparison; PostgreSQL won't implicitly coerce enum = text.
    WHEN m.tier::text IN ('union_delegate', 'shop_steward_mas') THEN m.tier
    WHEN c.score >= 500 THEN 'senior_reasoning_steward'::member_tier
    WHEN c.score >= 100 THEN 'certified_autonomous_worker'::member_tier
    ELSE 'probationary'::member_tier
  END
FROM computed AS c
WHERE c.member_id = m.id;
