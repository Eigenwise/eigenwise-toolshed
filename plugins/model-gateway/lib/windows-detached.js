'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

// WMI creates the launcher outside the invoking hook/terminal's process tree and
// Job Object. Node's detached:true alone does not escape Windows job cleanup.
const CREATE_PROCESS = `
$ErrorActionPreference = 'Stop'
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{
  ShowWindow = [uint16]0
  CreateFlags = [uint32]16778240
  EnvironmentVariables = [string[]]$payload.environment
}
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = [string]$payload.commandLine
  CurrentDirectory = [string]$payload.cwd
  ProcessStartupInformation = $startup
}
if ($result.ReturnValue -ne 0) { throw "WMI process creation failed: $($result.ReturnValue)" }
`;

function quoteArgument(value) {
  return '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}

function spawnWindowsDetached(command, args, { env, logPath, state }) {
  const directory = fs.mkdtempSync(path.join(state, 'launch-'));
  const resultPath = path.join(directory, 'result.json');
  // Only launch metadata travels in argv. The environment goes through stdin
  // into WMI's environment block, never a command line or temporary file.
  const payload = Buffer.from(JSON.stringify({ command, args, logPath, resultPath })).toString('base64');
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', CREATE_PROCESS], {
      input: Buffer.from(JSON.stringify({
        commandLine: [process.execPath, __filename, payload].map(quoteArgument).join(' '),
        cwd: process.cwd(),
        environment: Object.entries(env).filter(([, value]) => value != null).map(([key, value]) => `${key}=${value}`),
      })).toString('base64'),
      encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    if (result.error || result.status !== 0) throw new Error(`Windows detached launch failed: ${result.error?.message || result.stderr.trim()}`);
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(resultPath) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    if (!fs.existsSync(resultPath)) throw new Error('Windows detached launcher did not acknowledge startup');
    const acknowledgement = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    if (!acknowledgement.pid) throw new Error(`Windows detached launch failed: ${acknowledgement.error}`);
    return acknowledgement.pid;
  } finally {
    for (const file of ['result.json', 'result.tmp']) {
      try { fs.unlinkSync(path.join(directory, file)); } catch {}
    }
    try { fs.rmdirSync(directory); } catch {}
  }
}

if (require.main === module) {
  const config = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));
  // A timed-out caller removes this directory. Do not start an unacknowledged
  // service if WMI only gets around to running us after that cancellation.
  if (!fs.existsSync(path.dirname(config.resultPath))) process.exit(1);
  const acknowledge = (value) => {
    const temporary = path.join(path.dirname(config.resultPath), 'result.tmp');
    fs.writeFileSync(temporary, JSON.stringify(value));
    fs.renameSync(temporary, config.resultPath);
  };
  let output;
  try {
    output = fs.openSync(config.logPath, 'a');
    const child = spawn(config.command, config.args, {
      detached: true, stdio: ['ignore', output, output], env: process.env, windowsHide: true,
    });
    child.once('error', (error) => acknowledge({ error: error.message }));
    child.once('spawn', () => {
      try { acknowledge({ pid: child.pid }); child.unref(); }
      catch { child.kill(); }
    });
  } catch (error) { acknowledge({ error: error.message }); }
  finally { if (output !== undefined) fs.closeSync(output); }
}

module.exports = { spawnWindowsDetached };
