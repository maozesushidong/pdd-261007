/**
 * A click is not proof that PDD committed the handover step. The refund
 * outcome form is authoritative because PDD may keep the submitted handover
 * text visible in the service timeline after the first form has disappeared.
 */
export const isPddIntermediateTransitionComplete = ({
  secondStepVisible,
  orderCompleted,
} = {}) => Boolean(secondStepVisible || orderCompleted);

export const isPddHandoverTransitionComplete = isPddIntermediateTransitionComplete;
export const isPddRecallTransitionComplete = isPddIntermediateTransitionComplete;

export const isPddMessageTransitionComplete = ({
  decisionControlsVisible,
  orderCompleted,
} = {}) => Boolean(decisionControlsVisible || orderCompleted);
