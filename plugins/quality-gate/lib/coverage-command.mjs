import { spawn, spawnSync } from 'node:child_process';

function killWindowsCoverageTree(child) {
  const result = spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
  if (result.status === 0) return;
  if (!coverageProcessExists(child.pid)) return;
  throw new Error(`Could not stop coverage process tree: ${[result.error?.message, result.stderr, result.stdout].filter(Boolean).join(' ')}`);
}

function coverageProcessExists(identifier) {
  try { process.kill(identifier, 0); return true; }
  catch (error) { if (error.code !== 'ESRCH') throw error; return false; }
}

function killCoverageTree(child) {
  if (process.platform === 'win32') return killWindowsCoverageTree(child);
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

function commandCompletion(code, stderr, timedOut, timeout) {
  if (timedOut) throw new Error(`Coverage command ran out of time after ${timeout} ms. Increase coverageTimeoutMs or --coverage-timeout-ms, or set 0 for no limit, then rerun the gate.`);
  if (code !== 0) throw new Error(`Coverage command failed: ${stderr || code}. Fix coverageCommand, then rerun the gate.`);
}

export function runCoverageCommand(command, { cwd, env, timeout = 0 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, env, shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-65536); });
    const timer = timeout > 0 ? setTimeout(() => {
      timedOut = true;
      try { killCoverageTree(child); } catch (error) { reject(error); }
    }, timeout) : undefined;
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      try {
        commandCompletion(code, stderr, timedOut, timeout);
        resolve();
      } catch (error) { reject(error); }
    });
  });
}
