import assert from 'node:assert/strict';
import {
  isPddHandoverTransitionComplete,
  isPddMessageTransitionComplete,
  isPddRecallTransitionComplete,
} from '../packages/adapters/src/pdd/submit-postcondition.mjs';

assert.equal(
  isPddHandoverTransitionComplete({ firstStepVisible: false, secondStepVisible: true }),
  true,
  'handover transition should be accepted when the refund form is visible',
);
assert.equal(
  isPddHandoverTransitionComplete({ firstStepVisible: true, secondStepVisible: true }),
  true,
  'submitted handover text may remain visible in the service timeline',
);
assert.equal(
  isPddHandoverTransitionComplete({ firstStepVisible: false, secondStepVisible: false }),
  false,
  'a missing second step must not be treated as a committed transition',
);
assert.equal(
  isPddHandoverTransitionComplete({ secondStepVisible: false, orderCompleted: true }),
  true,
  'an explicitly completed order should recover a handover submit that navigated away',
);
assert.equal(
  isPddRecallTransitionComplete({ secondStepVisible: true, orderCompleted: false }),
  true,
  'recall-status submit must be confirmed by the next form step',
);
assert.equal(
  isPddRecallTransitionComplete({ secondStepVisible: false, orderCompleted: false }),
  false,
  'recall-status click alone must never count as a committed transition',
);
assert.equal(
  isPddMessageTransitionComplete({ decisionControlsVisible: true, orderCompleted: false }),
  true,
  'sending the PDD script is committed when the next decision form is visible',
);
assert.equal(
  isPddMessageTransitionComplete({ decisionControlsVisible: false, orderCompleted: true }),
  true,
  'sending the PDD script is committed when the work order completes directly',
);
assert.equal(
  isPddMessageTransitionComplete({ decisionControlsVisible: false, orderCompleted: false }),
  false,
  'the script button click alone must not prove that PDD committed the message',
);

console.log('PDD handover submit postcondition self-test passed');
