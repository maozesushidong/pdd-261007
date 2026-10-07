const SCENARIO_ALIASES = new Map([
  ['in-transit-no-reason-refund', 'in-transit-refund'],
]);

export const canonicalScenarioCode = (value) => {
  const code = String(value || '').trim();
  return SCENARIO_ALIASES.get(code) || code;
};

export const scenarioAliases = Object.freeze(Object.fromEntries(SCENARIO_ALIASES));
