import type {
  LogisticsAnalysis,
  OmsAnalysis,
  RuleSet,
  ScenarioDecision,
  ScenarioDefinition,
  ScenarioCode,
  TmsRequest,
} from '@work-order/domain';

export interface PddSnapshot {
  shopId: string;
  orderNumber: string;
  workOrderTitle: string;
  detailUrl: string;
  rawText: string;
  logisticsText: string;
  scenarioCode?: ScenarioCode;
}

export interface WorkOrderRef { id: string; shopId: string; orderNumber: string; title: string }
export interface TmsResult { status: 'skipped' | 'created' | 'reused'; ticketId: string | null; evidenceFileId: string | null }
export interface SubmissionReceipt { accepted: boolean; externalStatus: string; idempotencyKey: string }

export interface PddGateway {
  claimNext(input: { shopId: string; scenarioCodes?: string[]; excludedOrders: string[] }): Promise<WorkOrderRef | null>;
  readSnapshot(input: { shopId: string; workOrder: WorkOrderRef }): Promise<PddSnapshot>;
  executePlan(input: { shopId: string; orderNumber: string; decision: ScenarioDecision; evidenceFileId?: string }): Promise<SubmissionReceipt>;
  confirmCompletion(input: { shopId: string; orderNumber: string }): Promise<{ completed: boolean; method: string }>;
}

export interface OmsGateway { queryOrder(input: { shopId: string; orderNumber: string }): Promise<OmsAnalysis> }
export interface TmsGateway {
  findExisting(input: { shopId: string; orderNumber: string; scenarioCode: string }): Promise<TmsResult | null>;
  createOrReuse(input: { shopId: string; orderNumber: string; scenarioCode: string; request: TmsRequest; pddEvidenceFileId?: string }): Promise<TmsResult>;
}
export interface LogisticsAnalyzer { analyze(snapshot: PddSnapshot): Promise<LogisticsAnalysis> }
export interface EvidenceStore { capturePdd(snapshot: PddSnapshot): Promise<{ id: string }>; delete(id: string): Promise<void> }
export interface WorkOrderRepository {
  saveState(input: { id: string; status: string; data: Record<string, unknown> }): Promise<void>;
  archive(input: { id: string; orderNumber: string }): Promise<void>;
}
export interface RuleRepository { getPublished(input: { shopId: string; scenarioCode: string }): Promise<RuleSet> }
export interface ScenarioPolicy {
  code: ScenarioCode;
  match(input: { workOrderTitle: string; snapshot: PddSnapshot }): Promise<{ matched: boolean; confidence: 'high' | 'medium' | 'low'; reason: string }>;
  decide(input: { snapshot: PddSnapshot; logistics: LogisticsAnalysis; oms: OmsAnalysis; tms: TmsResult | null; rules: RuleSet }): Promise<ScenarioDecision>;
}

export class ScenarioRegistry {
  private readonly policies = new Map<string, ScenarioPolicy>();
  register(policy: ScenarioPolicy): void { this.policies.set(policy.code, policy); }
  get(code: string): ScenarioPolicy | undefined { return this.policies.get(code); }
  list(): ScenarioDefinition[] { return [...this.policies.keys()].map((code) => ({ code, titlePatterns: [], enabled: true, policyVersion: 1, requiresOms: true, requiresTms: true, allowAutoSubmit: false })); }
}

export interface ProcessDependencies {
  pdd: PddGateway;
  oms: OmsGateway;
  tms: TmsGateway;
  logistics: LogisticsAnalyzer;
  evidence: EvidenceStore;
  rules: RuleRepository;
  workOrders: WorkOrderRepository;
  registry: ScenarioRegistry;
}

export const processWorkOrder = async (
  input: { shopId: string; scenarioCodes?: string[]; excludedOrders?: string[] },
  deps: ProcessDependencies,
) => {
  const ref = await deps.pdd.claimNext({ ...input, excludedOrders: input.excludedOrders || [] });
  if (!ref) return { status: 'queue-empty' as const };
  await deps.workOrders.saveState({ id: ref.id, status: 'claimed', data: { shopId: ref.shopId, orderNumber: ref.orderNumber } });
  const snapshot = await deps.pdd.readSnapshot({ shopId: input.shopId, workOrder: ref });
  const candidates = input.scenarioCodes?.length ? input.scenarioCodes : deps.registry.list().map((item) => item.code);
  const matches = await Promise.all(candidates.map(async (code) => {
    const policy = deps.registry.get(code);
    if (!policy) return null;
    const result = await policy.match({ workOrderTitle: snapshot.workOrderTitle, snapshot });
    return result.matched && result.confidence === 'high' ? policy : null;
  }));
  const policy = matches.find(Boolean) || null;
  if (!policy) {
    await deps.workOrders.saveState({ id: ref.id, status: 'manual-review-required', data: { reason: 'scenario-not-uniquely-matched' } });
    return { status: 'manual-review-required' as const, reason: 'scenario-not-uniquely-matched', ref };
  }
  const logistics = await deps.logistics.analyze(snapshot);
  const oms = await deps.oms.queryOrder({ shopId: input.shopId, orderNumber: ref.orderNumber });
  const rules = await deps.rules.getPublished({ shopId: input.shopId, scenarioCode: policy.code });
  const pddEvidence = await deps.evidence.capturePdd(snapshot);
  const decisionWithoutTms = await policy.decide({ snapshot, logistics, oms, tms: null, rules });
  let tms: TmsResult | null = null;
  if (decisionWithoutTms.tms.required && decisionWithoutTms.tms.request) {
    tms = await deps.tms.createOrReuse({ shopId: input.shopId, orderNumber: ref.orderNumber, scenarioCode: policy.code, request: decisionWithoutTms.tms.request, pddEvidenceFileId: pddEvidence.id });
  } else {
    tms = { status: 'skipped', ticketId: null, evidenceFileId: null };
  }
  const decision = await policy.decide({ snapshot, logistics, oms, tms, rules });
  if (!decision.pdd.allowAutoSubmit) {
    await deps.workOrders.saveState({ id: ref.id, status: 'manual-review-required', data: { decision, logistics, oms, tms } });
    return { status: 'manual-review-required' as const, ref, decision, logistics, oms, tms };
  }
  await deps.pdd.executePlan({ shopId: input.shopId, orderNumber: ref.orderNumber, decision, evidenceFileId: tms.evidenceFileId || undefined });
  const completion = await deps.pdd.confirmCompletion({ shopId: input.shopId, orderNumber: ref.orderNumber });
  if (!completion.completed) {
    await deps.workOrders.saveState({ id: ref.id, status: 'manual-review-required', data: { reason: 'completion-not-confirmed' } });
    return { status: 'manual-review-required' as const, ref, decision, logistics, oms, tms };
  }
  await deps.workOrders.archive({ id: ref.id, orderNumber: ref.orderNumber });
  await deps.evidence.delete(pddEvidence.id);
  return { status: 'completed' as const, ref, decision, logistics, oms, tms, completion };
};

