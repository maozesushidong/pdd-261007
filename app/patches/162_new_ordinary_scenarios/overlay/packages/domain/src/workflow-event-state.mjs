const runtimeOnlyTopLevelFields = new Set([
  'updatedAt',
  'businessUpdatedAt',
  'browserUrl',
  'currentUrl',
  'derivedTabs',
  'browserRuntime',
  'runtimeObservation',
  'systemTabs',
  'residentCommand',
  'verificationFocus',
]);

const definedEntries = (value, keys) => Object.fromEntries(
  keys
    .filter((key) => value?.[key] !== undefined)
    .map((key) => [key, value[key]]),
);

const normalizedUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return raw;
  }
};

const authHealthState = (authHealth) => {
  if (!authHealth || typeof authHealth !== 'object' || Array.isArray(authHealth)) return authHealth;
  return Object.fromEntries(Object.keys(authHealth).sort().map((system) => {
    const observation = authHealth[system];
    if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
      return [system, observation];
    }
    return [system, definedEntries(observation, ['status', 'stage', 'confidence'])];
  }));
};

const pddShopIdentityState = (identity) => {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return identity;
  return definedEntries(identity, [
    'configured',
    'actualShopName',
    'mallId',
    'mallName',
    'status',
    'profileFingerprint',
  ]);
};

const verificationLocationState = (location) => {
  if (!location || typeof location !== 'object' || Array.isArray(location)) return location;
  const state = definedEntries(location, [
    'system',
    'stage',
    'status',
    'kind',
    'challengeType',
    'reason',
  ]);
  if (location.url !== undefined) state.url = normalizedUrl(location.url);
  return state;
};

const stableValueLimits = Object.freeze({
  maxDepth: 512,
  maxNodes: 50_000,
  maxContainerEntries: 10_000,
});

const stateMarkerKey = '\u0000workflowEventState';

const stableMarker = (kind, details = {}) => Object.fromEntries(
  Object.entries({ ...details, [stateMarkerKey]: kind })
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
);

const childPath = (parentPath, key, array) => (
  array ? `${parentPath}[${key}]` : `${parentPath}[${JSON.stringify(key)}]`
);

const stableFrame = (source, target, depth, path) => {
  if (Array.isArray(source)) {
    const sourceLength = source.length;
    const entryCount = sourceLength > stableValueLimits.maxContainerEntries
      ? stableValueLimits.maxContainerEntries - 1
      : sourceLength;
    return {
      source,
      target,
      depth,
      path,
      array: true,
      index: 0,
      entryCount,
      truncatedCount: sourceLength - entryCount,
      keys: null,
      truncationKey: null,
    };
  }

  const sourceKeys = Object.keys(source).sort();
  const retainedEntryCount = sourceKeys.length > stableValueLimits.maxContainerEntries
    ? stableValueLimits.maxContainerEntries - 1
    : sourceKeys.length;
  const truncatedCount = sourceKeys.length - retainedEntryCount;
  const keys = truncatedCount
    ? sourceKeys.slice(0, retainedEntryCount)
    : sourceKeys;
  let truncationKey = null;
  if (truncatedCount) {
    truncationKey = stateMarkerKey;
    while (sourceKeys.includes(truncationKey)) truncationKey += '\u0000';
    keys.push(truncationKey);
    keys.sort();
  }
  return {
    source,
    target,
    depth,
    path,
    array: false,
    index: 0,
    entryCount: keys.length,
    truncatedCount,
    keys,
    truncationKey,
  };
};

const stableValue = (value) => {
  if (typeof value === 'bigint') {
    return stableMarker('bigint', { value: value.toString() });
  }
  if (!value || typeof value !== 'object') return value;

  const root = Array.isArray(value) ? [] : {};
  const stack = [stableFrame(value, root, 0, '$')];
  const activePaths = new WeakMap([[value, '$']]);
  let visitedNodes = 1;

  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.entryCount) {
      if (frame.array && frame.truncatedCount > 0) {
        frame.target.push(stableMarker('array-entries-truncated', {
          omittedEntries: frame.truncatedCount,
          path: frame.path,
        }));
      }
      activePaths.delete(frame.source);
      stack.pop();
      continue;
    }

    const key = frame.array ? frame.index : frame.keys[frame.index];
    frame.index += 1;
    if (!frame.array && frame.truncationKey === key) {
      frame.target[key] = stableMarker('object-entries-truncated', {
        omittedEntries: frame.truncatedCount,
        path: frame.path,
      });
      continue;
    }

    const path = childPath(frame.path, key, frame.array);
    if (visitedNodes >= stableValueLimits.maxNodes) {
      frame.target[key] = stableMarker('node-budget-exhausted', { path });
      break;
    }
    visitedNodes += 1;

    const child = frame.source[key];
    if (typeof child === 'bigint') {
      frame.target[key] = stableMarker('bigint', { value: child.toString() });
      continue;
    }
    if (!child || typeof child !== 'object') {
      frame.target[key] = child;
      continue;
    }

    const ancestorPath = activePaths.get(child);
    if (ancestorPath) {
      frame.target[key] = stableMarker('circular-reference', { ancestorPath, path });
      continue;
    }
    if (frame.depth + 1 > stableValueLimits.maxDepth) {
      frame.target[key] = stableMarker('depth-limit', {
        path,
        valueType: Array.isArray(child) ? 'array' : 'object',
      });
      continue;
    }

    const target = Array.isArray(child) ? [] : {};
    frame.target[key] = target;
    activePaths.set(child, path);
    stack.push(stableFrame(child, target, frame.depth + 1, path));
  }

  return root;
};

export const workflowEventSemanticState = (snapshot = {}) => {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return snapshot;
  const semantic = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (runtimeOnlyTopLevelFields.has(key)) continue;
    if (key === 'authHealth') semantic[key] = authHealthState(value);
    else if (key === 'pddShopIdentity') semantic[key] = pddShopIdentityState(value);
    else if (key === 'verificationLocation') semantic[key] = verificationLocationState(value);
    else semantic[key] = value;
  }
  return semantic;
};

export const workflowEventSemanticJson = (snapshot = {}) => JSON.stringify(
  stableValue(workflowEventSemanticState(snapshot)),
);

const activeVerificationStatuses = new Set([
  'detected',
  'waiting-human',
  'verification-required',
]);

export const workflowEventSeverity = ({
  runtimeStatus,
  reasonCode,
  eventType = 'workflow.progress',
  previous = {},
  current = {},
  patch = {},
} = {}) => {
  if (runtimeStatus === 'failed') return 'error';
  if (!reasonCode) return 'info';
  if (eventType === 'workflow.snapshot-synchronized') return 'info';
  if (reasonCode !== 'verification-required') return 'warning';

  const candidate = patch?.verificationLocation;
  if (!candidate || candidate.resolvedAt
    || !activeVerificationStatuses.has(String(candidate.status || 'waiting-human'))) {
    return 'info';
  }
  const previousLocation = previous?.verificationLocation;
  const previousId = String(previousLocation?.id || '');
  const currentId = String(current?.verificationLocation?.id || candidate.id || '');
  if (currentId) return currentId === previousId ? 'info' : 'warning';
  return workflowEventSemanticJson({ verificationLocation: previousLocation })
    === workflowEventSemanticJson({ verificationLocation: candidate })
    ? 'info'
    : 'warning';
};

export const workflowEventStateChanged = (previous = {}, current = {}) => (
  workflowEventSemanticJson(previous) !== workflowEventSemanticJson(current)
);
