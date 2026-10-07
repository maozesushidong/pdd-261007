import assert from 'node:assert/strict';
import {
  canRebindToVisibleTmsTicket,
  findTmsTicketRecord,
  hasConflictingTmsTicketIdentity,
} from '../packages/adapters/src/tms/ticket-record.mjs';

const orderNumber = '260817-363457420852373';
const payload = {
  data: {
    records: [
      { ticketId: 32743, ticketNo: 'L00032666', tradeNo: orderNumber },
      { ticketId: 32534, ticketNo: 'L00032457', tradeNo: orderNumber },
    ],
  },
};

assert.equal(findTmsTicketRecord(payload, orderNumber)?.ticketNo, 'L00032666');
assert.deepEqual(
  findTmsTicketRecord(payload, orderNumber, { ticketNo: 'L00032457' }),
  payload.data.records[1],
);
assert.equal(findTmsTicketRecord(payload, orderNumber, { ticketNo: 'L00039999' }), null);

let deeplyNestedRecord = {
  ticketId: 40001,
  ticketNo: 'L00040001',
  tradeNo: orderNumber,
};
for (let depth = 0; depth < 20_000; depth++) deeplyNestedRecord = { child: deeplyNestedRecord };
assert.equal(
  findTmsTicketRecord({ data: deeplyNestedRecord }, orderNumber)?.ticketNo,
  'L00040001',
  'deep TMS API payloads must not overflow the JavaScript call stack',
);

let deeplyNestedTicketIdentity = { ticketNo: 'L00040002' };
for (let depth = 0; depth < 20_000; depth++) {
  deeplyNestedTicketIdentity = { child: deeplyNestedTicketIdentity };
}
const deepIdentityRecord = {
  tradeNo: orderNumber,
  details: deeplyNestedTicketIdentity,
};
assert.equal(
  findTmsTicketRecord({ data: [deepIdentityRecord] }, orderNumber, { ticketNo: 'L00040002' }),
  deepIdentityRecord,
  'deep ticket identity lookup must be iterative',
);
const cyclicPayload = { data: [] };
cyclicPayload.data.push(cyclicPayload, { ticketId: 40003, ticketNo: 'L00040003', tradeNo: orderNumber });
assert.equal(
  findTmsTicketRecord(cyclicPayload, orderNumber)?.ticketNo,
  'L00040003',
  'cyclic payloads must be traversed once',
);
assert.equal(canRebindToVisibleTmsTicket({
  existingStatus: 'matched',
  candidateCount: 1,
  selectionStrategy: 'only-row',
  savedTicketId: '32372',
  savedTicketNo: 'L00032503',
  visibleTicketId: '32533',
  visibleTicketNo: 'L00032664',
}), true);
assert.equal(canRebindToVisibleTmsTicket({
  existingStatus: 'matched',
  candidateCount: 2,
  selectionStrategy: 'saved-ticket-identifier',
  savedTicketId: '32372',
  savedTicketNo: 'L00032503',
  visibleTicketId: '32533',
  visibleTicketNo: 'L00032664',
}), false);

assert.equal(hasConflictingTmsTicketIdentity({
  savedTicketId: '39820',
  savedTicketNo: 'L00039737',
  visibleTicketId: 'L00039737',
  visibleTicketNo: 'L00039737',
}), false, 'a matching visible ticket number must outrank an unavailable internal numeric id');
assert.equal(hasConflictingTmsTicketIdentity({
  savedTicketId: '39820',
  savedTicketNo: 'L00039737',
  visibleTicketId: '39820',
  visibleTicketNo: 'L00039738',
}), true, 'different visible ticket numbers must remain a hard identity conflict');
assert.equal(hasConflictingTmsTicketIdentity({
  savedTicketId: '39820',
  visibleTicketId: '39821',
}), true, 'internal ids remain authoritative when neither ticket number is available');

console.log('TMS ticket-record self-test passed.');
