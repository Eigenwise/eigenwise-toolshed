import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sidequestTestHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-test-home-'));
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
