import { createChatAnalysisService } from './chat-analysis-service.mjs';
import { modelConfig } from '../../../packages/adapters/src/chat-analysis/model.mjs';

export async function registerChatAnalysisRoutes(app, { requireOwner, requireOwnerSession, audit }) {
  const enabled = process.env.CHAT_ANALYSIS_ENABLED === 'true' && process.env.DATA_BACKEND === 'postgres';
  const service = enabled ? await createChatAnalysisService() : null;
  const repo = service?.repository;
  const requireService = async (_request, reply) => { if (!repo) return reply.code(503).send({ error: '聊天分析尚未启用' }); };
  const idSchema = { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } };
  app.get('/api/v1/chat-analysis/settings', { preHandler: requireOwnerSession }, async () => {
    const config = await modelConfig().catch(() => ({ model: process.env.CHAT_ANALYSIS_MODEL, apiKey: '' }));
    return { data: { enabled, mode: repo ? (await repo.settings()).mode : 'off', model: config.model,
      configured: Boolean(config.apiKey), approvalRequired: false } };
  });
  app.patch('/api/v1/chat-analysis/settings', { preHandler: [requireOwner, requireService], schema: {
    body: { type: 'object', required: ['mode'], additionalProperties: false, properties: {
      mode: { enum: ['off', 'analyze-only', 'auto-feedback'] }, approveAutomaticFeedback: { type: 'boolean' } } },
  } }, async (request, reply) => {
    const data = await repo.setMode(request.body.mode, request.owner.sub, request.body.approveAutomaticFeedback === true);
    await audit({ actorId: request.owner.sub, eventType: 'chat-analysis-mode-changed', payload: { mode: data.mode } });
    return { data };
  });
  app.get('/api/v1/chat-analysis/cases', { preHandler: [requireOwnerSession, requireService] }, async (request) => ({ data: await repo.list(request.query || {}) }));
  app.get('/api/v1/chat-analysis/cases/:id', { preHandler: [requireOwnerSession, requireService], schema: idSchema }, async (request, reply) => {
    const data = await repo.detail(request.params.id); return data ? { data } : reply.code(404).send({ error: '聊天分析记录不存在' });
  });
  app.post('/api/v1/chat-analysis/cases/:id/recollect', { preHandler: [requireOwner, requireService], schema: idSchema }, async (request, reply) => {
    const data = await repo.recollect(request.params.id);
    if (!data) return reply.code(404).send({ error: '聊天分析记录不存在' });
    await audit({ actorId: request.owner.sub, eventType: 'chat-recollection-requested', payload: { caseId: data.id } });
    return { data };
  });
  app.delete('/api/v1/chat-analysis/cases/:id', { preHandler: [requireOwner, requireService], schema: idSchema }, async (request, reply) => {
    const data = await repo.deleteCase(request.params.id);
    if (!data) return reply.code(404).send({ error: '聊天分析记录不存在' });
    await audit({ actorId: request.owner.sub, eventType: 'chat-analysis-case-deleted', payload: { caseId: data.id } });
    return { data: { deleted: true, id: data.id } };
  });
  app.delete('/api/v1/chat-analysis/cases', { preHandler: [requireOwner, requireService] }, async (request) => {
    const data = await repo.clearAll();
    await audit({ actorId: request.owner.sub, eventType: 'chat-analysis-cleared', payload: data });
    return { data };
  });
  // Private attachments never enter the general evidence/public asset routes.
  app.get('/api/v1/chat-analysis/snapshots/:id/attachments/:attachmentId', {
    preHandler: [requireOwnerSession, requireService], schema: { params: { type: 'object', properties: {
      id: { type: 'string', format: 'uuid' }, attachmentId: { type: 'string', pattern: '^[a-f0-9]{32}$' } } } },
  }, async (request, reply) => {
    const file = await repo.attachment(request.params.id, request.params.attachmentId);
    if (!file) return reply.code(404).send({ error: '聊天附件不存在' });
    return reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff').type(file.mime).send(file.bytes);
  });
  if (service) app.addHook('onClose', () => service.close());
  return service;
}
