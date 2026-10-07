export class WorkOrderOrchestrator {
  constructor({ repository, pdd, oms, tms, evidence, rules }) {
    this.repository = repository;
    this.pdd = pdd;
    this.oms = oms;
    this.tms = tms;
    this.evidence = evidence;
    this.rules = rules;
  }

  async runClaimed({ shopId, workerId }) {
    const claimed = await this.repository.claimNext({ shopId, workerId });
    if (!claimed) return { status: 'queue-empty' };
    // Platform adapters remain behind ports; the legacy browser workflow is not called from here.
    // This fail-closed guard prevents a PostgreSQL worker and the JSON worker from processing one order together.
    if (!this.pdd || !this.oms || !this.tms || !this.evidence || !this.rules) {
      throw new Error('PostgreSQL orchestration ports are not fully composed');
    }
    return { status: 'claimed', workOrderId: claimed.id, leaseToken: claimed.leaseToken };
  }
}
