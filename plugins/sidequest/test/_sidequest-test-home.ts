import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Hooks resolve `lib/*.js` under CLAUDE_PLUGIN_ROOT, so a suite launched from a plugin-hosted
// process runs its hooks against the INSTALLED plugin while the assertions drive this checkout.
// SQ-2862's integrate read installed 5.1.15 that way and reported the merged fix as unlanded.
// Importing this pins the variable to this repository for every test file, not only the ones that
// already ask for it. A test wanting another root still sets its own afterwards.
import './_hook-runtime.js';

const sidequestTestHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-test-home-'));
Object.assign(process.env, {
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
});
process.env.SIDEQUEST_HOME = sidequestTestHome;
process.env.SIDEQUEST_CLAUDE_HOME = path.join(sidequestTestHome, 'claude');

// Routing reads the wired Claude tier pins from the environment. A developer machine wired to the
// gateway carries them; CI does not. Tests that need a pin set it themselves.
for (const key of Object.keys(process.env)) {
  if (/^ANTHROPIC_DEFAULT_[A-Z]+_MODEL$/.test(key)) delete process.env[key];
}

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
