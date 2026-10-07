const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const manualHoldAt = Date.parse('2099-01-01T00:00:00.000Z');

// This recognizes an existing indefinite manual hold for a code-only reload.
// It never authorizes a claim, reconciliation, retry or external submission.
export const matchesDispatchedRefundManualHold = ({
  enabled, shopId, expectedShopName, expectedWorkOrderId, expectedEffectId,
  expectedOrderNumber, expectedAftersaleNumber, row, binding, now = Date.now(),
} = {}) => {
  if (enabled !== true || !row || !binding || !shopId || !expectedShopName
    || !uuidPattern.test(String(expectedWorkOrderId || ''))
    || !uuidPattern.test(String(expectedEffectId || ''))
    || !/^\d{6}-\d{15}$/u.test(String(expectedOrderNumber || ''))
    || !/^\d{6,30}$/u.test(String(expectedAftersaleNumber || ''))
    || !uuidPattern.test(String(binding.binding_token || ''))
    || !String(binding.mall_id || '').trim()
    || binding.actual_shop_name !== expectedShopName
    || !Number.isFinite(now) || manualHoldAt <= now + 6 * 60 * 60_000) return false;
  if (row.id !== expectedEffectId || row.work_order_id !== expectedWorkOrderId
    || row.effect_shop_id !== shopId || row.work_shop_id !== shopId
    || row.refund_shop_id !== shopId || row.refund_work_order_id !== expectedWorkOrderId
    || row.external_order_number !== expectedOrderNumber || row.refund_order !== expectedOrderNumber
    || row.aftersale_number !== expectedAftersaleNumber
    || row.effect_type !== 'pdd-return-refund' || row.effect_status !== 'unknown'
    || row.idempotency_key !== `pdd-return-refund:${expectedAftersaleNumber}`
    || row.scenario_code !== 'return-refund' || row.work_status !== 'paused'
    || row.work_runtime_status !== 'manual-review' || row.completion_state !== 'pending'
    || row.current_step !== 'return-refund-dispatched-unknown-manual-review'
    || row.recovery_state !== 'ready' || row.recovery_reason !== null
    || row.ordinary_instance_id !== null || row.current_ordinary_instance_id !== null
    || row.action_state !== 'manual-review'
    || Date.parse(row.next_attempt_at) !== manualHoldAt
    || Date.parse(row.next_check_at) !== manualHoldAt
    || row.refund_binding_token !== binding.binding_token
    || row.refund_mall_id !== String(binding.mall_id)
    || row.refund_shop_name !== expectedShopName
    || row.effect_count !== 1 || row.active_commands !== 0
    || row.owns_current_lease !== false) return false;
  const receipt = row.effect_receipt;
  if (receipt?.orderNumber !== expectedOrderNumber
    || String(receipt?.aftersaleNumber || '') !== expectedAftersaleNumber
    || !(receipt?.submission?.confirmationDispatchStarted === true
      || receipt?.submission?.confirmationClicked === true)) return false;
  try {
    const detail = new URL(row.detail_url);
    return detail.origin === 'https://mms.pinduoduo.com'
      && detail.pathname === '/aftersales-ssr/detail'
      && detail.username === '' && detail.password === ''
      && detail.searchParams.get('id') === expectedAftersaleNumber
      && detail.searchParams.get('orderSn') === expectedOrderNumber;
  } catch { return false; }
};
