BEGIN;

-- PDD error 48143 is a definitive upload-authorization rejection. Current
-- workflows deliberately stop after the configured attempt limit, which may
-- be one attempt. Persist a deduplicated DingTalk notification for today's
-- still-paused real work orders even if a legacy generic dashboard record was
-- already resolved.
WITH eligible AS (
  SELECT
    gen_random_uuid() AS intervention_id,
    work_order.id AS work_order_id,
    work_order.shop_id,
    work_order.current_ordinary_instance_id,
    work_order.external_order_number,
    work_order.work_order_type,
    work_order.current_step,
    work_order.updated_at,
    work_order.payload,
    shop.name AS shop_name,
    evidence.id::text AS tms_evidence_asset_id,
    CASE
      WHEN work_order.payload #>> '{ordinaryEvidenceUploadRecovery,updatedAt}'
        ~ '^\d{4}-\d{2}-\d{2}T'
      THEN (work_order.payload #>> '{ordinaryEvidenceUploadRecovery,updatedAt}')::timestamptz
      ELSE work_order.updated_at
    END AS occurred_at
  FROM work_orders work_order
  JOIN shops shop ON shop.id = work_order.shop_id
  LEFT JOIN LATERAL (
    SELECT asset.id
    FROM evidence_assets asset
    WHERE asset.work_order_id = work_order.id
      AND asset.ordinary_instance_id IS NOT DISTINCT FROM work_order.current_ordinary_instance_id
      AND asset.kind = 'tms-evidence'
      AND asset.status = 'ready'
      AND asset.deleted_at IS NULL
    ORDER BY asset.created_at DESC
    LIMIT 1
  ) evidence ON true
  WHERE work_order.status = 'paused'
    AND work_order.runtime_status NOT IN ('completed', 'archived')
    AND coalesce(work_order.completion_state, 'pending') <> 'confirmed'
    AND work_order.payload #>> '{ordinaryEvidenceUpload,status}' = 'failed'
    AND work_order.payload #>> '{ordinaryEvidenceUpload,diagnostics,authorizationFailure,code}'
      = 'PDD_EVIDENCE_UPLOAD_AUTHORIZATION_REJECTED'
    AND work_order.payload #>> '{ordinaryEvidenceUpload,diagnostics,authorizationFailure,errorCode}' = '48143'
    AND work_order.payload #>> '{ordinaryEvidenceUploadRecovery,status}' = 'exhausted'
    AND work_order.payload #>> '{ordinaryEvidenceUploadRecovery,definitiveAuthorizationFailure}' = 'true'
    AND EXISTS (
      SELECT 1 FROM system_settings setting
      WHERE setting.key = 'dingtalk-automatic-enabled'
        AND setting.value = 'true'::jsonb
    )
    AND NOT EXISTS (
      SELECT 1 FROM manual_interventions existing
      WHERE existing.work_order_id = work_order.id
        AND existing.channel = 'dingtalk'
        AND existing.reason_code = 'pdd-upload-authorization-failed'
        AND (
          existing.ordinary_instance_id IS NULL
          OR existing.ordinary_instance_id IS NOT DISTINCT FROM work_order.current_ordinary_instance_id
        )
    )
), current_day AS (
  SELECT *
  FROM eligible
  WHERE (occurred_at AT TIME ZONE 'Asia/Shanghai')::date
    = (now() AT TIME ZONE 'Asia/Shanghai')::date
), inserted AS (
  INSERT INTO manual_interventions
    (id, shop_id, work_order_id, ordinary_instance_id, channel,
     reason_code, reason, risk_level, deduplication_key)
  SELECT
    intervention_id,
    shop_id,
    work_order_id,
    current_ordinary_instance_id,
    'dingtalk',
    'pdd-upload-authorization-failed',
    '拼多多凭证图片上传失败：上传授权接口返回 48143 非法请求，自动重试已结束',
    'high',
    concat(
      'dingtalk:automatic:',
      work_order_id::text,
      ':',
      coalesce(current_ordinary_instance_id::text, 'no-instance'),
      ':pdd-upload-authorization-failed'
    )
  FROM current_day
  ON CONFLICT (deduplication_key) DO NOTHING
  RETURNING id
)
INSERT INTO notification_outbox (id, intervention_id, payload)
SELECT
  gen_random_uuid(),
  current_day.intervention_id,
  jsonb_strip_nulls(jsonb_build_object(
    'workOrderId', current_day.work_order_id::text,
    'ordinaryInstanceId', current_day.current_ordinary_instance_id::text,
    'shopId', current_day.shop_id,
    'shopName', current_day.shop_name,
    'orderNumber', current_day.external_order_number,
    'warehouse', coalesce(
      current_day.payload #>> '{omsAnalysis,shippingWarehouse}',
      current_day.payload #>> '{omsAnalysis,warehouse}',
      current_day.payload #>> '{omsAnalysis,warehouseName}',
      current_day.payload #>> '{omsWarehouseParse,parsedValue}',
      current_day.payload #>> '{tmsAutofillVerification,actual,warehouse}'
    ),
    'tmsEvidenceAssetId', current_day.tms_evidence_asset_id,
    'trackingNumber', current_day.payload #>> '{logisticsAnalysis,trackingNumber}',
    'workOrderType', coalesce(
      current_day.work_order_type,
      current_day.payload->>'workOrderType'
    ),
    'problemZh', '拼多多凭证图片上传失败：上传授权接口返回 48143 非法请求，自动重试已结束',
    'incompleteAnalysis', jsonb_build_object(
      'reasonZh', '拼多多凭证图片上传失败：上传授权接口返回 48143 非法请求，自动重试已结束',
      'reasonEn', 'Pinduoduo rejected the image upload authorization request as illegal.',
      'descriptionZh', '凭证图片上传被拼多多签名接口以 48143 非法请求明确拒绝，自动重试已结束，最终提交未执行。',
      'descriptionEn', 'Pinduoduo explicitly rejected the evidence upload signature request with error 48143. Automatic retries ended and the final submission was not executed.',
      'stoppedStep', coalesce(current_day.current_step, 'pdd-resolution-recovery-exhausted')
    ),
    'reasonCode', 'pdd-upload-authorization-failed',
    'riskLevel', 'high',
    'system', 'pdd',
    'stage', coalesce(current_day.current_step, 'pdd-resolution-recovery-exhausted'),
    'occurredAt', to_jsonb(current_day.occurred_at),
    'deliverySource', 'automatic'
  ))
FROM current_day
JOIN inserted ON inserted.id = current_day.intervention_id;

INSERT INTO schema_migrations (version)
VALUES ('222_backfill_current_pdd_upload_authorization_notifications.sql')
ON CONFLICT (version) DO NOTHING;

COMMIT;
