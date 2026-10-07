import assert from 'node:assert/strict';
import { normalizeOwnerDingTalkMessage } from '../apps/api/src/dingtalk-message.mjs';

assert.equal(normalizeOwnerDingTalkMessage(undefined).value, null);
const valid = normalizeOwnerDingTalkMessage({
  problemZh: ' 页面需要人工验证。 ',
  descriptionZh: '页面需要人工验证。\n程序停在验证阶段。',
  descriptionEn: 'The page requires verification. The automation stopped at human verification.',
});
assert.deepEqual(valid.value, {
  problemZh: '页面需要人工验证。',
  descriptionZh: '页面需要人工验证。 程序停在验证阶段。',
  descriptionEn: 'The page requires verification. The automation stopped at human verification.',
});
assert.match(normalizeOwnerDingTalkMessage({
  problemZh: '页面异常',
  descriptionZh: 'page.goto: Target page, context or browser has been closed',
  descriptionEn: 'Manual review required.',
}).error, /不能包含日志或错误堆栈/u);
assert.match(normalizeOwnerDingTalkMessage({
  problemZh: '', descriptionZh: '需要处理', descriptionEn: 'Manual review required.',
}).error, /不能为空/u);

console.log('owner DingTalk message validation self-test passed');
