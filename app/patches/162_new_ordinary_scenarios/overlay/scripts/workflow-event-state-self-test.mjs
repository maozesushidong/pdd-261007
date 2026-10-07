import assert from 'node:assert/strict';
import {
  workflowEventSemanticJson,
  workflowEventSeverity,
  workflowEventStateChanged,
} from '../packages/domain/src/workflow-event-state.mjs';

const idleScan = {
  shopId: 'shop-a',
  step: 'resident-discovery-starting',
  orderNumber: null,
  scenarioCode: null,
  error: null,
  manualReview: null,
  updatedAt: '2026-08-25T00:00:00.000Z',
  businessUpdatedAt: '2026-08-25T00:00:00.000Z',
  residentCommand: {
    requestId: 'request-1',
    action: 'discover',
    status: 'active',
    acceptedAt: '2026-08-25T00:00:00.000Z',
  },
  authHealth: {
    pdd: {
      status: 'authenticated',
      confidence: 'confirmed',
      checkedAt: '2026-08-25T00:00:00.000Z',
      url: 'https://mms.pinduoduo.com/aftersales/work_order/list',
    },
  },
  pddShopIdentity: {
    configured: '店铺A',
    actualShopName: '店铺A',
    mallId: 'mall-a',
    status: 'detected',
    profileFingerprint: 'profile-a',
    detectedAt: '2026-08-25T00:00:00.000Z',
    candidates: [{ value: '店铺A', context: 'header at first scan' }],
  },
  runtimeObservation: { observedAt: '2026-08-25T00:00:00.000Z' },
  systemTabs: { pdd: { url: 'https://mms.pinduoduo.com/aftersales/work_order/list' } },
};

const repeatedIdleScan = {
  ...idleScan,
  updatedAt: '2026-08-25T00:01:00.000Z',
  businessUpdatedAt: '2026-08-25T00:01:00.000Z',
  residentCommand: {
    requestId: 'request-2',
    action: 'discover',
    status: 'idle',
    outcome: 'idle',
    acceptedAt: '2026-08-25T00:01:00.000Z',
    completedAt: '2026-08-25T00:01:20.000Z',
  },
  authHealth: {
    pdd: {
      status: 'authenticated',
      confidence: 'confirmed',
      checkedAt: '2026-08-25T00:01:19.000Z',
      url: 'https://mms.pinduoduo.com/aftersales/work_order/list?refresh=2',
    },
  },
  pddShopIdentity: {
    ...idleScan.pddShopIdentity,
    detectedAt: '2026-08-25T00:01:18.000Z',
    candidates: [{ value: '店铺A', context: 'header at second scan' }],
  },
  runtimeObservation: { observedAt: '2026-08-25T00:01:19.000Z' },
  systemTabs: { pdd: { url: 'https://mms.pinduoduo.com/aftersales/work_order/list?refresh=2' } },
};

assert.equal(
  workflowEventSemanticJson(idleScan),
  workflowEventSemanticJson(repeatedIdleScan),
  'repeated semantically identical idle scans must deduplicate',
);
assert.equal(workflowEventStateChanged(idleScan, repeatedIdleScan), false);

const waitingVerification = {
  ...idleScan,
  step: 'human-verification-required',
  verificationLocation: {
    system: 'pdd',
    stage: 'return-refund-detail-load-initial',
    status: 'waiting-human',
    kind: 'slider',
    url: 'https://mms.pinduoduo.com/aftersales-ssr/detail?id=1',
  },
  verificationFocus: {
    stage: 'return-refund-detail-load-initial',
    status: 'queued',
    queuedAt: '2026-08-25T00:00:01.000Z',
  },
};
const activeVerificationFocus = {
  ...waitingVerification,
  verificationFocus: {
    ...waitingVerification.verificationFocus,
    status: 'active',
    acquiredAt: '2026-08-25T00:00:02.000Z',
    commandBudgetRemainingMs: 30_000,
  },
};
assert.equal(
  workflowEventStateChanged(waitingVerification, activeVerificationFocus),
  false,
  'verification focus coordination must not duplicate the challenge business event',
);
assert.equal(workflowEventSeverity({
  runtimeStatus: 'verification',
  reasonCode: 'verification-required',
  previous: idleScan,
  current: waitingVerification,
  patch: { verificationLocation: waitingVerification.verificationLocation },
}), 'warning', 'a newly detected verification challenge must remain a warning');
assert.equal(workflowEventSeverity({
  runtimeStatus: 'verification',
  reasonCode: 'verification-required',
  previous: waitingVerification,
  current: activeVerificationFocus,
  patch: { authHealth: activeVerificationFocus.authHealth },
}), 'info', 'verification follow-up state must not duplicate the challenge warning');
assert.equal(workflowEventSeverity({
  runtimeStatus: 'verification',
  reasonCode: 'verification-required',
  eventType: 'workflow.snapshot-synchronized',
  current: waitingVerification,
  patch: waitingVerification,
}), 'info', 'snapshot synchronization must not duplicate an outbox warning');
assert.equal(
  workflowEventStateChanged(waitingVerification, {
    ...activeVerificationFocus,
    verificationLocation: {
      ...waitingVerification.verificationLocation,
      stage: 'return-refund-close-detail-before',
    },
  }),
  true,
  'a new verification location must remain observable',
);

const changes = [
  ['order', { orderNumber: '260825-000000000000001' }],
  ['stage', { step: 'pdd-detail-opening' }],
  ['error', { error: 'PDD detail failed to render' }],
  ['auth', { authHealth: { pdd: { status: 'expired', confidence: 'confirmed' } } }],
  ['identity', { pddShopIdentity: { ...idleScan.pddShopIdentity, actualShopName: '店铺B' } }],
  ['verification', {
    verificationLocation: {
      system: 'pdd',
      stage: 'pdd-detail',
      status: 'waiting-human',
      url: 'https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=1',
    },
  }],
];

for (const [name, patch] of changes) {
  assert.equal(
    workflowEventStateChanged(idleScan, { ...repeatedIdleScan, ...patch }),
    true,
    `${name} change must remain observable`,
  );
}

assert.equal(
  workflowEventSemanticJson({
    z: 1,
    a: { d: 4, c: 3 },
    list: [{ b: 2, a: 1 }],
  }),
  '{"a":{"c":3,"d":4},"list":[{"a":1,"b":2}],"z":1}',
  'ordinary objects and nested array objects must retain stable key ordering',
);

const deepObject = { leaf: true };
let deepObjectCursor = deepObject;
for (let depth = 0; depth < 20_000; depth += 1) {
  deepObjectCursor.child = {};
  deepObjectCursor = deepObjectCursor.child;
}
const deepObjectJson = workflowEventSemanticJson({ deepObject });
assert.match(deepObjectJson, /workflowEventState.*depth-limit/u);

const deepArray = [];
let deepArrayCursor = deepArray;
for (let depth = 0; depth < 20_000; depth += 1) {
  const child = [];
  deepArrayCursor.push(child);
  deepArrayCursor = child;
}
const deepArrayJson = workflowEventSemanticJson({ deepArray });
assert.match(deepArrayJson, /workflowEventState.*depth-limit/u);

const circular = { value: 'root' };
circular.self = circular;
const circularJson = workflowEventSemanticJson({ circular });
assert.match(circularJson, /workflowEventState.*circular-reference/u);

const shared = { b: 2, a: 1 };
assert.equal(
  workflowEventSemanticJson({ left: shared, right: shared }),
  '{"left":{"a":1,"b":2},"right":{"a":1,"b":2}}',
  'shared non-circular objects must retain the previous value-copy semantics',
);

const wide = {};
for (let index = 0; index < 10_100; index += 1) wide[`key-${index}`] = index;
const wideState = JSON.parse(workflowEventSemanticJson({ wide })).wide;
const wideMarker = Object.values(wideState).find((value) => (
  value?.['\u0000workflowEventState'] === 'object-entries-truncated'
));
assert.equal(wideMarker?.omittedEntries, 101);

const wideArrayState = JSON.parse(workflowEventSemanticJson({
  wideArray: Array.from({ length: 10_100 }, (_, index) => index),
})).wideArray;
assert.equal(wideArrayState.length, 10_000);
assert.deepEqual(wideArrayState.at(-1), {
  '\u0000workflowEventState': 'array-entries-truncated',
  omittedEntries: 101,
  path: '$["wideArray"]',
});

assert.doesNotThrow(() => workflowEventSemanticJson({ largeInteger: 2n }));

console.log('Workflow event semantic state self-test passed');
