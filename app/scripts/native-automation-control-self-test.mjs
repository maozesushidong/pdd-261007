import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createNativeAutomationControl } from '../apps/api/src/native-automation-control.mjs';

const temporaryRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pdd-control-test-'));
const startScript = path.join(temporaryRoot, 'start.ps1');
const stopScript = path.join(temporaryRoot, 'stop.ps1');
const heartbeatFile = path.join(temporaryRoot, 'heartbeat.json');
const timestamp = Date.now();
const calls = [];
const children = [];
const env = {
  PDD_AUTOMATION_START_SCRIPT: startScript,
  PDD_AUTOMATION_STOP_SCRIPT: stopScript,
  WORKER_HEARTBEAT_FILE: heartbeatFile,
};
try {
  await fsp.writeFile(startScript, '# test stub');
  await fsp.writeFile(stopScript, '# test stub');
  const heartbeat = async (state, ageMs = 0, bom = '') => fsp.writeFile(heartbeatFile,
    bom + JSON.stringify({ state, updatedAt: new Date(timestamp - ageMs).toISOString() }));
  const control = createNativeAutomationControl({
    env, now: () => timestamp,
    spawnProcess: (...args) => {
      calls.push(args);
      const child = new EventEmitter();
      child.unref = () => {};
      children.push(child);
      return child;
    },
  });
  await heartbeat('stopped');
  assert.equal((await control.snapshot()).state, 'stopped');
  const firstStart = control.run('start');
  await assert.rejects(control.run('start'), error => error.statusCode === 409);
  assert.equal((await firstStart).state, 'starting');
  assert.equal(calls.length, 1, 'simultaneous requests must not create two Workers');
  assert.equal(calls[0][1][4], startScript, 'local controls must use the local override');
  assert.equal(calls[0][2].windowsHide, true);
  await heartbeat('running', 1000, '\uFEFF');
  assert.equal((await control.snapshot()).state, 'starting', 'pending control must remain pending');
  children[0].emit('exit', 0);
  assert.equal((await control.snapshot()).state, 'running');
  await heartbeat('running', 60000);
  assert.equal((await control.snapshot()).state, 'stopped', 'stale heartbeat cannot report a live Worker');
  assert.equal((await control.run('stop')).state, 'stopping');
  assert.equal(calls[1][1][4], stopScript);
  await heartbeat('stopped');
  children[1].emit('exit', 0);
  assert.equal((await control.snapshot()).state, 'stopped');
  await control.run('start');
  children[2].emit('error', new Error('test spawn failure'));
  assert.equal((await control.snapshot()).state, 'unknown');
  assert.match((await control.snapshot()).error, /test spawn failure/);
  await fsp.unlink(startScript);
  await assert.rejects(control.run('start'), /ENOENT/);
  assert.equal((await control.run('stop')).state, 'stopping', 'a failed start must release the control lock');
  children[3].emit('exit', 0);
  console.log('Local automation control: script selection, concurrency, heartbeat, failure recovery passed.');
} finally {
  if (path.dirname(temporaryRoot) !== path.resolve(os.tmpdir())) throw new Error('Unexpected test directory');
  await fsp.rm(temporaryRoot, { recursive: true, force: true });
}
