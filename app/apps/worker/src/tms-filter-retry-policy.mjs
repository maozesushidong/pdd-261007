const filterPanelFailure = /^TMS 物流问题登记表（客服）筛选面板在有界恢复后仍未渲染(?:$|: )/u;
const filterRequestFailure = /^TMS 交易号筛选(?:未收到查询响应|请求未携带目标交易号|接口返回 HTTP \d+)$/u;

// A created ticket must be found on the TMS page before the PDD work order
// continues. A temporary filter-panel miss is safe to retry only when the
// exact order already has a saved TMS ticket, so the next pass is read-only.
export function isRetryableCreatedTmsFilterFailure(progress = {}, reason = '') {
  const ticket = progress.tmsWorkOrder;
  return (filterPanelFailure.test(String(reason || ''))
      || filterRequestFailure.test(String(reason || '')))
    && ticket?.status === 'created'
    && String(ticket.orderNumber || '') === String(progress.orderNumber || '')
    && Boolean(String(ticket.ticketId || '').trim())
    && Boolean(String(ticket.ticketNo || '').trim())
    && progress.pddResolutionSubmission?.status !== 'unknown'
    && progress.pddResolutionSubmission?.status !== 'succeeded';
}
