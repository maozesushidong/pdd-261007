import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ORDINARY_SCENARIO_CODES, evaluateOrdinaryWorkOrderScenario } from '../packages/adapters/src/pdd/ordinary-work-orders.mjs';

const orderNumber = '260923-123456789012345';
const source = readFileSync(new URL('../workflow.mjs', import.meta.url), 'utf8');
const start = source.indexOf('const collectOrdinaryScenarioFacts =');
const end = source.indexOf('\nconst ordinaryFormScope =', start);
assert(start >= 0 && end > start);
const scenario = ORDINARY_SCENARIO_CODES.CONSUMER_ADDRESS_CHANGE_IN_TRANSIT;
let text = `【待处理】消费者要求改地址平台受理\n物流在途消费者要求改地址\n消费者要求修改收件地址\n尝试联系物流修改收件地址\n服务进度\n订单信息\n订单编号：${orderNumber}\n已发货，待签收\n售后信息\n暂无售后信息\n物流轨迹\n申通快递 777123456789012`;
let progress = {};
const context = vm.createContext({
  ORDINARY_SCENARIO_CODES, shopId:'test-shop', activeWorkOrderFirstDiscoveredAt:null,
  recordOrdinaryPlatformIdentity:()=>{}, openPddLogisticsKindWithRetry:async()=>{},
  parseShippingAnalysis:()=>({carrier:'申通快递',trackingNumber:'777123456789012'}),
  ordinaryTimelineFromAnalysis:()=>[],
  parsePddOrderNumber:value=>value.match(/订单编号：(\d{6}-\d{8,20})/u)?.[1],
  ordinaryExecutionFor:()=>({}), readProgress:()=>progress,
  chatPolicyForScenario:()=>true, readLatestChatAnalysis:async()=>null,
  extractOrdinaryWorkOrderTiming:()=>({}),
  updateOrdinaryExecution:(_order,_scenario,patch)=>patch,
  writeProgress:patch=>{progress={...progress,...patch}},
});
vm.runInContext(`${source.slice(start,end)};globalThis.collect=collectOrdinaryScenarioFacts;`,context);
const page = {url:()=> 'https://mms.pinduoduo.com/fixture',locator:()=>({innerText:async()=>text,count:async()=>0})};
const {facts} = await context.collect(page,orderNumber,scenario);
assert.equal(facts.orderNumber,orderNumber,'the collector must pass the verified order identity to the evaluator');
assert.equal(progress.ordinaryScenarioFacts.orderNumber,orderNumber,'persisted facts must retain that identity');
const decision=evaluateOrdinaryWorkOrderScenario(scenario,facts,{now:new Date()});
assert.equal(decision.reasonCode,'in-transit-address-change-chat-analysis-pending',
  'a valid identity must proceed to the existing chat-evidence check');
assert.equal(evaluateOrdinaryWorkOrderScenario(scenario,{...facts,orderNumber:'260923-999999999999999'}).reasonCode,
  'in-transit-address-change-identity','a real identity mismatch must remain blocked');
text=text.replace(orderNumber,'260923-999999999999999');
await assert.rejects(context.collect(page,orderNumber,scenario),/普通工单详情订单号不一致/u);
console.log('Ordinary facts identity boundary self-test passed');
