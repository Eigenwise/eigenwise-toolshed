'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { gatewayTestEnvironment } = require('./support.js');
const { spawnWindowsDetached } = require('../lib/windows-detached.js');

const windows = process.platform === 'win32';
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A harness (Claude Code, Claude Desktop, Windows Terminal) ends a tool call by
// closing a job armed with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, not by calling
// TerminateJobObject, so this reproduces the close-kill (SQ-2798).
test('Windows detached service survives KILL_ON_JOB_CLOSE on the caller job; ordinary detached child does not', { skip: !windows, timeout: 30000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway job é '));
  const env = gatewayTestEnvironment(t, { HOME: directory, USERPROFILE: directory });
  const fixture = path.join(directory, 'caller.js');
  const resultPath = path.join(directory, 'pids.json');
  const serviceCode = 'console.log(process.env.GATEWAY_SENTINEL); console.error("stderr works"); setInterval(()=>{},1000)';
  fs.writeFileSync(fixture, `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const { spawnDetached } = require(${JSON.stringify(require.resolve('../lib/process-supervision.js'))});
    fs.mkdirSync(${JSON.stringify(path.join(directory, '.claude', 'model-gateway', 'logs'))}, {recursive:true});
    const control = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {detached:true,stdio:'ignore',windowsHide:true});
    control.unref();
    const service = spawnDetached('guardian', process.execPath, ['-e', ${JSON.stringify(serviceCode)}], {GATEWAY_SENTINEL:'preserved-é'});
    fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({control:control.pid,service}));
  `);
  let pids;
  t.after(() => {
    if (pids) for (const pid of Object.values(pids)) { try { process.kill(pid); } catch {} }
  });
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GatewayJobTest {
 [StructLayout(LayoutKind.Sequential)] public struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
 [StructLayout(LayoutKind.Sequential)] public struct BasicLimits {
  public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
  public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize;
  public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
 [StructLayout(LayoutKind.Sequential)] public struct ExtendedLimits {
  public BasicLimits BasicLimitInformation; public IoCounters IoInfo;
  public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j, int infoClass, IntPtr info, uint length);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 public static void ArmKillOnJobClose() {
  IntPtr job = CreateJobObject(IntPtr.Zero, null);
  if (job == IntPtr.Zero) throw new Exception("CreateJobObject failed " + Marshal.GetLastWin32Error());
  ExtendedLimits limits = new ExtendedLimits();
  limits.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  int size = Marshal.SizeOf(typeof(ExtendedLimits));
  IntPtr buffer = Marshal.AllocHGlobal(size);
  Marshal.StructureToPtr(limits, buffer, false);
  bool armed = SetInformationJobObject(job, 9, buffer, (uint)size); // JobObjectExtendedLimitInformation
  int armedError = Marshal.GetLastWin32Error();
  Marshal.FreeHGlobal(buffer);
  if (!armed) throw new Exception("SetInformationJobObject failed " + armedError);
  if (!AssignProcessToJobObject(job, GetCurrentProcess())) throw new Exception("AssignProcessToJobObject failed " + Marshal.GetLastWin32Error());
 }
}
'@
[GatewayJobTest]::ArmKillOnJobClose()
& '${process.execPath.replace(/'/g, "''")}' '${fixture.replace(/'/g, "''")}'
if ($LASTEXITCODE -ne 0) { throw 'Fixture failed' }
# Exiting closes the only handle to the job, and KILL_ON_JOB_CLOSE reaps every
# process still a member of it. The negative control below proves that happened.
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env, encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
  assert.ok(fs.existsSync(resultPath), result.stderr || String(result.error));
  pids = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  assert.equal(result.status, 0, result.stderr);
  for (let attempt = 0; attempt < 40 && alive(pids.control); attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(pids.control), false, 'negative control must die with the caller job');
  assert.equal(alive(pids.service), true, 'gateway launch must survive caller job termination');
  const actualLog = path.join(directory, '.claude', 'model-gateway', 'logs', 'guardian.log');
  for (let attempt = 0; attempt < 40 && !fs.readFileSync(actualLog, 'utf8').includes('stderr works'); attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(fs.readFileSync(actualLog, 'utf8'), /preserved-é/);
  assert.match(fs.readFileSync(actualLog, 'utf8'), /stderr works/);
  assert.equal(Number(fs.readFileSync(path.join(directory, '.claude', 'model-gateway', 'guardian.pid'), 'utf8')), pids.service);
  assert.deepEqual(fs.readdirSync(path.join(directory, '.claude', 'model-gateway')).filter((name) => name.startsWith('launch-')), []);
});

test('Windows detached launch reports invalid executables without a success PID', { skip: !windows, timeout: 20000 }, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-launch-error-'));
  assert.throws(() => spawnWindowsDetached(path.join(directory, 'missing.exe'), [], {
    env: gatewayTestEnvironment(t, { HOME: directory, USERPROFILE: directory }), logPath: path.join(directory, 'out.log'), state: directory,
  }), /Windows detached launch failed:.*ENOENT/);
  assert.deepEqual(fs.readdirSync(directory).filter((name) => name.startsWith('launch-')), []);
});
