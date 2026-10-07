// The first supported address-change case is explicitly unshipped, without outbound logistics.
export const CONSUMER_ADDRESS_CHANGE_CODE = 'consumer-address-change';
export const ADDRESS_CHANGE_MESSAGES = Object.freeze({
  reject: '亲亲，因为包裹已打包完成，暂时无法同意您的改地址申请',
  negotiate: '亲亲，您可以退款后使用新地址重新下单哦',
});
// PDD has returned this exact stage-2 platform-generated variant in production.
// Keep the canonical text above for policy/evidence, but accept only this known
// platform variant; never rewrite the textarea or accept arbitrary text.
export const ADDRESS_CHANGE_MESSAGE_VARIANTS = Object.freeze({
  reject: Object.freeze([ADDRESS_CHANGE_MESSAGES.reject]),
  negotiate: Object.freeze([
    ADDRESS_CHANGE_MESSAGES.negotiate,
    '亲亲，您可以退款后使用新重新地址下单哦',
  ]),
});
const compact = (value) => String(value || '').normalize('NFKC').replace(/\s+/gu, '').trim();
const hasAddressChangeMessage = (value, stage) => ADDRESS_CHANGE_MESSAGE_VARIANTS[stage]
  .some((message) => compact(value).includes(`发送话术:${compact(message)}`)
    || compact(value) === compact(message));
const acceptedAddressChangeMessage = (value, stage) => ADDRESS_CHANGE_MESSAGE_VARIANTS[stage]
  .some((message) => compact(value) === compact(message));
const stageLabels = Object.freeze({
  reject: { option: '不同意修改地址', reasonOption: '包裹已打包完成' },
  negotiate: { option: '协商退款重拍' },
});

export class ConsumerAddressChangeReviewError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = 'ConsumerAddressChangeReviewError';
    this.code = 'PDD_CONSUMER_ADDRESS_CHANGE_REVIEW';
    this.reasonCode = reasonCode;
  }
}
const review = (code, message) => { throw new ConsumerAddressChangeReviewError(code, message); };

export const parseConsumerAddressChangeState = (snapshot = {}, expectedOrderNumber) => {
  const text = compact(snapshot.text);
  const title = text.match(/[【\[](?:待处理|已完结)[】\]]消费者申请修改地址/gu) || [];
  const titleStatus = title.length === 1
    ? title[0].match(/待处理|已完结/u)?.[0] : null;
  const topRegion = text.split('服务进度')[0] || text;
  const unshippedBadge = /订单未发货/u.test(topRegion);
  const orderInfo = text.split('订单信息')[1]?.split(/售后信息|收货信息|物流轨迹/u)[0] || '';
  const orderNumbers = [...orderInfo.matchAll(/订单(?:编号|号)[:：]?(\d{6}-\d{8,20})/gu)]
    .map((match) => match[1]);
  const orderMatches = orderNumbers.length === 1 && orderNumbers[0] === expectedOrderNumber;
  const history = text.split('服务进度')[1]?.split('订单信息')[0] || '';
  const form = text.split('服务进度')[0].split('订单信息')[0];
  const noAftersale = /售后信息(?:暂无售后信息)/u.test(text);
  const logistics = text.split('物流轨迹')[1] || '';
  // Some PDD layouts omit the separate “订单未发货” badge while the order
  // facts and logistics card still unambiguously show the same state.
  // Keep the badge as evidence when present, but do not require it.
  const unshipped = /待发货/u.test(orderInfo)
    && !/已发货|已签收|已完成|交易关闭|已退款|待收货/u.test(orderInfo)
    && /暂无发货物流/u.test(logistics)
    && !/(?:物流公司|快递公司|运单号|物流单号|快递单号)[:：]?[^:：]{2,}/u.test(logistics);
  const rejectionRecord = history.split('拒绝消费者改地址申请').slice(1).join('拒绝消费者改地址申请')
    .split(/客服已给出处理方案|消费者申请修改地址/u)[0] || '';
  const negotiationRecord = history.split('客服已给出处理方案')[1]
    ?.split(/拒绝消费者改地址申请|消费者申请修改地址/u)[0] || '';
  const rejectionProof = /处理方案[:：]不同意修改地址/u.test(rejectionRecord)
    && /不同意(?:修改|改)地址原因[:：]包裹已打包完成/u.test(rejectionRecord)
    && hasAddressChangeMessage(rejectionRecord, 'reject');
  const negotiationProof = /具体方案[:：]协商退款重拍/u.test(negotiationRecord)
    && hasAddressChangeMessage(negotiationRecord, 'negotiate');
  const creationProof = /消费者申请修改地址/u.test(history);
  const hasSubmit = snapshot.submitCount === 1;
  const noForm = snapshot.submitCount === 0 && (snapshot.messages || []).length === 0
    && !/处理方案|具体方案|发送话术/u.test(form.replace(/^.*?消费者申请修改地址/u, ''));
  const rejectStage = titleStatus === '待处理' && hasSubmit
    && /请尽快审核消费者的改地址申请/u.test(form)
    && /同意修改地址申请|不同意修改地址/u.test(form);
  const negotiateStage = titleStatus === '待处理' && hasSubmit
    && /请和消费者协商解决改地址问题/u.test(form)
    && /您已拒绝消费者改地址申请/u.test(form)
    && /协商退款重拍/u.test(form);
  const complete = titleStatus === '已完结' && noForm
    && rejectionProof && negotiationProof && creationProof && orderMatches;
  return {
    orderMatches, titleStatus, unshippedBadge, unshipped, noAftersale,
    rejectionProof, negotiationProof, creationProof, noForm, complete,
    stage: complete ? 'completed' : rejectStage && !negotiateStage ? 'reject'
      : negotiateStage && !rejectStage ? 'negotiate' : 'unknown',
    messages: (snapshot.messages || []).map(compact),
  };
};

export const evaluateConsumerAddressChange = (facts = {}) => {
  const state = facts.consumerAddressChangeState
    || parseConsumerAddressChangeState(facts, facts.orderNumber);
  const base = { scenarioCode: CONSUMER_ADDRESS_CHANGE_CODE, requiredSystems: ['PDD'],
    nextAttemptAt: null, retryAfterAt: null, external: null, evidence: { addressChange: state } };
  const manual = (reasonCode, reason) => ({ ...base, outcome: 'manual-review',
    actionCode: 'manual-review', reasonCode, reason, pdd: null });
  if (!state.orderMatches || !state.titleStatus) {
    return manual('address-change-identity', '改地址工单类型或订单编号不明确，禁止提交');
  }
  if (state.complete) return { ...base, outcome: 'completed', actionCode: 'pdd-complete',
    reasonCode: 'address-change-completed', reason: '工单已完结且两次方案和话术均已核实',
    pdd: { option: '协商退款重拍' } };
  // The badge is optional in current PDD layouts. The order card and
  // logistics facts are the authoritative unshipped evidence.
  if (!state.unshipped || !state.noAftersale) {
    return manual('address-change-unsupported-shipping-state',
      '目前只支持待发货、暂无发货物流且暂无售后信息的改地址工单，其余情况交人工');
  }
  if (state.stage === 'reject' && (state.rejectionProof || state.negotiationProof)) {
    return manual('address-change-stale-stage', '已存在处理记录，但页面仍显示审核申请，禁止重复发送');
  }
  if (state.stage === 'negotiate' && (!state.rejectionProof || state.negotiationProof)) {
    return manual('address-change-unverified-rejection', '未核实本流程的拒绝原因和话术，或已存在协商记录，禁止重复提交');
  }
  if (!stageLabels[state.stage]) {
    return manual('address-change-stage-unknown', '改地址页面阶段或完结记录不完整，需要人工核对');
  }
  return { ...base, outcome: 'auto-submit', actionCode: 'pdd-stage-submit',
    reasonCode: `address-change-${state.stage}`, reason: state.stage === 'reject'
      ? '未发货：不同意修改地址，原因包裹已打包完成' : '未发货：协商退款重拍',
    pdd: { stageCode: state.stage, ...stageLabels[state.stage], strictOptionSelection: true,
      generatedMessageRequired: true,
      generatedMessageMustInclude: [ADDRESS_CHANGE_MESSAGES[state.stage]],
      generatedMessageAcceptedVariants: [...ADDRESS_CHANGE_MESSAGE_VARIANTS[state.stage]],
      expectedGeneratedMessage: ADDRESS_CHANGE_MESSAGES[state.stage] } };
};

// Read only the detail card. Floating overdue reminders must never supply its status or history.
export const readConsumerAddressChangeSnapshot = async (page) => {
  const snapshots = [];
  for (const frame of page.frames()) {
    const snapshot = await frame.evaluate(() => {
      const visible = (element) => !!(element && element.getClientRects().length
        && getComputedStyle(element).visibility !== 'hidden'
        && getComputedStyle(element).display !== 'none');
      const textOf = (element) => String(element.innerText || '').normalize('NFKC').replace(/\s+/gu, '');
      const titlePattern = /[【\[](?:待处理|已完结)[】\]]消费者申请修改地址/u;
      const headings = [...document.querySelectorAll('div,span,h1,h2,h3,p')]
        .filter((element) => visible(element) && titlePattern.test(textOf(element))
          && ![...element.children].some((child) => titlePattern.test(textOf(child))));
      const roots = new Set();
      for (const heading of headings) {
        let root = heading;
        while (root && root !== document.body) {
          const text = textOf(root);
          if (text.includes('订单信息') && text.includes('服务进度') && text.includes('物流轨迹')) {
            roots.add(root); break;
          }
          root = root.parentElement;
        }
      }
      if (roots.size !== 1) return null;
      const root = [...roots][0];
      const submits = [...root.querySelectorAll('button,[role="button"]')]
        .filter((el) => visible(el) && /^提交$/u.test(textOf(el)));
      const messages = [...root.querySelectorAll('textarea,[contenteditable="true"]')]
        .filter(visible).map((el) => el.value ?? el.innerText ?? '');
      return { text: root.innerText, submitCount: submits.length, messages };
    }).catch(() => null);
    if (snapshot) snapshots.push(snapshot);
  }
  return snapshots.length === 1 ? snapshots[0] : { text: '', submitCount: 0, messages: [] };
};

// All writes remain inside the existing per-case external-effect reservation.
export const runConsumerAddressChange = async (runtime) => {
  const { orderNumber, read, guard, apply, submit, assertIdentity,
    record = () => {}, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(), timeoutMs = 30_000 } = runtime;
  let submittedAny = false;
  const readState = async () => {
    await assertIdentity();
    return parseConsumerAddressChangeState(await read(), orderNumber);
  };
  const getDecision = (state) => evaluateConsumerAddressChange({ consumerAddressChangeState: state });
  const assertStage = async (stage, requireMessage = false) => {
    const state = await readState();
    const decision = getDecision(state);
    if (decision.outcome !== 'auto-submit' || state.stage !== stage) {
      review(decision.reasonCode, `改地址提交前状态核对失败：${decision.reason}`);
    }
    if (requireMessage && (state.messages.length !== 1
      || !acceptedAddressChangeMessage(state.messages[0], stage))) {
      review('address-change-message-mismatch', '平台自动话术与约定内容不一致或尚未生成，禁止改写及提交');
    }
    return state;
  };
  const reached = (state, stage) => stage === 'reject'
    ? state.orderMatches && state.rejectionProof
      && (state.stage === 'negotiate' || state.complete)
    : state.complete;
  const awaitState = async (predicate) => {
    const deadline = now() + timeoutMs;
    do {
      const state = await readState();
      if (predicate(state)) return state;
      if (now() >= deadline) return state;
      await wait(Math.min(250, Math.max(1, deadline - now())));
    } while (true);
  };
  let state = await awaitState((value) => value.orderMatches && value.titleStatus
    && value.stage !== 'unknown');
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const decision = getDecision(state);
    record({ decision, state, submittedAny });
    if (decision.outcome === 'completed') {
      return { ...state, isCompleted: true, recoveredFromCompletedPage: !submittedAny,
        completedOutcome: '协商退款重拍',
        completedServiceEvidence: '不同意修改地址：包裹已打包完成；协商退款重拍',
        completedResultOption: '协商退款重拍',
        confirmationMethod: 'address-change-completed-with-both-service-records', decision };
    }
    if (decision.outcome !== 'auto-submit') review(decision.reasonCode, decision.reason);
    const stage = state.stage;
    const effectStage = `ordinary-${CONSUMER_ADDRESS_CHANGE_CODE}-${stage}-v1`;
    const result = await guard(effectStage, async () => {
      let clickAttempted = false;
      try {
        await assertStage(stage);
        await apply(decision);
        await assertStage(stage, true);
        const receipt = await submit({ decision, effectStage,
          beforeClick: async () => {
            await assertStage(stage, true);
            clickAttempted = true;
            record({ decision, effectStage, clickAttempted: true });
          },
          settleUntil: async () => reached(await readState(), stage),
        });
        state = await awaitState((value) => reached(value, stage));
        if (!reached(state, stage)) {
          review('address-change-submit-unconfirmed',
            '已点击提交但未确认本阶段处理记录，转人工核对，禁止重复发送话术');
        }
        submittedAny = true;
        record({ decision, effectStage, stageSucceeded: true, state });
        return { stage, transitionConfirmed: true, submitClicked: clickAttempted,
          submitReceipt: receipt?.submitReceipt || null };
      } catch (error) {
        error.externalEffectStatus = clickAttempted ? 'unknown' : 'failed';
        error.externalEffectReceipt = { clickAttempted, stage, reasonCode: error.reasonCode || null };
        throw error;
      }
    });
    state = await awaitState((value) => reached(value, stage));
    if (!reached(state, stage)) {
      review('address-change-receipt-page-mismatch',
        '已有提交记录，但页面尚未显示对应服务进度，禁止重复发送话术');
    }
    record({ decision, effectStage, stageSucceeded: true, state,
      alreadySucceeded: result?.alreadySucceeded === true });
  }
  review('address-change-stage-limit', '改地址流程未确认完结，停止后续提交');
};
