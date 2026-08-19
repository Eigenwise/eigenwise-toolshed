import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sidequestTestHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-test-home-'));
Object.assign(process.env, {
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
});
process.env.SIDEQUEST_HOME = sidequestTestHome;

process.once('exit', () => {
  try {
    fs.rmSync(sidequestTestHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch {
    const cleanup = spawn(process.execPath, ['-e', `require('node:fs').rmSync(${JSON.stringify(sidequestTestHome)}, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    cleanup.unref();
  }
});
