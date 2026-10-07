import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const aggregateProcessTreeMemory = (processes, rootPids) => {
  const byParent = new Map();
  const memoryByPid = new Map();
  for (const processInfo of processes || []) {
    const pid = Number(processInfo.pid ?? processInfo.ProcessId);
    const parentPid = Number(processInfo.parentPid ?? processInfo.ParentProcessId);
    const memoryBytes = Number(processInfo.memoryBytes ?? processInfo.WorkingSetSize ?? 0);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    memoryByPid.set(pid, Number.isFinite(memoryBytes) ? memoryBytes : 0);
    if (!byParent.has(parentPid)) byParent.set(parentPid, []);
    byParent.get(parentPid).push(pid);
  }
  const totals = new Map();
  for (const rootPidValue of rootPids || []) {
    const rootPid = Number(rootPidValue);
    const pending = [rootPid];
    const visited = new Set();
    let bytes = 0;
    while (pending.length) {
      const pid = pending.pop();
      if (visited.has(pid)) continue;
      visited.add(pid);
      bytes += memoryByPid.get(pid) || 0;
      pending.push(...(byParent.get(pid) || []));
    }
    totals.set(rootPid, bytes / 1024 / 1024);
  }
  return totals;
};

const windowsProcesses = async () => {
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress';
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', script,
  ], { windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
  const parsed = JSON.parse(String(stdout || '[]').replace(/^\uFEFF/, '') || '[]');
  return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
    pid: item.ProcessId,
    parentPid: item.ParentProcessId,
    memoryBytes: item.WorkingSetSize,
  }));
};

const unixProcesses = async () => {
  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,rss='], {
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  return String(stdout || '').split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, parentPid, rssKb]) => Number.isFinite(pid) && Number.isFinite(parentPid) && Number.isFinite(rssKb))
    .map(([pid, parentPid, rssKb]) => ({ pid, parentPid, memoryBytes: rssKb * 1024 }));
};

export const sampleProcessTreeMemory = async (rootPids, platform = process.platform) => {
  const processes = platform === 'win32' ? await windowsProcesses() : await unixProcesses();
  return aggregateProcessTreeMemory(processes, rootPids);
};
