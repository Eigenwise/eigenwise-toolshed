'use strict';

const { spawnSync } = require('node:child_process');

type ProcessEntry = {
  pid: number;
  parentPid: number;
  command: string;
};

type LifecycleOptions = {
  processId?: number;
  parentProcessId?: number;
  platform?: string;
  spawnSync?: typeof spawnSync;
  listProcesses?: () => ProcessEntry[];
  killProcess?: (pid: number) => void;
};

function objectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function validProcessEntry(value: unknown): ProcessEntry | null {
  if (!objectRecord(value)) return null;
  const pid = Number(value.pid);
  const parentPid = Number(value.parentPid);
  const command = typeof value.command === 'string' ? value.command : '';
  return Number.isInteger(pid) && pid > 0 && Number.isInteger(parentPid) && parentPid > 0
    ? { pid, parentPid, command }
    : null;
}

function windowsProcesses(run: typeof spawnSync): ProcessEntry[] {
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'], {
    encoding: 'utf8', timeout: 3000, windowsHide: true,
  });
  if (result.status !== 0) return [];
  try {
    const parsed: unknown = JSON.parse(String(result.stdout || ''));
    const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    return entries.flatMap((entry) => {
      if (!objectRecord(entry)) return [];
      const valid = validProcessEntry({
        pid: entry.ProcessId,
        parentPid: entry.ParentProcessId,
        command: entry.CommandLine,
      });
      return valid ? [valid] : [];
    });
  } catch {
    return [];
  }
}

function posixProcesses(run: typeof spawnSync): ProcessEntry[] {
  const result = run('ps', ['-eo', 'pid=,ppid=,args='], {
    encoding: 'utf8', timeout: 3000, windowsHide: true,
  });
  if (result.status !== 0) return [];
  return String(result.stdout || '').split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] || '' }] : [];
  });
}

function sidequestMcpProcesses(options: LifecycleOptions = {}): ProcessEntry[] {
  const run = options.spawnSync || spawnSync;
  const processes = options.listProcesses
    ? options.listProcesses()
    : (options.platform || process.platform) === 'win32'
      ? windowsProcesses(run)
      : posixProcesses(run);
  return processes.filter((entry) => /(?:^|[\\/])sidequest-mcp\.js(?:["\s]|$)/i.test(entry.command));
}

function stopProcess(pid: number, options: LifecycleOptions = {}) {
  if (!Number.isInteger(pid) || pid < 1 || pid === (options.processId || process.pid)) return false;
  if (options.killProcess) {
    options.killProcess(pid);
    return true;
  }
  if ((options.platform || process.platform) === 'win32') {
    (options.spawnSync || spawnSync)('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore', timeout: 3000, windowsHide: true,
    });
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch { return false; }
  }
  return true;
}

function reapMcpSiblings(options: LifecycleOptions = {}): number[] {
  const processId = options.processId || process.pid;
  const parentProcessId = options.parentProcessId || process.ppid;
  if (!Number.isInteger(parentProcessId) || parentProcessId < 1) return [];
  return sidequestMcpProcesses(options)
    .filter((entry) => entry.pid !== processId && entry.parentPid === parentProcessId)
    .flatMap((entry) => stopProcess(entry.pid, options) ? [entry.pid] : []);
}

module.exports = { reapMcpSiblings, sidequestMcpProcesses, stopProcess };
