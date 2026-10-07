import { canonicalScenarioCode } from '../../../packages/domain/src/scenario-code.mjs';

const ordinaryInstanceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const platformCaseKeyPattern = /^pdd-work-order:[0-9]{6,30}$/u;

const distinctNonEmptyStrings = (values) => [...new Set(values
  .map((value) => String(value ?? '').trim())
  .filter(Boolean))];

export const workerEventOrdinaryIdentity = (raw = {}) => {
  const snapshot = raw.payload?.snapshot || {};
  const ordinaryInstanceIds = distinctNonEmptyStrings([
    raw.ordinaryInstanceId,
    raw.payload?.ordinaryInstanceId,
    snapshot.ordinaryInstanceId,
  ]);
  const platformCaseKeys = distinctNonEmptyStrings([
    raw.platformCaseKey,
    raw.payload?.platformCaseKey,
    snapshot.platformCaseKey,
    snapshot.latestDiscovery?.platformCaseKey,
  ]);
  const malformed = ordinaryInstanceIds.length > 1
    || platformCaseKeys.length > 1
    || ordinaryInstanceIds.some((value) => !ordinaryInstanceIdPattern.test(value))
    || platformCaseKeys.some((value) => !platformCaseKeyPattern.test(value));
  return {
    ordinaryInstanceId: ordinaryInstanceIds[0] || null,
    platformCaseKey: platformCaseKeys[0] || null,
    supplied: ordinaryInstanceIds.length > 0 || platformCaseKeys.length > 0,
    malformed,
  };
};

const knownScenarioCode = (value) => {
  const code = canonicalScenarioCode(value);
  return code && code !== 'unknown' ? code : null;
};

export const workerEventTmsScenario = (raw = {}, persisted = {}) => {
  const snapshot = raw.payload?.snapshot || {};
  const tmsWorkOrder = snapshot.tmsWorkOrder || {};
  const candidates = [
    ['event', raw.scenarioCode],
    ['event-payload', raw.payload?.scenarioCode],
    ['snapshot', snapshot.scenarioCode],
    ['ordinary-scenario-execution', snapshot.ordinaryScenarioExecution?.scenarioCode],
    ['tms-form-decision', snapshot.tmsFormDecision?.scenarioCode],
    ['tms-payload', tmsWorkOrder.scenarioCode],
    ['tms-request-context', tmsWorkOrder.requestContext?.scenarioCode],
    ['ordinary-instance', persisted.ordinaryInstanceScenarioCode],
    ['work-order', persisted.workOrderScenarioCode],
  ];
  for (const [source, value] of candidates) {
    const scenarioCode = knownScenarioCode(value);
    if (scenarioCode) return { scenarioCode, source };
  }
  return { scenarioCode: 'unknown', source: 'fallback-unknown' };
};
