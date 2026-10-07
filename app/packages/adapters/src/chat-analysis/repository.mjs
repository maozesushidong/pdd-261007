import crypto from 'node:crypto';
import { analysisKey, chatPolicies } from './rules.mjs';

const caseStatusForJob = (job, mode) => {
  if (job.status === 'failed') return 'owner-review';
  if (job.status !== 'analyzed') return 'analysis-pending';
  if (!job.result?.policy?.eligible) return 'owner-review';
  return mode === 'auto-feedback' ? 'auto-ready' : 'awaiting-owner-approval';
};

export class ChatRepository {
  constructor(pool) { this.pool = pool; }
  async settings() { return (await this.pool.query('SELECT * FROM chat_analysis_settings WHERE id=1')).rows[0]; }
  async setMode(mode, actor, approve = false) {
    if (!['off', 'analyze-only', 'auto-feedback'].includes(mode)) throw new Error('CHAT_MODE_INVALID');
    return (await this.pool.query(`UPDATE chat_analysis_settings SET mode=$1,
      approved_at=CASE WHEN $1='auto-feedback' THEN now() ELSE NULL END,
      approved_by=CASE WHEN $1='auto-feedback' THEN $2 ELSE NULL END,updated_at=now() WHERE id=1 RETURNING *`, [mode, actor])).rows[0];
  }
  async excluded(shopId) {
    return (await this.pool.query(`SELECT chat.platform_case_key AS "platformCaseKey",
      chat.order_number AS "orderNumber", chat.platform_case_id AS "platformWorkOrderId",
      chat.scenario_code AS "scenarioCode", chat.work_order_type AS "workOrderType",
      instance.first_discovered_at AS "firstDiscoveredAt"
      FROM chat_cases chat
      LEFT JOIN ordinary_work_order_instances instance
        ON instance.platform_case_key = chat.platform_case_key
        AND instance.shop_id = chat.shop_id
      WHERE chat.shop_id=$1 AND NOT chat.collect_requested AND chat.next_collect_at>now()`, [shopId])).rows;
  }
  async requested(shopId) {
    return (await this.pool.query(`SELECT * FROM chat_cases WHERE shop_id=$1 AND collect_requested
      AND (collect_lease_until IS NULL OR collect_lease_until<now()) ORDER BY updated_at LIMIT 1`, [shopId])).rows[0];
  }
  async claimCollection(discovery) {
    const token = crypto.randomUUID();
    const row = (await this.pool.query(`INSERT INTO chat_cases(
        id,shop_id,order_number,platform_case_key,platform_case_id,detail_url,scenario_code,work_order_type
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(shop_id,platform_case_key) DO UPDATE SET
        detail_url=excluded.detail_url,
        scenario_code=COALESCE(NULLIF(excluded.scenario_code, ''), chat_cases.scenario_code),
        work_order_type=COALESCE(NULLIF(excluded.work_order_type, ''), chat_cases.work_order_type)
      WHERE chat_cases.order_number=excluded.order_number RETURNING *`,
    [crypto.randomUUID(), discovery.shopId, discovery.orderNumber, discovery.platformCaseKey,
      discovery.platformWorkOrderId, discovery.detailUrl, discovery.scenarioCode || 'product-shortage',
      discovery.workOrderType || '商品少发'])).rows[0];
    if (!row) throw new Error('CHAT_CASE_ORDER_MISMATCH');
    return (await this.pool.query(`UPDATE chat_cases SET collect_token=$2,collect_lease_until=now()+interval '10 minutes',
      status='collecting',updated_at=now() WHERE id=$1 AND (collect_lease_until IS NULL OR collect_lease_until<now()) RETURNING *`, [row.id, token])).rows[0];
  }
  async saveSnapshot(caseRow, snapshot, images, config) {
    if (snapshot.shopId !== caseRow.shop_id || snapshot.orderNumber !== caseRow.order_number || snapshot.platformCaseKey !== caseRow.platform_case_key) throw new Error('CHAT_SNAPSHOT_IDENTITY_MISMATCH');
    const policy = chatPolicies.forScenario(caseRow.scenario_code);
    if (!policy) throw new Error('CHAT_POLICY_NOT_REGISTERED_FOR_SCENARIO');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = (await client.query('SELECT id FROM chat_cases WHERE id=$1 AND collect_token=$2 FOR UPDATE', [caseRow.id, caseRow.collect_token])).rowCount;
      if (!locked) throw new Error('CHAT_COLLECTION_LEASE_LOST');
      const snap = (await client.query(`INSERT INTO chat_snapshots(id,case_id,content_hash,payload) VALUES($1,$2,$3,$4)
        ON CONFLICT(case_id,content_hash) DO UPDATE SET payload=excluded.payload RETURNING id`, [crypto.randomUUID(), caseRow.id, snapshot.contentHash, snapshot])).rows[0];
      for (const img of images) await client.query(`INSERT INTO chat_attachments(snapshot_id,id,mime_type,content) VALUES($1,$2,$3,$4)
        ON CONFLICT DO NOTHING`, [snap.id, img.id, img.mime, Buffer.from(img.base64, 'base64')]);
      const requestHash = analysisKey({ snapshot, policy, ...config });
      const inserted = await client.query(`INSERT INTO chat_analysis_jobs(id,case_id,snapshot_id,request_hash,policy_id,policy_version,model,base_url)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(case_id,request_hash) DO NOTHING`,
      [crypto.randomUUID(), caseRow.id, snap.id, requestHash, policy.id, policy.version, config.model, config.baseUrl]);
      let caseStatus = 'analysis-pending';
      let caseError = null;
      if (!inserted.rowCount) {
        // Recollecting identical content reuses the already finished analysis.
        // Keep the case aligned with that job; no new job will move it out of
        // analysis-pending later. The case row stays locked through this
        // transaction, so a concurrent finish() writes its final case status
        // after this update.
        const existingJob = (await client.query(`SELECT status,result,error_code
          FROM chat_analysis_jobs WHERE case_id=$1 AND request_hash=$2`,
        [caseRow.id, requestHash])).rows[0];
        if (!existingJob) throw new Error('CHAT_ANALYSIS_JOB_CONFLICT_MISSING');
        const mode = existingJob.status === 'analyzed'
          ? (await client.query('SELECT mode FROM chat_analysis_settings WHERE id=1')).rows[0]?.mode
          : null;
        caseStatus = caseStatusForJob(existingJob, mode);
        caseError = existingJob.status === 'failed' ? existingJob.error_code : null;
      }
      await client.query(`UPDATE chat_cases SET status=$2,last_error=$3, collect_requested=false,
        collect_token=NULL,collect_lease_until=NULL,next_collect_at=now()+interval '24 hours',updated_at=now() WHERE id=$1`,
      [caseRow.id, caseStatus, caseError]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  async collectionFailed(caseRow, code) {
    await this.pool.query(`UPDATE chat_cases SET status='owner-review',last_error=$3,collect_token=NULL,collect_lease_until=NULL,
      collect_requested=false,next_collect_at=now()+interval '30 minutes',updated_at=now() WHERE id=$1 AND collect_token=$2`, [caseRow.id, caseRow.collect_token, code]);
  }
  async claimJob() {
    const token = crypto.randomUUID();
    return (await this.pool.query(`UPDATE chat_analysis_jobs SET status='running',lease_token=$1,
      lease_until=now()+interval '3 minutes',attempts=attempts+1,updated_at=now()
      WHERE id=(SELECT j.id FROM chat_analysis_jobs j JOIN chat_analysis_settings s ON s.id=1 AND s.mode<>'off'
        WHERE ((j.status IN ('pending','retry') AND j.next_attempt_at<=now()) OR (j.status='running' AND j.lease_until<now()))
        AND j.attempts<4 ORDER BY j.next_attempt_at FOR UPDATE OF j SKIP LOCKED LIMIT 1) RETURNING *`, [token])).rows[0];
  }
  async renew(job) { return (await this.pool.query(`UPDATE chat_analysis_jobs SET lease_until=now()+interval '3 minutes' WHERE id=$1 AND lease_token=$2 AND status='running'`, [job.id, job.lease_token])).rowCount > 0; }
  async snapshot(id) { return (await this.pool.query('SELECT * FROM chat_snapshots WHERE id=$1', [id])).rows[0]; }
  async attachment(snapshotId, id) {
    const row = (await this.pool.query('SELECT mime_type,content FROM chat_attachments WHERE snapshot_id=$1 AND id=$2', [snapshotId, id])).rows[0];
    return row ? { bytes: row.content, mime: row.mime_type } : null;
  }
  async checkpoint(job, data) { await this.pool.query('UPDATE chat_analysis_jobs SET checkpoint=$3 WHERE id=$1 AND lease_token=$2', [job.id, job.lease_token, data]); }
  async finish(job, result, error = null) {
    const retry = error?.retryable && job.attempts < 4;
    const delay = Math.max(error?.retryAfterMs || 0, [30000, 60000, 120000][job.attempts - 1] || 120000);
    const rows = await this.pool.query(`UPDATE chat_analysis_jobs SET status=$3,result=$4,error_code=$5,
      lease_token=NULL,lease_until=NULL,next_attempt_at=now()+($6::double precision*interval '1 millisecond'),updated_at=now()
      WHERE id=$1 AND lease_token=$2 RETURNING case_id`, [job.id, job.lease_token, error ? retry ? 'retry' : 'failed' : 'analyzed', result,
      error ? String(error.code || 'CHAT_ANALYSIS_FAILED') : null, delay]);
    if (rows.rowCount) {
      const mode = (await this.settings())?.mode;
      const caseStatus = caseStatusForJob({
        status: error ? retry ? 'retry' : 'failed' : 'analyzed',
        result,
      }, mode);
      await this.pool.query(`UPDATE chat_cases SET status=$2,last_error=$3,updated_at=now() WHERE id=$1`,
        [job.case_id, caseStatus, error?.code || null]);
    }
  }
  async list({ shopId = '', orderNumber = '', limit = 100 } = {}) {
    return (await this.pool.query(`SELECT c.*,s.name AS shop_name,j.id AS job_id,j.status AS analysis_status,j.result,j.error_code,
      j.model,j.updated_at AS analyzed_at,x.id AS snapshot_id,x.payload->'completeness' AS completeness
      FROM chat_cases c JOIN shops s ON s.id=c.shop_id
      LEFT JOIN LATERAL(SELECT * FROM chat_analysis_jobs WHERE case_id=c.id ORDER BY created_at DESC LIMIT 1) j ON true
      LEFT JOIN chat_snapshots x ON x.id=j.snapshot_id
      WHERE ($1='' OR c.shop_id=$1) AND ($2='' OR c.order_number=$2)
      ORDER BY c.updated_at DESC LIMIT $3`, [shopId, orderNumber, Math.min(200, Math.max(1, Number(limit) || 100))])).rows;
  }
  async detail(id) {
    const row = (await this.pool.query(`SELECT c.*,s.name AS shop_name FROM chat_cases c JOIN shops s ON s.id=c.shop_id WHERE c.id=$1`, [id])).rows[0];
    if (!row) return null;
    const jobs = (await this.pool.query(`SELECT id,snapshot_id,policy_id,policy_version,model,status,result,error_code,created_at,updated_at
      FROM chat_analysis_jobs WHERE case_id=$1 ORDER BY created_at DESC LIMIT 10`, [id])).rows;
    const snapshot = jobs[0] ? await this.snapshot(jobs[0].snapshot_id) : null;
    return { ...row, jobs, snapshot };
  }
  async recollect(id) {
    return (await this.pool.query(`UPDATE chat_cases SET collect_requested=true,next_collect_at=now(),updated_at=now()
      WHERE id=$1 RETURNING id`, [id])).rows[0];
  }
  async deleteCase(id) {
    const result = await this.pool.query('DELETE FROM chat_cases WHERE id=$1 RETURNING id', [id]);
    return result.rows[0] || null;
  }
  async clearAll() {
    const result = await this.pool.query('DELETE FROM chat_cases RETURNING id');
    return { deleted: result.rowCount };
  }
}
