import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const createNativeAutomationControl = ({
  env = process.env,
  spawnProcess = spawn,
  now = Date.now,
} = {}) => {
  let state = { state: 'unknown', requestedAt: null };
  let pending = false;
  const scriptsRoot = path.join(env.PDD_NATIVE_APP_ROOT || 'D:\\pdd-native\\app', 'scripts');
  const scriptFor = (action) => action === 'start'
    ? env.PDD_AUTOMATION_START_SCRIPT || path.join(scriptsRoot, 'start-native-windows.ps1')
    : env.PDD_AUTOMATION_STOP_SCRIPT || path.join(scriptsRoot, 'stop-native-windows.ps1');

  const snapshot = async () => {
    if (pending || state.error || !env.WORKER_HEARTBEAT_FILE) return { ...state };
    try {
      const heartbeat = JSON.parse((await fsp.readFile(env.WORKER_HEARTBEAT_FILE, 'utf8')).replace(/^\uFEFF/u, ''));
      const ageMs = now() - Date.parse(heartbeat.updatedAt);
      const running = heartbeat.state === 'running' && Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 35_000;
      return { ...state, state: running ? 'running' : 'stopped' };
    } catch {
      return { ...state, state: state.state === 'running' ? 'unknown' : state.state };
    }
  };

  const run = async (action) => {
    if (!['start', 'stop'].includes(action)) throw new Error('runtime-control-action-invalid');
    if (pending) {
      const error = new Error('Automation control is already in progress.');
      error.statusCode = 409;
      throw error;
    }
    pending = true;
    state = { state: action === 'start' ? 'starting' : 'stopping', requestedAt: new Date(now()).toISOString() };
    let child;
    try {
      const script = scriptFor(action);
      await fsp.access(script);
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
      if (action === 'start') args.push('-StartWorker', '-NoBrowser');
      child = spawnProcess('powershell.exe', args, {
        detached: true, windowsHide: true, stdio: 'ignore',
      });
    } catch (error) {
      pending = false;
      state = { ...state, state: 'unknown', error: error.message };
      throw error;
    }
    child.once('error', (error) => {
      pending = false;
      state = { ...state, state: 'unknown', error: error.message };
    });
    child.once('exit', (code) => {
      pending = false;
      state = code === 0
        ? { ...state, state: action === 'start' ? 'running' : 'stopped' }
        : { ...state, state: 'unknown', error: 'Automation control script failed; check local service logs.' };
    });
    child.unref();
    return { ...state };
  };
  return { snapshot, run };
};
