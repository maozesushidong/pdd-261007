export type ScenarioCode = string;
export type ShopId = string;
export type WorkOrderStatus =
  | 'queued'
  | 'claimed'
  | 'pdd-read'
  | 'logistics-analyzed'
  | 'oms-queried'
  | 'decision-ready'
  | 'tms-skipped'
  | 'tms-created'
  | 'tms-reused'
  | 'pdd-ready'
  | 'submitting'
  | 'completed'
  | 'archived'
  | 'verification-required'
  | 'manual-review-required'
  | 'rate-limited'
  | 'failed';

export interface ScenarioDefinition {
  code: ScenarioCode;
  titlePatterns: string[];
  titleMatchMode?: 'exact' | 'contains';
  displayName?: string;
  displayOrder?: number;
  enabled: boolean;
  policyVersion: number;
  requiresPdd?: boolean;
  requiresOms: boolean;
  conditionalOms?: boolean;
  requiresTms: boolean;
  conditionalTms?: boolean;
  allowAutoSubmit: boolean;
}

export interface LogisticsAnalysis {
  orderNumber: string;
  carrier: string | null;
  trackingNumber: string | null;
  originCity: string | null;
  latestCity: string | null;
  outsideOriginCity: boolean | null;
  traceRecords: readonly LogisticsTrace[];
  timelineRecords: readonly LogisticsTrace[];
  stageAnalysis: LogisticsStageAnalysis | null;
}

export interface LogisticsTrace {
  timestamp: string;
  trace: string;
  city: string | null;
}

export interface LogisticsStageAnalysis {
  stageCode: string;
  stageLabel: string;
  logisticsIssue: string | null;
  isAbnormal: boolean;
  referenceTimestamp: string | null;
  elapsedHours: number | null;
  thresholdHours: number | null;
  isRemoteRegion: boolean;
  isPostalCarrier: boolean;
  evidenceTrace: string | null;
}

export interface OmsAnalysis {
  orderNumber: string;
  shippingWarehouse: string | null;
  isLowValue: boolean | null;
  isReissueOrder: boolean | null;
  markText: string | null;
  relatedOrderNumber: string | null;
}

export interface TmsRequest {
  scenarioCode: ScenarioCode;
  problemType: string;
  customerRemark: string;
  requiresEvidence: boolean;
}

export interface RuleSet {
  version: number;
  scenarioRules: Record<string, unknown>;
  warehouseCarrierRules: WarehouseCarrierRule[];
  resolutionRules: Record<string, unknown>;
}

export interface WarehouseCarrierRule {
  id: string;
  warehouseAliases: string[];
  carrierMode: 'any' | 'not-in' | 'only-in';
  carriers: string[];
  enabled: boolean;
  priority: number;
}

export interface ScenarioDecision {
  scenarioCode: ScenarioCode;
  tms: { required: boolean; request?: TmsRequest };
  pdd: { allowAutoSubmit: boolean; actions: PddAction[] };
  reason: string;
  manualReview?: string;
}

export interface PddAction {
  type: 'select' | 'upload-evidence' | 'submit' | 'wait';
  value?: string;
}

export interface VerificationLocation {
  id: string;
  shopId: ShopId;
  system: 'pdd' | 'oms' | 'tms';
  stage: string;
  status: 'detected' | 'waiting-human' | 'resolved' | 'expired';
  url: string;
  frameUrl?: string;
  selector?: string;
  boundingBox: { x: number; y: number; width: number; height: number };
  screenshotFileId: string;
  confidence: 'high' | 'medium' | 'low';
  detectedAt: string;
  resolvedAt?: string;
}

export const normalizeRuleText = (value: string | null | undefined): string => String(value || '')
  .normalize('NFKC')
  .replace(/[\s\-_:：,，。/\\]+/g, '')
  .replace(/仓库$/u, '仓')
  .toLocaleLowerCase();

export const matchesAlias = (value: string | null | undefined, aliases: readonly string[]): boolean => {
  const normalized = normalizeRuleText(value);
  return Boolean(normalized) && aliases.some((alias) => normalized.includes(normalizeRuleText(alias)));
};

export const evaluateWarehouseCarrierRule = (
  warehouse: string | null | undefined,
  carrier: string | null | undefined,
  rules: readonly WarehouseCarrierRule[],
): WarehouseCarrierRule | null => {
  const candidates = rules
    .filter((rule) => rule.enabled && matchesAlias(warehouse, rule.warehouseAliases))
    .sort((a, b) => b.priority - a.priority);
  if (candidates.length !== 1) return null;
  const rule = candidates[0];
  if (!rule) return null;
  const carrierMatch = matchesAlias(carrier, rule.carriers);
  const eligible = rule.carrierMode === 'any'
    || (rule.carrierMode === 'not-in' && !carrierMatch)
    || (rule.carrierMode === 'only-in' && carrierMatch);
  return eligible ? rule : null;
};

export const isValidScenarioDefinition = (definition: ScenarioDefinition): boolean => Boolean(
  definition.code.trim()
  && definition.titlePatterns.length > 0
  && definition.policyVersion > 0,
);
