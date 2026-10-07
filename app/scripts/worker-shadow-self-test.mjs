import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const heartbeatFile = path.join(os.tmpdir(), `pdd-shadow-test-${process.pid}.json`);
const child = spawn(process.execPath, [path.join(root, 'apps/worker/src/main.mjs')], {
  cwd: root,
  env: {
    ...process.env,
    WORKER_EXECUTION_ENABLED: 'false',
    WORKER_DATA_BACKEND: 'postgres',
    WORKER_HEARTBEAT_FILE: heartbeatFile,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk.toString(); });
for (let attempt = 0; attempt < 20 && child.exitCode === null && !fs.existsSync(heartbeatFile); attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.equal(child.exitCode, null);
assert.equal(fs.existsSync(heartbeatFile), true);
assert.equal(JSON.parse(fs.readFileSync(heartbeatFile, 'utf8')).state, 'disabled');
child.kill('SIGTERM');
await new Promise((resolve) => child.once('exit', resolve));
assert.match(output, /Worker execution is disabled/);
fs.rmSync(heartbeatFile, { force: true });
console.log('worker disabled-mode self-test passed');
