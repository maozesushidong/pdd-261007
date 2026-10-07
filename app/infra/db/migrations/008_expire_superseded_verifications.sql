WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY shop_id, system_name ORDER BY detected_at DESC, id DESC
  ) AS position
  FROM verification_locations
  WHERE status IN ('detected', 'waiting-human')
)
UPDATE verification_locations verification
SET status = 'expired', resolved_at = coalesce(verification.resolved_at, now())
FROM ranked
WHERE verification.id = ranked.id AND ranked.position > 1;
