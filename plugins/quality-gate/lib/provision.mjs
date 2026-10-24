import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { compilerFrom } from './compiler.mjs';

const INSTALL_ARGUMENTS = ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];

function stopInstall(child) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
  else child.kill('SIGKILL');
}

export function installParser(root, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', INSTALL_ARGUMENTS, { cwd: root, shell: process.platform === 'win32', windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.resume();
    const timer = setTimeout(() => stopInstall(child), timeout);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`npm exited ${code}`));
    });
  });
}

async function acquireLock(lock, deadline) {
  while (Date.now() < deadline) {
    try { return await fs.open(lock, 'wx'); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await delay(100);
  }
  throw new Error('parser installation lock timed out');
}

async function installUnderLock(root, deadline, runner, resolveCompiler, notice) {
  await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
  const lock = path.join(root, 'node_modules/.quality-gate-provision.lock');
  const handle = await acquireLock(lock, deadline);
  try {
    if (resolveCompiler(root)) return;
    notice('quality-gate: installing the TypeScript parser (one time)\n');
    await runner(root, Math.max(1, deadline - Date.now()));
    if (!resolveCompiler(root)) throw new Error('installation did not provide TypeScript 7');
  } finally {
    await handle.close();
    await fs.unlink(lock);
  }
}

export async function provisionParser(root, { runner = installParser, resolveCompiler = compilerFrom, notice = (text) => process.stderr.write(text), timeout = 180000 } = {}) {
  if (resolveCompiler(root)) return;
  try {
    await installUnderLock(root, Date.now() + timeout, runner, resolveCompiler, notice);
  } catch (error) {
    throw new Error(`TypeScript parser unavailable: ${error.message}. Run npm install --prefix "${root}"`);
  }
}
