import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
};
const sinceInput = arg('--since');
if (!sinceInput || Number.isNaN(Date.parse(sinceInput))) {
  throw new Error('--since requires an ISO-8601 timestamp');
}
const since = Date.parse(sinceInput);
const environmentText = fs.readFileSync(path.join(appRoot, '.env.native'), 'utf8');
const configuredDataRoot = environmentText.match(/^WORKFLOW_DATA_ROOT=(.+)$/mu)?.[1]
  ?.trim().replace(/^(['"])(.*)\1$/u, '$2');
const dataRoot = path.resolve(process.env.WORKFLOW_DATA_ROOT
  || configuredDataRoot || path.join(appRoot, '..', 'data', 'workflow'));
const shopsRoot = path.join(dataRoot, 'shops');
const normalize = (value) => String(value || '').normalize('NFKC').replace(/\s+/gu, '').trim();
const same = (left, right) => String(left || '').trim() === String(right || '').trim();

const summary = {
  checkedAt: new Date().toISOString(),
  since: new Date(since).toISOString(),
  completedWithTmsTicket: 0,
  newlyCreatedTickets: 0,
  reusedTickets: 0,
  exactUiMatches: 0,
  reusedCompatibleVariations: 0,
  newTicketFieldDifferences: 0,
  missingUiEvidence: 0,
  identityMismatches: 0,
  parseErrors: 0,
  findings: [],
};

for (const shop of fs.readdirSync(shopsRoot, { withFileTypes: true })) {
  if (!shop.isDirectory()) continue;
  const archives = path.join(shopsRoot, shop.name, 'state', 'completed-work-orders');
  if (!fs.existsSync(archives)) continue;
  for (const entry of fs.readdirSync(archives, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filename = path.join(archives, entry.name);
    if (fs.statSync(filename).mtimeMs < since) continue;
    let record;
    try { record = JSON.parse(fs.readFileSync(filename, 'utf8')); }
    catch { summary.parseErrors += 1; continue; }
    const archivedAt = Date.parse(record.completionArchive?.archivedAt || '');
    if (!Number.isFinite(archivedAt) || archivedAt < since
      || record.tmsWorkOrder?.status !== 'created') continue;
    summary.completedWithTmsTicket += 1;
    const evidence = record.tmsEvidenceScreenshot;
    const ticket = record.tmsWorkOrder;
    if (ticket.recovered === true) summary.reusedTickets += 1;
    else summary.newlyCreatedTickets += 1;
    if (!evidence || !['ready', 'deleted', 'consumed'].includes(evidence.status)
      || !evidence.ticketId || !evidence.ticketNo
      || !evidence.verifiedTrackingNumber || !Array.isArray(evidence.includedColumns)) {
      summary.missingUiEvidence += 1;
      summary.findings.push({ shopId: shop.name, orderNumber: record.orderNumber,
        kind: 'ui-evidence-not-retained', evidenceStatus: evidence?.status || null });
      continue;
    }
    const identityChecks = {
      order: same(evidence.orderNumber, record.orderNumber),
      ticketId: same(evidence.ticketId, ticket.ticketId),
      ticketNo: same(evidence.ticketNo, ticket.ticketNo),
      tracking: same(evidence.verifiedTrackingNumber,
        record.logisticsAnalysis?.trackingNumber),
      columns: ['交易号', '订单号', '运单号', '物流问题', '客服备注']
        .every((column) => evidence.includedColumns?.includes(column)),
    };
    const identityMatches = Object.values(identityChecks).every(Boolean);
    if (!identityMatches) {
      summary.identityMismatches += 1;
      summary.findings.push({ shopId: shop.name, orderNumber: record.orderNumber,
        kind: 'ui-identity-mismatch', checks: identityChecks });
      continue;
    }
    const expectedProblem = normalize(record.tmsFormDecision?.problemType);
    const visibleProblem = normalize(evidence.verifiedProblemType);
    const expectedRemark = normalize(record.tmsFormDecision?.customerRemark);
    const visibleRemark = normalize(evidence.verifiedCustomerRemark).replace(/复制$/u, '');
    if (expectedProblem === visibleProblem && expectedRemark === visibleRemark) {
      summary.exactUiMatches += 1;
    } else if (ticket.recovered === true
      && ticket.existingDecisionComparison?.matches === true) {
      summary.reusedCompatibleVariations += 1;
      summary.findings.push({ shopId: shop.name, orderNumber: record.orderNumber,
        kind: 'reused-compatible-variation',
        matchMode: ticket.existingDecisionComparison.matchMode || null });
    } else {
      summary.newTicketFieldDifferences += 1;
      summary.findings.push({ shopId: shop.name, orderNumber: record.orderNumber,
        kind: 'new-ticket-ui-fields-differ', problemTypeMatches: expectedProblem === visibleProblem,
        remarkMatches: expectedRemark === visibleRemark });
    }
  }
}

console.log(JSON.stringify(summary, null, 2));
