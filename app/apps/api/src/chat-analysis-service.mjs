import { createPostgresPool } from '../../../packages/adapters/src/postgres/index.mjs';
import { ChatRepository } from '../../../packages/adapters/src/chat-analysis/repository.mjs';
import { analyzeConversation, modelConfig, ChatModelError } from '../../../packages/adapters/src/chat-analysis/model.mjs';
import { chatPolicies, evaluateChatPolicy } from '../../../packages/adapters/src/chat-analysis/rules.mjs';

export async function createChatAnalysisService() {
  const pool = await createPostgresPool(undefined, { max: 4, applicationName: 'pdd-chat-analysis' });
  const repository = new ChatRepository(pool);
  let closing = false, ticking = false;
  const active = new Set();
  async function run(job) {
    let leaseLost = false;
    const renewal = setInterval(() => { repository.renew(job).then((ok) => { if (!ok) leaseLost = true; }).catch(() => { leaseLost = true; }); }, 30000);
    try {
      const { payload: snapshot } = await repository.snapshot(job.snapshot_id);
      const policy = chatPolicies.get(job.policy_id, job.policy_version);
      const config = { ...await modelConfig(), model: job.model, baseUrl: job.base_url };
      const result = await analyzeConversation({ snapshot, policy, config,
        readAttachment: (id) => repository.attachment(job.snapshot_id, id), checkpoint: job.checkpoint,
        onCheckpoint: async (data) => { if (leaseLost) throw new ChatModelError('CHAT_LEASE_LOST'); await repository.checkpoint(job, data); } });
      if (leaseLost) return;
      await repository.finish(job, { ...result, policy: evaluateChatPolicy({ snapshot, analysis: result.analysis, policy }) });
    } catch (error) {
      if (!leaseLost) await repository.finish(job, null, error);
    } finally { clearInterval(renewal); }
  }
  async function tick() {
    if (closing || ticking) return;
    ticking = true;
    try {
      while (!closing && active.size < 2) {
        const job = await repository.claimJob(); if (!job) break;
        const task = run(job).catch(() => {}).finally(() => active.delete(task)); active.add(task);
      }
    } catch { /* Service failure must not interrupt the existing API or log credentials. */ }
    finally { ticking = false; }
  }
  const timer = setInterval(tick, 3000); timer.unref();
  return { repository, tick, async close() { closing = true; clearInterval(timer); await Promise.allSettled([...active]); await pool.end(); } };
}
