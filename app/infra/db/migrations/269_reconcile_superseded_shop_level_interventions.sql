BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:reconcile-superseded-shop-level-interventions-269')
);

-- Legacy shop-level alerts predate ordinary-instance identity binding. Close
-- only alerts with no order identity after a later healthy synchronization
-- proves that the shop runner recovered. Explicitly prohibited warehouses are
-- not candidates; only the three warehouses approved by migration 219 are.
WITH candidates AS MATERIALIZED (
  SELECT
    intervention.id,
    intervention.shop_id,
    intervention.reason_code,
    intervention.reason,
    intervention.created_at,
    recovery.last_success_at,
    CASE
      WHEN intervention.reason_code = 'warehouse-out-of-scope'
        THEN 'expanded-warehouse-allow-list'
      ELSE 'later-healthy-shop-synchronization'
    END AS recovery_evidence
  FROM manual_interventions intervention
  JOIN shops shop
    ON shop.id = intervention.shop_id
    AND shop.enabled = true
    AND shop.onboarding_status = 'ready'
  JOIN LATERAL (
    SELECT max(cursor.last_success_at) AS last_success_at
    FROM sync_cursors cursor
    WHERE cursor.shop_id = intervention.shop_id
      AND cursor.last_success_at > intervention.created_at
      AND coalesce(cursor.backlog_count, 0) = 0
      AND cursor.last_error IS NULL
  ) recovery ON recovery.last_success_at IS NOT NULL
  WHERE intervention.status IN ('open', 'acknowledged')
    AND intervention.channel = 'dashboard'
    AND intervention.work_order_id IS NULL
    AND intervention.ordinary_instance_id IS NULL
    AND intervention.created_at <= now() - interval '48 hours'
    AND (
      intervention.reason_code IN (
        'external-system-error',
        'page-crashed',
        'tms-query-miss',
        'oms-query-miss',
        'unknown-scenario'
      )
      OR (
        intervention.reason_code = 'warehouse-out-of-scope'
        AND regexp_replace(intervention.reason, '\s+', '', 'g') ~
          'OMS发货仓库[“"]代发聚水潭-(迅发|品动工贸|祺迦工贸)[”"]不在业务处理范围'
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM work_orders work_order
      LEFT JOIN ordinary_work_order_instances instance
        ON instance.id = work_order.current_ordinary_instance_id
        AND instance.work_order_id = work_order.id
        AND instance.shop_id = work_order.shop_id
      WHERE work_order.shop_id = intervention.shop_id
        AND coalesce(work_order.frontend_visibility, 'operational') = 'operational'
        AND coalesce(work_order.completion_state, 'pending') = 'pending'
        AND work_order.status NOT IN ('completed', 'archived')
        AND (
          work_order.manual_review_reason = intervention.reason
          OR instance.manual_review_reason = intervention.reason
        )
    )
  FOR UPDATE OF intervention
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, candidate.last_success_at),
    resolved_by = coalesce(intervention.resolved_by, 'migration-269')
  FROM candidates candidate
  WHERE intervention.id = candidate.id
  RETURNING
    intervention.id,
    candidate.shop_id,
    candidate.reason_code,
    candidate.reason,
    candidate.created_at,
    candidate.last_success_at,
    candidate.recovery_evidence
), cancelled_notifications AS (
  UPDATE notification_outbox outbox
  SET status = 'cancelled',
    updated_at = now(),
    last_error = jsonb_build_object(
      'reason', 'superseded-shop-level-intervention-reconciled',
      'migration', '269'
    )
  FROM resolved
  WHERE outbox.intervention_id = resolved.id
    AND outbox.status IN ('pending', 'sending', 'failed')
  RETURNING outbox.id
), audited AS (
  INSERT INTO audit_events
    (shop_id, actor_id, event_type, payload, deduplication_key)
  SELECT
    resolved.shop_id,
    'migration-269',
    'superseded-shop-level-intervention-reconciled',
    jsonb_build_object(
      'interventionId', resolved.id,
      'reasonCode', resolved.reason_code,
      'reason', resolved.reason,
      'createdAt', resolved.created_at,
      'laterHealthySyncAt', resolved.last_success_at,
      'recoveryEvidence', resolved.recovery_evidence,
      'workOrderIdentityPresent', false,
      'businessActionsReplayed', false
    ),
    'migration-269:shop-level-intervention:' || resolved.id::text
  FROM resolved
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING id
)
SELECT
  count(*) AS resolved_intervention_count,
  count(*) FILTER (
    WHERE reason_code = 'warehouse-out-of-scope'
  ) AS resolved_expanded_warehouse_count,
  count(*) FILTER (
    WHERE reason_code <> 'warehouse-out-of-scope'
  ) AS resolved_transient_count
FROM resolved;

INSERT INTO schema_migrations (version)
VALUES ('269_reconcile_superseded_shop_level_interventions.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
