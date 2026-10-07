// In-transit address changes are a separate scenario from the unshipped
// consumer-address-change flow.  The platform form and its two-stage history
// are intentionally kept here so the unshipped guard can never be widened.
export const IN_TRANSIT_ADDRESS_CHANGE_CODE = 'consumer-address-change-in-transit';
export const IN_TRANSIT_ADDRESS_CHANGE_MESSAGES = Object.freeze({
  contact: '亲，您可以把修改后的收件人信息发过来哈，我们联系快递公司尝试修改，但按照以往的经验来看会存在修改不成功的情况，而且运输途中快递也无法操作修改，只能在到达派件网点才能操作修改，所以地址修改成功也会导致派送的时间延后，亲这边也知道下这个情况。',
  result: '亲，我们已经联系快递公司按照您的要求进行收件地址的修改，但因为快递在运输中是无法修改的，只能到了派件的网点才可以操作修改，请您耐心等待哈，有派件网点未修改成功，继续派送了，您可以联系至我们，我们来帮您处理。',
  archived: '亲，我们已经联系快递公司按照您要求修改的地址修改，但是因为快递在运输中是无法修改的，只能到了派件的网点才可以操作修改，请您耐心等待哈，若到件网点未修改成功，麻烦您再退了，我们可以重新发货，我们承担退货运费。',
});
export const IN_TRANSIT_ADDRESS_CHANGE_MESSAGE_VARIANTS = Object.freeze({
  contact: Object.freeze([
    IN_TRANSIT_ADDRESS_CHANGE_MESSAGES.contact,
    // The live PDD recommendation alternates these two short phrases while
    // retaining the same warning that an in-transit address edit may fail.
    IN_TRANSIT_ADDRESS_CHANGE_MESSAGES.contact
      .replace('到达派件网点才能操作修改', '到达派件网点后才能操作修改'),
    IN_TRANSIT_ADDRESS_CHANGE_MESSAGES.contact
      .replace('派送的时间延后', '送货的时间延后'),
    IN_TRANSIT_ADDRESS_CHANGE_MESSAGES.contact
      .replace('到达派件网点才能操作修改', '到达派件网点后才能操作修改')
      .replace('派送的时间延后', '送货的时间延后'),
    // PDD also adds a sentence-final particle to the delivery-delay warning.
    IN_TRANSIT_ADDRESS_CHANGE_MESSAGES.contact
      .replace('派送的时间延后，', '送货的时间延后哈，'),
    // Observed on the live contact form: the outlet qualifier and delivery
    // particle appear together, while the failure warning is unchanged.
    IN_TRANSIT_ADDRESS_CHANGE_MESSAGES.contact
      .replace('到达派件网点才能操作修改', '到达派件网点后才能操作修改')
      .replace('派送的时间延后，', '送货的时间延后哈，'),
    IN_TRANSIT_ADDRESS_CHANGE_MESSAGES.contact
      .replace('会存在修改不成功的情况，', '会存在修改不成功的情况哈，')
      .replace('派送的时间延后，', '送货的时间延后哈，'),
    // The live recommendation also combines both particles with “网点后”
    // while retaining the original “派送” delivery-delay wording.
    IN_TRANSIT_ADDRESS_CHANGE_MESSAGES.contact
      .replace('会存在修改不成功的情况，', '会存在修改不成功的情况哈，')
      .replace('到达派件网点才能操作修改', '到达派件网点后才能操作修改')
      .replace('派送的时间延后，', '派送的时间延后哈，'),
  ]),
  result: Object.freeze([
    IN_TRANSIT_ADDRESS_CHANGE_MESSAGES.result,
    IN_TRANSIT_ADDRESS_CHANGE_MESSAGES.archived,
    IN_TRANSIT_ADDRESS_CHANGE_MESSAGES.result
      .replace('有派件网点未修改成功', '若派件网点未修改成功')
      .replace('联系至我们', '联系我们'),
    IN_TRANSIT_ADDRESS_CHANGE_MESSAGES.result
      .replace('派件的网点才可以操作修改', '派件地的网点才可以操作修改')
      .replace('有派件网点未修改成功', '若派件网点未修改成功')
      .replace('联系至我们', '联系我们'),
  ]),
});
export const IN_TRANSIT_ADDRESS_CHANGE_STAGE_CODES = Object.freeze({
  contact: 'contact-logistics-address-change',
  result: 'address-change-in-transit-result',
});

const compact = (value) => String(value || '').normalize('NFKC').replace(/\s+/gu, '').trim();
const normalized = (value) => String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
const acceptedMessage = (value, stage) => IN_TRANSIT_ADDRESS_CHANGE_MESSAGE_VARIANTS[stage]
  .some((message) => compact(value) === compact(message));
const hasMessage = (value, stage) => IN_TRANSIT_ADDRESS_CHANGE_MESSAGE_VARIANTS[stage]
  .some((message) => compact(value).includes(`发送话术:${compact(message)}`)
    || compact(value) === compact(message));

export class InTransitAddressChangeReviewError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = 'InTransitAddressChangeReviewError';
    this.code = 'PDD_IN_TRANSIT_ADDRESS_CHANGE_REVIEW';
    this.reasonCode = reasonCode;
  }
}

const manual = (base, reasonCode, reason) => ({
  ...base, outcome: 'manual-review', actionCode: 'manual-review', reasonCode, reason, pdd: null,
});
const external = (base, values) => ({ ...base, ...values, outcome: 'external-action' });
const stageSubmit = (base, values) => ({
  ...base, ...values, outcome: 'auto-submit', actionCode: 'pdd-stage-submit',
});
const completed = (base, values = {}) => ({
  ...base, ...values, outcome: 'completed', actionCode: 'pdd-complete',
});

const titleState = (text) => {
  // The detail heading currently reads “消费者要求改地址平台受理”; the
  // “物流在途…” wording is rendered in the stage prompt below it.  Accept the
  // real heading while preserving the scenario-specific evaluator boundary.
  const match = compact(text).match(/[【\[](待处理|已完结)[】\]](?:物流在途)?消费者要求改地址(?:平台受理)?/u);
  return match ? match[1] : null;
};
const inTransitOrderState = (facts = {}) => {
  const text = normalized(facts.bodyText || facts.pageText || '');
  const orderDetail = normalized(facts.orderDetailText || text);
  const logisticsText = normalized(
    facts.logisticsText
      || (text.split('物流轨迹')[1] || '')
      || '',
  );
  const orderNumber = String(facts.orderNumber || '').trim();
  // Nested PDD cards can repeat the same rendered order number.  Identity is
  // ambiguous only when distinct numbers are present, not when one number is
  // duplicated by ancestor/child text nodes.
  const displayedOrder = [...new Set(
    [...orderDetail.matchAll(/订单(?:编号|号)\s*[:：]?\s*(\d{6}-\d{8,20})/gu)]
      .map((entry) => entry[1]),
  )];
  const orderMatches = displayedOrder.length === 1 && displayedOrder[0] === orderNumber;
  const shipped = /(?:已发货\s*[，,]?\s*待签收|已发货\s*[，,]?\s*待收货|已发货|待收货|运输中|派送中)/u.test(orderDetail)
    && !/(?:待发货|未发货|交易关闭|已退款|已签收|已完成)/u.test(orderDetail);
  const trackingFromText = /(?:物流公司|快递公司|承运商|快递)\s*[:：]?\s*[^\s，,；;]{2,}/u.test(logisticsText)
    && /(?:运单号|物流单号|快递单号|单号)\s*[:：]?\s*\d{8,20}/u.test(logisticsText);
  const trackingFromFacts = Boolean(
    String(facts.logisticsAnalysis?.carrier || facts.carrier || '').trim()
      && String(facts.logisticsAnalysis?.trackingNumber || '').match(/\d{8,20}/u),
  );
  const hasTracking = trackingFromText || trackingFromFacts
    || (Array.isArray(facts.logisticsTimeline) && facts.logisticsTimeline.some((node) => (
      /\d{8,20}/u.test(String(node?.trackingNumber || node?.waybillNumber || node?.text || ''))
    )));
  const noAftersale = /售后信息\s*暂无售后信息/u.test(text)
    || /暂无售后信息/u.test(orderDetail);
  const stage1Record = /尝试联系物流修改收件地址/u.test(text)
    && /(?:处理方式|选择处理方式)\s*[:：]?\s*(?:联系物流协商修改地址|尝试联系物流修改收件地址)/u.test(text)
    && hasMessage(text, 'contact');
  const stage2Record = /(?:已联系快递公司修改|已联系快递修改)/u.test(text)
    && /(?:回填处理结果|处理结果)\s*[:：]?\s*已联系快递公司修改/u.test(text)
    && hasMessage(text, 'result')
    && /(?:上传凭证|凭证|留言状态\s*[:：]?\s*已留言)/u.test(text);
  const stage1Form = /物流在途消费者要求改地址/u.test(text)
    && /联系物流协商修改地址/u.test(text)
    && /(?:消费者要求修改收件地址|协助消费者联系物流修改)/u.test(text);
  const stage2Form = /(?:已联系快递公司修改|已联系快递修改)/u.test(text)
    && /(?:回填处理结果|请按照真实情况填写)/u.test(text);
  const completedTitle = titleState(text) === '已完结';
  const noForm = !/(?:选择处理方式|回填处理结果|发送话术|上传图片|请按照真实情况填写)/u.test(
    text.split('服务进度')[0] || text,
  );
  return {
    text, orderDetail, logisticsText, titleStatus: titleState(text), orderMatches,
    shipped, hasTracking, noAftersale, stage1Record, stage2Record,
    stage1Form, stage2Form, completedTitle, noForm,
    complete: completedTitle && noForm && stage1Record && stage2Record && orderMatches,
  };
};

const chatAddressFacts = (chat = {}) => {
  const analysis = chat.analysis && typeof chat.analysis === 'object' ? chat.analysis : {};
  const facts = analysis.facts && typeof analysis.facts === 'object' ? analysis.facts : {};
  const address = String(
    facts.newAddress || facts.newDetailedAddress || analysis.newAddress || analysis.newDetailedAddress || '',
  ).replace(/\s+/gu, ' ').trim();
  const recipientName = String(
    facts.recipientName || facts.newRecipientName || analysis.recipientName || analysis.newRecipientName || '',
  ).replace(/\s+/gu, ' ').trim();
  const recipientPhone = String(
    facts.recipientPhone || facts.newRecipientPhone || facts.phone || analysis.recipientPhone || analysis.newRecipientPhone || '',
  ).replace(/[\s-]/gu, '').trim();
  const completeFlag = facts.newAddressComplete === true
    || facts.completeNewAddress === true
    || analysis.newAddressComplete === true;
  const complete = completeFlag
    && address.length >= 6
    && recipientName.length >= 2
    && /\d{7,20}/u.test(recipientPhone);
  return { address, recipientName, recipientPhone, complete };
};

export const parseInTransitAddressChangeState = (facts = {}) => {
  const state = inTransitOrderState(facts);
  const chat = chatAddressFacts(facts.chatAnalysis || {});
  const completedPddStages = new Set((facts.completedPddStages || []).map((value) => String(value || '').trim()));
  const stage1Done = state.stage1Record || completedPddStages.has(IN_TRANSIT_ADDRESS_CHANGE_STAGE_CODES.contact);
  const stage2Done = state.stage2Record || completedPddStages.has(IN_TRANSIT_ADDRESS_CHANGE_STAGE_CODES.result);
  return {
    ...state, chat, stage1Done, stage2Done,
    stage: state.complete || stage2Done ? 'completed'
      : stage1Done ? 'result' : 'contact',
  };
};

export const evaluateInTransitAddressChange = (facts = {}) => {
  const state = parseInTransitAddressChangeState(facts);
  const base = {
    scenarioCode: IN_TRANSIT_ADDRESS_CHANGE_CODE,
    requiredSystems: ['PDD', 'OMS', 'TMS'],
    nextAttemptAt: null, retryAfterAt: null, external: null,
    evidence: { addressChange: state, chatAnalysis: facts.chatAnalysis || null },
  };
  if (!state.orderMatches || !state.titleStatus) {
    return manual(base, 'in-transit-address-change-identity', '在途改地址工单类型或订单编号不明确，禁止提交');
  }
  if (!state.shipped || !state.hasTracking || !state.noAftersale) {
    return manual(base, 'in-transit-address-change-unsupported-shipping-state',
      '目前只支持已发货待签收、存在快递公司和运单号且暂无售后信息的在途改地址工单');
  }
  const chat = facts.chatAnalysis || {};
  if (chat.status === 'pending' || chat.status === 'collecting') {
    return external(base, {
      actionCode: 'in-transit-address-change-chat-analysis-required',
      reasonCode: 'in-transit-address-change-chat-analysis-pending',
      reason: '先按订单号查询多多客服聊天记录，提取消费者完整新地址、收件人和联系电话',
    });
  }
  if (chat.status !== 'analyzed' || chat.eligible !== true || chat.conclusion !== 'consumer-new-address-complete') {
    return manual(base, 'in-transit-address-change-chat-not-eligible',
      '聊天记录未确认消费者提供完整新地址、收件人和联系电话，转人工核对');
  }
  if (!state.chat.complete) {
    return manual(base, 'in-transit-address-change-new-address-incomplete',
      '消费者未提供可核验的完整新地址、收件人和联系电话，不能自动联系物流');
  }
  if (state.stage === 'completed') {
    return completed(base, {
      reasonCode: 'in-transit-address-change-completed',
      reason: '在途改地址已完成两阶段处理并显示完结记录',
      pdd: { option: '已联系快递公司修改' },
    });
  }
  if (!state.stage1Done && facts.omsTmsFlowCompleted !== true) {
    return external(base, {
      actionCode: 'in-transit-address-change-oms-tms-flow',
      reasonCode: 'in-transit-address-change-common-flow-required',
      reason: '先按公共 TMS 流程登记物流问题“改地址”和客服备注“客户申请改地址”',
      external: { action: 'execute-in-transit-address-change-oms-tms-flow', system: 'TMS' },
    });
  }
  if (state.stage1Done && facts.omsTmsFlowCompleted !== true) {
    return manual(base, 'in-transit-address-change-tms-missing',
      '在途改地址第一阶段已有平台记录，但未确认对应 TMS 公共流程，禁止补建或重复操作');
  }
  if (!state.stage1Done) {
    return stageSubmit(base, {
      reasonCode: 'in-transit-address-change-contact-logistics-ready',
      reason: '已核验消费者完整新地址并完成 TMS 登记，联系物流协商修改地址',
      pdd: {
        stageCode: IN_TRANSIT_ADDRESS_CHANGE_STAGE_CODES.contact,
        option: '联系物流协商修改地址',
        optionAliases: ['尝试联系物流修改收件地址'],
        strictOptionSelection: true,
        generatedMessageRequired: true,
        generatedMessageMustInclude: [IN_TRANSIT_ADDRESS_CHANGE_MESSAGES.contact],
        generatedMessageAcceptedVariants: [...IN_TRANSIT_ADDRESS_CHANGE_MESSAGE_VARIANTS.contact],
        expectedGeneratedMessage: IN_TRANSIT_ADDRESS_CHANGE_MESSAGES.contact,
      },
    });
  }
  if (!state.stage2Done) {
    return stageSubmit(base, {
      reasonCode: 'in-transit-address-change-result-ready',
      reason: '已联系物流，回填已联系快递公司修改并上传 TMS 凭证',
      pdd: {
        stageCode: IN_TRANSIT_ADDRESS_CHANGE_STAGE_CODES.result,
        option: '已联系快递公司修改',
        optionAliases: ['已联系快递修改'],
        strictOptionSelection: true,
        generatedMessageRequired: true,
        generatedMessageMustInclude: [IN_TRANSIT_ADDRESS_CHANGE_MESSAGES.result],
        generatedMessageAcceptedVariants: [...IN_TRANSIT_ADDRESS_CHANGE_MESSAGE_VARIANTS.result],
        expectedGeneratedMessage: IN_TRANSIT_ADDRESS_CHANGE_MESSAGES.result,
      },
      evidence: {
        addressChange: state,
        chatAnalysis: chat,
        required: [{ source: 'tms-address-change-evidence', required: true,
          mustInclude: ['order-number', 'tracking-number', 'address-change'] }],
      },
    });
  }
  return manual(base, 'in-transit-address-change-completion-unconfirmed',
    '在途改地址第二阶段已有提交迹象，但平台尚未显示完整完结状态，转只读复核');
};

export const acceptedInTransitAddressChangeMessage = (value, stage) => acceptedMessage(value, stage);

