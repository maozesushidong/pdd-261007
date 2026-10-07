import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Run against the actual deployed or staged adapter, including its exports.
const file = process.env.ORDINARY_ADAPTER_SOURCE_FILE
  || path.resolve('packages/adapters/src/pdd/ordinary-work-orders.mjs');
const source = fs.readFileSync(file, 'utf8').replace(
  /from\s+(['"])(\.[^'"]+)\1/gu,
  (_, quote, specifier) => `from ${JSON.stringify(pathToFileURL(
    path.resolve(path.dirname(file), specifier),
  ).href)}`,
);
const { evaluateProductShortage } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const now = new Date('2026-09-18T00:00:00Z');
const complete = { complete: true, issues: [], covered: [{ from: '2026-09-01', to: '2026-09-18' }] };
const analyzed = (conclusion = 'no-shortage') => ({
  status: 'analyzed', conclusion, eligible: true, completeness: complete,
  messages: [{ id: 'm1', role: 'buyer', text: '订了四盒，打开只有三盒' }],
  analysis: { conclusion, summary: '结合购买规格和买家说明判断',
    facts: { shortageDescription: '订了四盒，打开只有三盒' }, conflicts: [], missing: [] },
});
const evaluate = (chat, facts = {}) => evaluateProductShortage({ ...facts, chatAnalysis: chat }, { now });
if (!process.argv.includes('--incomplete') && !process.argv.includes('--semantic')) {
  for (const pending of [{ status: 'pending' }, { status: 'pending', error: 'database unavailable' }]) {
    const result = evaluate(pending);
    assert.equal(result.actionCode, 'product-shortage-chat-analysis-required', 'CHAT_PENDING_MUST_NOT_SUBMIT');
    assert.equal(result.outcome, 'external-action');
    assert.deepEqual(result.requiredSystems, ['PDD']);
    assert.equal(result.pdd, null);
  }
}
if (!process.argv.includes('--pending') && !process.argv.includes('--semantic')) {
  for (const completeness of [null, { complete: false, issues: ['locator.fill timeout'], covered: [] },
    { complete: true, issues: ['missing images'] }]) {
    const result = evaluate({ ...analyzed('unknown'), completeness, eligible: false,
      analysis: { summary: '没有可分析的聊天记录', conflicts: [], missing: ['聊天记录为空'] } });
    assert.equal(result.outcome, 'manual-review', 'CHAT_FAILED_COLLECTION_MUST_NOT_SUBMIT');
    assert.equal(result.reasonCode, 'product-shortage-chat-collection-incomplete');
  }
}
if (!process.argv.includes('--pending') && !process.argv.includes('--incomplete')) {
  const implicitShortage = evaluate(analyzed('shortage'));
  assert.equal(implicitShortage.pdd?.stageCode, 'verification-result', 'CHAT_MODEL_SEMANTICS_MUST_NOT_BE_REVERSED');
  const contradictoryWords = analyzed('shortage');
  contradictoryWords.messages.push({ id: 'm2', role: 'seller', text: '我们没有少发' });
  assert.equal(evaluate(contradictoryWords).pdd?.stageCode, 'verification-result');
  const unknown = { ...analyzed('unknown'), eligible: false,
    analysis: { summary: '未提到少发，但对话无法判断收货情况', conflicts: [], missing: ['数量无法核实'] } };
  assert.equal(evaluate(unknown).outcome, 'manual-review');
  const conflict = { ...analyzed(), analysis: { summary: '没有少发', conflicts: ['后续又反馈一盒不见了'] } };
  assert.equal(evaluate(conflict).reasonCode, 'product-shortage-chat-conflict');
  assert.equal(evaluate({ ...analyzed(), eligible: false }).outcome, 'manual-review');
  const noShortage = evaluate(analyzed());
  assert.equal(noShortage.pdd.feedbackProblemDescription, '买家订单商品数量正常，小店按消费者订单发出，未少发');
  const empty = { ...analyzed('unknown'), messages: [], eligible: false,
    analysis: { summary: '没有可分析的聊天记录', conflicts: [], missing: ['聊天记录为空'] } };
  assert.equal(evaluate(empty).reasonCode, 'product-shortage-chat-confirmed-empty-no-shortage');
  assert.equal(evaluate(empty).pdd.feedbackProblemDescription, noShortage.pdd.feedbackProblemDescription);
  const form = evaluate({ ...analyzed(), analysis: { ...analyzed().analysis, situationDescription: '买家核对规格后确认数量一致' } },
    { pddFeedbackEntryAvailable: false });
  assert.equal(form.pdd.option, '已核实，商品没有少发');
  assert.equal(form.pdd.secondaryOption, '商品件数未少发');
  assert.equal(form.pdd.situationDescription, '买家核对规格后确认数量一致');
  assert.equal(form.evidence.required[0].source, 'pdd-chat-evidence');
  const negotiation = evaluate(analyzed('shortage'), { completedPddStages: ['verification-result'], orderAmount: 100 });
  assert.equal(negotiation.pdd.solutionMessage, '抱歉亲亲，可能是仓库不小心弄错了，这边给您补偿30元或者换货可以吗');
  assert.equal(negotiation.pdd.waitAfterSubmitMs, 30 * 60_000);
}
console.log('PRODUCT_SHORTAGE_CHAT_DECISION_SELF_TEST_OK');
