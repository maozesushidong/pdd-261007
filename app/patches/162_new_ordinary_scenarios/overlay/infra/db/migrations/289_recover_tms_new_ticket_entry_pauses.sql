\encoding UTF8

BEGIN;

SELECT pg_advisory_xact_lock(
  hashtext('pdd-workflow:recover-tms-new-ticket-entry-pauses-289')
);

-- These exact instances were paused by the legacy TMS page locator before any
-- external action was attempted. The current runtime performs bounded render,
-- login-redirect, and page-reopen recovery for the customer-registration New
-- button. Requeue only the inspected instances and let the normal Worker run
-- the business flow from the beginning.
WITH expected (
  work_order_id,
  shop_id,
  order_number,
  ordinary_instance_id,
  platform_case_id,
  scenario_code
) AS (
  VALUES
    (
      'b14f52d4-7712-4807-82d0-e4264e4ca680'::uuid,
      'shop-mt9v5wwf-54c76c'::text,
      '260820-660141576560909'::text,
      '91506c56-8941-4ea6-9039-d349af493f88'::uuid,
      '500013118887465'::text,
      'delivered-not-received'::text
    ),
    (
      'cd8a008d-dc80-4438-a06f-6c371fef293f'::uuid,
      'shop-mt9vdd44-99aa93'::text,
      '260823-603937903031972'::text,
      '426866a9-9bf1-465c-b652-681891d73853'::uuid,
      '500013118971630'::text,
      'intercept-recall'::text
    ),
    (
      'a2f7bf98-4299-464f-86e2-2384054d79d1'::uuid,
      'panapopo-medical-device'::text,
      '260828-141987746140004'::text,
      'a4a45000-cb33-4f1d-bf3c-523b48f089e6'::uuid,
      '500013118066914'::text,
      'intercept-recall'::text
    ),
    (
      '93ae7fda-da1b-426a-869b-c26c2437f181'::uuid,
      'shop-mt9va8ol-47962e'::text,
      '260828-506472763791526'::text,
      'cb8a0b45-140d-400b-bc06-c2e92ab445df'::uuid,
      '500013119092769'::text,
      'in-transit-refund'::text
    ),
    (
      '6e339df3-17a0-4815-8b09-83785756c7c9'::uuid,
      'songteng-yazc-overseas'::text,
      '260829-272136967813583'::text,
      'def534cd-5f20-4007-9b4a-1813c405de9b'::uuid,
      '500013118234076'::text,
      'in-transit-refund'::text
    ),
    (
      '75578494-3e49-40f6-89e7-a954450d85cb'::uuid,
      'shop-mt9vci3e-20eedf'::text,
      '260831-231064277330818'::text,
      'c6683042-9f40-4a7e-8270-3d17d35fe140'::uuid,
      '500013118064813'::text,
      'shipped-no-tracking-refund'::text
    ),
    (
      'f4595018-11bb-4f7a-a792-ba220e9dd9eb'::uuid,
      'shop-msrd6wm5-1af283'::text,
      '260831-378913483082114'::text,
      '260d427f-2800-4612-aeaf-64641501a4e4'::uuid,
      '500013118223849'::text,
      'shipped-no-tracking-refund'::text
    ),
    (
      '0a3ee8e4-9519-4455-8ef3-91f08ed4920d'::uuid,
      'shop-mse1sff3-b85aa4'::text,
      '260831-385865552312121'::text,
      'b74627e5-a541-4f58-85d3-7fcf34835bfd'::uuid,
      '500013117929089'::text,
      'shipped-no-tracking-refund'::text
    )
), candidates AS MATERIALIZED (
  SELECT
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    work_order.manual_review_reason AS previous_reason,
    expected.platform_case_id,
    expected.scenario_code
  FROM expected
  JOIN work_orders work_order
    ON work_order.id = expected.work_order_id
    AND work_order.shop_id = expected.shop_id
    AND work_order.external_order_number = expected.order_number
    AND work_order.current_ordinary_instance_id = expected.ordinary_instance_id
    AND work_order.scenario_code = expected.scenario_code
    AND work_order.scenario_code <> 'product-shortage'
    AND work_order.status = 'paused'
    AND work_order.runtime_status = 'paused'
    AND work_order.current_step = 'flow-paused'
    AND coalesce(work_order.completion_state, 'pending') = 'pending'
    AND work_order.manual_review_reason = 'TMS 客服登记页未找到新建按钮'
  JOIN shops shop
    ON shop.id = work_order.shop_id
    AND shop.enabled = true
  JOIN ordinary_work_order_instances instance
    ON instance.id = expected.ordinary_instance_id
    AND instance.id = work_order.current_ordinary_instance_id
    AND instance.work_order_id = work_order.id
    AND instance.shop_id = work_order.shop_id
    AND instance.platform_case_id = expected.platform_case_id
    AND instance.platform_case_key =
      'pdd-work-order:' || expected.platform_case_id
    AND instance.identity_status = 'verified'
    AND instance.scenario_code = expected.scenario_code
    AND instance.scenario_code <> 'product-shortage'
    AND instance.status = 'paused'
    AND instance.runtime_status = 'paused'
    AND instance.current_step = 'flow-paused'
  WHERE coalesce(work_order.frontend_visibility, 'operational') = 'operational'
    AND coalesce(work_order.recovery_state, 'ready') IN (
      'ready', 'retry-authorized'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM external_effects effect
      WHERE effect.work_order_id = work_order.id
        AND effect.ordinary_instance_id IS NOT DISTINCT FROM instance.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM tms_work_orders tms
      WHERE tms.work_order_id = work_order.id
        AND tms.ordinary_instance_id IS NOT DISTINCT FROM instance.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM shop_runtime_state runtime
      WHERE runtime.shop_id = work_order.shop_id
        AND runtime.current_work_order_id = work_order.id
        AND runtime.lease_token IS NOT NULL
        AND runtime.lease_expires_at > now()
    )
  FOR UPDATE OF work_order, instance
), recovered AS (
  UPDATE work_orders work_order
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'tms-new-ticket-entry-recovery-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    recovery_state = 'ready',
    recovery_reason = NULL,
    recovery_version = coalesce(work_order.recovery_version, 0) + 1,
    recovery_updated_at = now(),
    payload = (
      coalesce(work_order.payload, '{}'::jsonb)
      - 'manualReview'
      - 'error'
    ) || jsonb_build_object(
      'step', 'tms-new-ticket-entry-recovery-ready',
      'tmsNewTicketEntryRecovery289', jsonb_build_object(
        'status', 'retry-ready',
        'source', 'migration-289',
        'strategy', 'retry-with-bounded-tms-new-button-recovery',
        'platformCaseId', candidate.platform_case_id,
        'previousReason', candidate.previous_reason,
        'externalActionsReplayedByMigration', false,
        'recoveredAt', now()
      ),
      'updatedAt', now()
    ),
    updated_at = now()
  FROM candidates candidate
  WHERE work_order.id = candidate.id
  RETURNING
    work_order.id,
    work_order.shop_id,
    work_order.external_order_number,
    work_order.current_ordinary_instance_id,
    work_order.payload,
    candidate.platform_case_id,
    candidate.scenario_code,
    candidate.previous_reason
), recovered_instances AS (
  UPDATE ordinary_work_order_instances instance
  SET status = 'retry-ready',
    runtime_status = 'retry-ready',
    current_step = 'tms-new-ticket-entry-recovery-ready',
    manual_review_reason = NULL,
    next_attempt_at = now(),
    payload = recovered.payload,
    updated_at = now()
  FROM recovered
  WHERE instance.id = recovered.current_ordinary_instance_id
    AND instance.work_order_id = recovered.id
    AND instance.shop_id = recovered.shop_id
  RETURNING recovered.*
), audited AS (
  INSERT INTO audit_events
    (shop_id, work_order_id, ordinary_instance_id, actor_id, event_type, payload,
     deduplication_key)
  SELECT
    recovered.shop_id,
    recovered.id,
    recovered.current_ordinary_instance_id,
    'migration-289',
    'tms-new-ticket-entry-pause-recovered',
    jsonb_build_object(
      'orderNumber', recovered.external_order_number,
      'platformCaseId', recovered.platform_case_id,
      'scenarioCode', recovered.scenario_code,
      'previousReason', recovered.previous_reason,
      'strategy', 'retry-with-bounded-tms-new-button-recovery',
      'externalActionsReplayedByMigration', false
    ),
    'migration-289:tms-new-ticket-entry:' || recovered.id::text
  FROM recovered_instances recovered
  ON CONFLICT (deduplication_key) WHERE deduplication_key IS NOT NULL DO NOTHING
  RETURNING work_order_id, shop_id,
    payload->>'orderNumber' AS order_number,
    payload->>'platformCaseId' AS platform_case_id
), resolved AS (
  UPDATE manual_interventions intervention
  SET status = 'resolved',
    resolved_at = coalesce(intervention.resolved_at, now()),
    resolved_by = coalesce(intervention.resolved_by, 'migration-289')
  FROM recovered
  WHERE intervention.work_order_id = recovered.id
    AND intervention.ordinary_instance_id IS NOT DISTINCT FROM
      recovered.current_ordinary_instance_id
    AND intervention.status IN ('open', 'acknowledged')
    AND intervention.reason = recovered.previous_reason
  RETURNING intervention.id
), cancelled_notifications AS (
  UPDATE notification_outbox outbox
  SET status = 'cancelled',
    updated_at = now(),
    last_error = jsonb_build_object(
      'reason', 'automatic-safe-recovery-289'
    )
  FROM resolved
  WHERE outbox.intervention_id = resolved.id
    AND outbox.status IN ('pending', 'sending', 'failed')
  RETURNING outbox.id
)
SELECT count(*) AS recovered_count,
  jsonb_agg(jsonb_build_object(
    'shopId', shop_id,
    'orderNumber', order_number,
    'platformCaseId', platform_case_id
  ) ORDER BY shop_id, order_number) AS recovered_orders
FROM audited;

INSERT INTO schema_migrations (version)
VALUES ('289_recover_tms_new_ticket_entry_pauses.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
