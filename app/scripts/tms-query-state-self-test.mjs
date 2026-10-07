import assert from 'node:assert/strict';
import {classifyTmsOmsQueryHttpStatus,isTransientTmsOmsQueryMessage} from '../packages/adapters/src/tms/query-state.mjs';
for(const message of ['Failed to fetch','TypeError: Failed to fetch','NetworkError when attempting to fetch resource.','正在查询，请稍候','502 Bad Gateway']){
 assert.equal(isTransientTmsOmsQueryMessage(message),true,message);
}
for(const message of ['未找到订单','查询到 2 个订单，请选择对应订单','无权限访问','401 Unauthorized','403 Forbidden','订单信息不匹配','Failed to fetch. 订单不存在','']){
 assert.equal(isTransientTmsOmsQueryMessage(message),false,message);
}
for(const status of [401,403])assert.equal(classifyTmsOmsQueryHttpStatus(status),'authorization-recovery');
for(const status of [408,425,429,500,502,503,504])assert.equal(classifyTmsOmsQueryHttpStatus(status),'transient-retry');
for(const status of [200,400,404,409])assert.equal(classifyTmsOmsQueryHttpStatus(status),'terminal');
console.log('TMS read-only query network retry classification self-test passed');
