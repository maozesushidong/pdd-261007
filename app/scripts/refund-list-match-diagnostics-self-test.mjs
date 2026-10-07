import assert from 'node:assert/strict';
import { describeReturnRefundListResponseMatch, matchReturnRefundListResponseToActions,
} from '../packages/adapters/src/pdd/return-refund.mjs';
const orders = ['260929-111111111111111', '260929-222222222222222'];
const rows = orders.map((orderNumber) => ({ orderNumber, source: 'list-row-or-detail-link' }));
const response = orders.map((orderSn, index) => ({ orderSn, id: `2311111111111${index}` }));
const equal = describeReturnRefundListResponseMatch(rows, response);
assert.deepEqual(equal.responseIndexByAction, [0, 1]);
assert.equal(equal.missingActionOrders, 0);
assert.equal(equal.invalidResponseRows, 0);
assert.deepEqual(describeReturnRefundListResponseMatch([...rows].reverse(), response).responseIndexByAction, [1, 0]);
assert.equal(matchReturnRefundListResponseToActions([...rows].reverse(), response), null,
  'diagnostics must not relax the existing order-sensitive matching policy');
const hidden = describeReturnRefundListResponseMatch([rows[0], { source: 'hidden-action' }], response);
assert.equal(hidden.missingActionOrders, 1);
assert.equal(hidden.sources['hidden-action'], 1);
assert.deepEqual(hidden.responseIndexByAction, [0, -1]);
assert.equal(describeReturnRefundListResponseMatch(null, response).attempted, false);
const duplicates = describeReturnRefundListResponseMatch([rows[0], rows[0]], [response[0], response[0]]);
assert.equal(duplicates.duplicateActionOrders, 1);
assert.equal(duplicates.duplicateResponseOrders, 1);
assert.deepEqual(duplicates.responseIndexByAction, [-2, -2]);
assert.equal(describeReturnRefundListResponseMatch(rows, [{ ...response[0], id: 'invalid' }]).invalidResponseRows, 1);
const untrustedSource = describeReturnRefundListResponseMatch([{ ...rows[0], source: 'private customer info' }], response);
assert.equal(untrustedSource.sources.other, 1);
for (const result of [equal, hidden, duplicates, untrustedSource]) {
  for (const secret of [...orders, ...response.map((item) => item.id), 'private customer info']) {
    assert(!JSON.stringify(result).includes(secret), 'diagnostics must contain only positions and counts');
  }
}
console.log('Refund list match diagnostics passed (order, hidden rows, duplicates, absent lookup, invalid IDs, privacy)');
