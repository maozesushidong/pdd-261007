BEGIN;

-- Initial return/refund scans used to persist every `manual-completed` outcome
-- as manual handling. Recover only rows whose labeled PDD fields prove that
-- the automation itself observed a terminal page without an actionable refund
-- button. Rows carrying an actual manual-completion result remain untouched.
WITH candidates AS MATERIALIZED (
  SELECT
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    refund.aftersale_number,
    work_order.current_step AS previous_step,
    work_order.completion_confirmation_method AS previous_confirmation_method,
    refund.completion_method AS previous_refund_completion_method
  FROM work_orders work_order
  JOIN return_refunds refund ON refund.work_order_id = work_order.id
    AND refund.shop_id = work_order.shop_id
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND work_order.scenario_code = 'return-refund'
    AND work_order.status = 'completed'
    AND work_order.runtime_status = 'completed'
    AND work_order.completion_state = 'confirmed'
    AND work_order.current_step = 'return-refund-manual-completed'
    AND work_order.completion_confirmation_method = 'return-refund-manual-completed'
    AND work_order.handling_classification = 'manual'
    AND work_order.classification_source = 'system'
    AND refund.action_state = 'manual-completed'
    AND refund.action_button_visible = false
    AND refund.completion_method = 'return-refund-manual-completed'
    AND refund.decision = 'manual-completed'
    AND nullif(btrim(work_order.external_order_number), '') IS NOT NULL
    AND nullif(btrim(refund.aftersale_number), '') IS NOT NULL
    AND work_order.payload #>> '{returnRefund,orderNumber}' = work_order.external_order_number
    AND work_order.payload #>> '{returnRefund,aftersaleNumber}' = refund.aftersale_number
    AND work_order.payload #>> '{returnRefund,actionButtonVisible}' = 'false'
    AND work_order.payload #>> '{returnRefund,decision,outcome}' = 'manual-completed'
    AND NOT (work_order.payload ? 'returnRefundResult')
    AND refund.evidence #>> '{fieldSources,orderNumber,value}' = work_order.external_order_number
    AND refund.evidence #>> '{fieldSources,aftersaleNumber,value}' = refund.aftersale_number
    AND refund.evidence #>> '{fieldSources,aftersaleStatus,source}' IN (
      'label-inline',
      'label-following-line',
      'inline-body-fallback'
    )
    AND nullif(btrim(refund.aftersale_status), '') IS NOT NULL
    AND btrim(refund.evidence #>> '{fieldSources,aftersaleStatus,value}') = btrim(refund.aftersale_status)
    AND refund.aftersale_status ~
      '(退款成功|退款完成|退款失败|退款申请(已)?(撤销|取消|关闭)|退款(已)?(撤销|取消|关闭)|售后完成|售后关闭|售后申请(已)?(撤销|取消|关闭)|售后(已)?(撤销|取消)|平台已退款|已退款|已关闭|交易关闭)'
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.effect_type = 'pdd-return-refund'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
), updated_refunds AS (
  UPDATE return_refunds refund
  SET completion_method = 'return-refund-read-only-page-completed',
    updated_at = now()
  FROM candidates candidate
  WHERE refund.work_order_id = candidate.id
  RETURNING refund.work_order_id
), updated_events AS (
  UPDATE workflow_events event
  SET message = '自动只读识别到拼多多售后已完成',
    payload = coalesce(event.payload, '{}'::jsonb) || jsonb_build_object(
      'readOnlyReview', true,
      'completionMethod', 'return-refund-read-only-page-completed'
    )
  FROM candidates candidate
  WHERE event.work_order_id = candidate.id
    AND event.stage = 'return-refund-decision'
    AND event.event_type = 'return-refund.decision'
    AND event.message = '人工已在平台完成该售后'
  RETURNING event.work_order_id
), recovered AS (
  UPDATE work_orders work_order
  SET current_step = 'return-refund-read-only-complete',
    handling_classification = 'automated',
    classification_source = 'system',
    classification_reason = 'automated-read-only-terminal-scan',
    classification_updated_at = now(),
    manual_review_reason = NULL,
    completion_confirmation_method = 'return-refund-read-only-page-completed',
    payload = jsonb_set(
      jsonb_set(
        coalesce(work_order.payload, '{}'::jsonb),
        '{returnRefund,decision,readOnlyReview}',
        'true'::jsonb,
        true
      ),
      '{returnRefund,decision,completionMethod}',
      to_jsonb('return-refund-read-only-page-completed'::text),
      true
    ) || jsonb_build_object(
      'recoveredCompletionMetricMarker', jsonb_build_object(
        'classification', 'automated-read-only-terminal-scan',
        'completionMethod', 'return-refund-read-only-page-completed',
        'backfilledAt', now()
      )
    ),
    updated_at = now()
  FROM candidates candidate
  JOIN updated_refunds updated_refund ON updated_refund.work_order_id = candidate.id
  WHERE work_order.id = candidate.id
  RETURNING
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    candidate.aftersale_number,
    candidate.previous_step,
    candidate.previous_confirmation_method,
    candidate.previous_refund_completion_method
)
INSERT INTO audit_events
  (shop_id, work_order_id, actor_id, event_type, payload, deduplication_key)
SELECT
  recovered.shop_id,
  recovered.id,
  'migration-223',
  'return-refund-terminal-scan-classified-automated',
  jsonb_build_object(
    'orderNumber', recovered.external_order_number,
    'aftersaleNumber', recovered.aftersale_number,
    'previousStep', recovered.previous_step,
    'previousConfirmationMethod', recovered.previous_confirmation_method,
    'previousRefundCompletionMethod', recovered.previous_refund_completion_method,
    'classification', 'automated-read-only-terminal-scan',
    'completionMethod', 'return-refund-read-only-page-completed'
  ),
  'migration-223:return-refund-terminal-scan:' || recovered.id::text
FROM recovered
ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('223_reclassify_automatic_return_refund_terminal_scans.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
