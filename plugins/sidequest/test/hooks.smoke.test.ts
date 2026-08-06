import './_temp-cleanup.js';
import './_sidequest-install-fixture.js';
import './_hook-runtime.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const hooksConfiguration = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8')) as unknown;
const hookScripts = new Set<string>();

function collectHookScripts(value: unknown): void {
  if (typeof value === 'string') {
    const match = value.match(/\/hooks\/([^"']+\.js)/);
    if (match?.[1]) hookScripts.add(match[1]);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectHookScripts(item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const item of Object.values(value)) collectHookScripts(item);
}

collectHookScripts(hooksConfiguration);

test('configured hooks all execute successfully once in the default suite', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-smoke-home-'));
  const hookRoot = path.join(__dirname, '..', 'hooks');
  const environment = { ...process.env, SIDEQUEST_HOME: home, CLAUDE_PLUGIN_ROOT: path.join(__dirname, '..') };
  for (const hookScript of hookScripts) {
    const result = spawnSync(process.execPath, [path.join(hookRoot, hookScript)], {
      cwd: path.join(__dirname, '..'),
      env: environment,
      input: '{}',
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    assert.equal(result.status, 0, `${hookScript}: ${result.error?.message ?? result.stderr}`);
  }
});
