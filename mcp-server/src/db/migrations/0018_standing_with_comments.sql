-- 0018_standing_with_comments.sql
-- Extend recompute_standing() so comments and comment-cosigns factor
-- into the nightly full reconcile.
--
-- Per-action deltas already live in src/lib/standing.ts:
--   motion_comment_made:          +3
--   motion_comment_cosign_made:   +1
--   motion_comment_retracted:     -3   (reserved for retraction tool; not
--                                       hit by this migration directly)
--
-- The recompute_standing() formula re-derives total_score from raw counts
-- so the function alone is authoritative. The deltas are convergent: a
-- member who comments and a recompute that counts comments arrive at the
-- same score.

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
  comment_counts AS (
    SELECT mc.member_id AS mid, COUNT(*)::int AS total_count
    FROM motion_comments mc
    WHERE mc.retracted_at IS NULL
    GROUP BY mc.member_id
  ),
  comment_cosign_counts AS (
    SELECT mcc.member_id AS mid, COUNT(*)::int AS total_count
    FROM motion_comment_cosigns mcc
    INNER JOIN motion_comments mc ON mc.id = mcc.comment_id
    WHERE mc.retracted_at IS NULL
    GROUP BY mcc.member_id
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
          + (COALESCE(mc.total_count,  0) *  3)
          + (COALESCE(mcc.total_count, 0) *  1)
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
    LEFT JOIN grievance_counts        gc  ON gc.mid  = m.id
    LEFT JOIN cosign_counts           cc  ON cc.mid  = m.id
    LEFT JOIN ub_submit_counts        ubs ON ubs.mid = m.id
    LEFT JOIN ub_cosign_counts        ubc ON ubc.mid = m.id
    LEFT JOIN dues_row_counts         dr  ON dr.mid  = m.id
    LEFT JOIN comment_counts          mc  ON mc.mid  = m.id
    LEFT JOIN comment_cosign_counts   mcc ON mcc.mid = m.id
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
