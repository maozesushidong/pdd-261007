import fs from 'node:fs';

const heartbeatFile = process.env.WORKER_HEARTBEAT_FILE || '/tmp/pdd-worker-heartbeat.json';
try {
  const heartbeat = JSON.parse(fs.readFileSync(heartbeatFile, 'utf8'));
  const age = Date.now() - Date.parse(heartbeat.updatedAt);
  if (!Number.isFinite(age) || age > 60_000) process.exit(1);
  process.exit(0);
} catch {
  process.exit(1);
}
