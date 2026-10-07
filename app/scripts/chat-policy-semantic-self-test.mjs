import assert from 'node:assert/strict';
import fs from 'node:fs';
const file = process.env.CHAT_RULES_SOURCE_FILE || 'packages/adapters/src/chat-analysis/rules.mjs';
const source = fs.readFileSync(file, 'utf8');
const { evaluateChatPolicy, shortagePolicy, analysisKey, digest } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const snapshot = { shopId: 'test-shop', orderNumber: '260913-123456789012345', contentHash: 'test-only',
  orderFacts: { orderNumber: '260913-123456789012345', orderDetailText: '腰带主体和固定带，各一件' },
  completeness: { complete: true, issues: [] }, messages: [
    { id: 'buyer1', role: 'buyer', text: '收到没有外面固定的带呢', attachments: [{ id: 'photo1', status: 'ready' }] },
    { id: 'seller1', role: 'seller', text: '我们核对了您的规格，该规格包括固定带，这次确实漏放了', attachments: [] },
  ] };
const analysis = { conclusion: 'shortage', summary: '买家所购规格应配固定带，聊天及图片支持缺件',
  facts: { shortageDescription: '缺少外部固定带' }, evidence: [{ messageId: 'buyer1', quote: '收到没有外面固定的带呢' },
    { messageId: 'seller1', quote: '这次确实漏放了' }], conflicts: [], missing: [] };
const evaluate = (a = analysis, s = snapshot) => evaluateChatPolicy({ snapshot: s, analysis: a, policy: shortagePolicy });
assert.equal(evaluate().eligible, true, 'CHAT_SEMANTIC_CLAIM_REJECTED_BY_KEYWORD_GATE');
assert.equal(evaluate().action, 'pdd-real-shortage-flow');
assert.equal(evaluate().validationVersion, 2);
assert(evaluate({ ...analysis, evidence: [{ messageId: 'buyer1', attachmentId: 'photo1' }] }).eligible,
  'Buyer image evidence does not require a literal shortage keyword');
assert(!evaluate({ ...analysis, conflicts: ['买家后续又说找到了固定带'] }).eligible);
assert(!evaluate({ ...analysis, missing: ['该订单的实际购买规格无法核实'] }).eligible);
assert(!evaluate({ ...analysis, evidence: [{ messageId: 'seller1', quote: '这次确实漏放了' }] }).eligible);
assert(!evaluate({ ...analysis, evidence: [{ messageId: 'invented', quote: '缺了一件' }] }).eligible);
assert(!evaluate({ ...analysis, evidence: [{ messageId: 'buyer1', quote: '未出现在原文中的说法' }] }).eligible);
assert(!evaluate({ ...analysis, evidence: [{ messageId: 'buyer1', attachmentId: 'missing-photo' }] }).eligible);
assert(!evaluate(analysis, { ...snapshot, completeness: { complete: false, issues: ['还有分页未读取'] } }).eligible);
assert(!evaluate(analysis, { ...snapshot, messages: [] }).eligible);
assert(!evaluate(analysis, { ...snapshot, messages: snapshot.messages.map(m => ({ ...m, otherOrder: true })) }).eligible);
assert(!evaluate({ ...analysis, conclusion: 'unknown' }).eligible);
const noShortage = evaluate({ ...analysis, conclusion: 'no-shortage', summary: '综合规格和后续更正确认数量一致' });
assert.equal(noShortage.action, 'pdd-no-shortage-feedback');
const config = { snapshot, policy: shortagePolicy, model: 'deepseek-flash', baseUrl: 'https://model.test/v1' };
const oldKey = digest({ shopId: snapshot.shopId, orderNumber: snapshot.orderNumber, snapshotHash: snapshot.contentHash,
  facts: snapshot.orderFacts, rule: shortagePolicy, model: config.model, baseUrl: config.baseUrl, analyzerVersion: 1 });
assert.notEqual(analysisKey(config), oldKey, 'Validator fix must invalidate the previous cached result key');
console.log('CHAT_POLICY_SEMANTIC_SELF_TEST_OK');
