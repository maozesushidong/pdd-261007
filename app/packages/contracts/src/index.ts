import type {
  LogisticsAnalysis,
  OmsAnalysis,
  ScenarioCode,
  VerificationLocation,
  WorkOrderStatus,
} from '@work-order/domain';

export interface WorkOrderSummaryDto {
  id: string;
  shopId: string;
  orderNumber: string;
  scenarioCode: ScenarioCode;
  status: WorkOrderStatus;
  carrier: string | null;
  trackingNumber: string | null;
  warehouse?: string | null;
  warehouseInfo?: WarehouseInfoDto;
  scenarioInfo?: ScenarioInfoDto;
  completionInfo?: CompletionInfoDto;
  dataFreshness?: DataFreshnessDto;
  manualReviewReason: string | null;
  updatedAt: string;
}

export type WarehouseState = 'pending' | 'confirmed' | 'read-failed' | 'ambiguous' | 'conflict' | 'not-applicable';

export interface WarehouseInfoDto {
  status: WarehouseState;
  omsValue: string | null;
  omsObservedAt: string | null;
  omsSource: string | null;
  failureReason: string | null;
  tmsValue: string | null;
  tmsObservedAt: string | null;
  comparison: 'matched' | 'conflict' | 'not-checked';
  manualValue?: string | null;
}

export interface ScenarioInfoDto {
  code: string | null;
  status: 'pending' | 'confirmed' | 'read-failed';
  source: string;
  observedAt: string | null;
}

export interface CompletionInfoDto {
  state: 'pending' | 'confirmed' | 'reconciliation-required' | 'not-applicable';
  confirmationMethod: string | null;
  confirmedAt: string | null;
  involvedHumanReview: boolean;
}

export interface DataFreshnessDto {
  latestEventAt: string | null;
  lastSyncedAt: string | null;
  syncLagSeconds: number | null;
  stale: boolean;
}

export interface WorkOrderDetailDto extends WorkOrderSummaryDto {
  logistics: LogisticsAnalysis | null;
  oms: OmsAnalysis | null;
  tms: { ticketId: string | null; status: string; evidenceFileId: string | null } | null;
  evidence: EvidenceDto[];
  verification: VerificationLocation | null;
}

export interface EvidenceDto {
  id: string;
  kind: 'pdd-detail' | 'tms-row' | 'diagnostic';
  status: 'pending' | 'ready' | 'used' | 'unused' | 'deleted';
  url?: string;
  createdAt: string;
}

export interface DashboardQueryDto {
  from?: string;
  to?: string;
  shopId?: string;
  scenarioCode?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

export interface DashboardSummaryDto {
  total: number;
  autoSuccess: number;
  strictAutoSuccess: number;
  humanConfirmed: number;
  manualReview: number;
  failed: number;
  processing: number;
  waiting: number;
  verification: number;
  paused: number;
  reconciliationRequired: number;
  averageDurationSeconds: number | null;
  byScenario: Array<{
    scenarioCode: string;
    total: number;
    autoSuccess: number;
    strictAutoSuccess: number;
    humanConfirmed: number;
    manualReview: number;
    failed: number;
    paused: number;
  }>;
}

export interface VerificationEventDto {
  type: 'verification.detected' | 'verification.resolved';
  location: VerificationLocation;
}
