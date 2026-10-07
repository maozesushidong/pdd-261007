import assert from 'node:assert/strict';
import {
  workerEventOrdinaryIdentity,
  workerEventTmsScenario,
} from '../apps/api/src/worker-event-identity.mjs';

const ordinaryInstanceId = '10469b84-f7f2-4863-990f-25d65a220e85';
const platformCaseKey = 'pdd-work-order:500012978962616';

assert.deepEqual(workerEventOrdinaryIdentity({
  ordinaryInstanceId,
  platformCaseKey,
  payload: { snapshot: { ordinaryInstanceId, platformCaseKey } },
}), {
  ordinaryInstanceId,
  platformCaseKey,
  supplied: true,
  malformed: false,
});

assert.deepEqual(workerEventOrdinaryIdentity({
  payload: { snapshot: { latestDiscovery: { platformCaseKey } } },
}), {
  ordinaryInstanceId: null,
  platformCaseKey,
  supplied: true,
  malformed: false,
});

assert.equal(workerEventOrdinaryIdentity({
  ordinaryInstanceId,
  payload: { snapshot: { ordinaryInstanceId: 'aad1190a-7d56-45af-9d75-5092cbfd8d91' } },
}).malformed, true);

assert.equal(workerEventOrdinaryIdentity({
  platformCaseKey: 'pdd-work-order:not-a-number',
}).malformed, true);

assert.deepEqual(workerEventTmsScenario({
  scenarioCode: 'product-shortage',
  payload: { snapshot: { scenarioCode: 'delivery-risk-concern' } },
}), { scenarioCode: 'product-shortage', source: 'event' });

assert.deepEqual(workerEventTmsScenario({
  payload: { snapshot: { scenarioCode: 'delivery-risk-concern' } },
}), { scenarioCode: 'delivery-risk-concern', source: 'snapshot' });

assert.deepEqual(workerEventTmsScenario({
  scenarioCode: 'unknown',
  payload: {
    snapshot: {
      ordinaryScenarioExecution: { scenarioCode: 'intercept-recall' },
      tmsWorkOrder: { scenarioCode: 'product-shortage' },
    },
  },
}), { scenarioCode: 'intercept-recall', source: 'ordinary-scenario-execution' });

assert.deepEqual(workerEventTmsScenario({
  payload: { snapshot: { tmsWorkOrder: { requestContext: { scenarioCode: 'product-shortage' } } } },
}), { scenarioCode: 'product-shortage', source: 'tms-request-context' });

assert.deepEqual(workerEventTmsScenario({}, {
  ordinaryInstanceScenarioCode: 'intercept-recall',
  workOrderScenarioCode: 'delivery-risk-concern',
}), { scenarioCode: 'intercept-recall', source: 'ordinary-instance' });

assert.deepEqual(workerEventTmsScenario({}, {
  workOrderScenarioCode: 'delivery-risk-concern',
}), { scenarioCode: 'delivery-risk-concern', source: 'work-order' });

assert.deepEqual(workerEventTmsScenario({ scenarioCode: 'unknown' }), {
  scenarioCode: 'unknown',
  source: 'fallback-unknown',
});

console.log('worker event ordinary identity self-test passed');
