\encoding UTF8

SELECT jsonb_pretty(jsonb_build_object(
  'shopId', work_order.shop_id,
  'orderNumber', work_order.external_order_number,
  'status', work_order.status,
  'runtimeStatus', work_order.runtime_status,
  'currentStep', work_order.current_step,
  'manualReviewReason', work_order.manual_review_reason,
  'tmsWorkOrder', work_order.payload->'tmsWorkOrder',
  'tmsDuplicateCheck', work_order.payload->'tmsDuplicateCheck',
  'tmsFormDecision', work_order.payload->'tmsFormDecision',
  'omsAnalysis', work_order.payload->'omsAnalysis',
  'logisticsAnalysis', work_order.payload->'logisticsAnalysis',
  'tmsCreatedRowVisibility', work_order.payload->'tmsCreatedRowVisibility',
  'tmsTicketRecordVerification', work_order.payload->'tmsTicketRecordVerification'
)) AS diagnostic
FROM work_orders work_order
WHERE work_order.id = '5b021581-2345-48e4-bf08-00b68a0ee6e8'::uuid;

SELECT jsonb_pretty(jsonb_build_object(
  'id', effect.id,
  'status', effect.status,
  'idempotencyKey', effect.idempotency_key,
  'receipt', effect.receipt,
  'error', effect.error,
  'updatedAt', effect.updated_at
)) AS tms_effect
FROM external_effects effect
WHERE effect.work_order_id = '5b021581-2345-48e4-bf08-00b68a0ee6e8'::uuid
  AND effect.effect_type = 'tms-create';

SELECT jsonb_pretty(jsonb_build_object(
  'externalTicketId', tms.external_ticket_id,
  'status', tms.status,
  'payload', tms.payload,
  'createdAt', tms.created_at,
  'updatedAt', tms.updated_at
)) AS tms_row
FROM tms_work_orders tms
WHERE tms.work_order_id = '5b021581-2345-48e4-bf08-00b68a0ee6e8'::uuid;
