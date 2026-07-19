'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  COLLECTOR_VERSION,
  LGTM_IMAGE,
  MIN_CLAUDE_VERSION,
  OBSERVABILITY_ENV,
  applySettings,
  collectorArchiveUrl,
  compareVersions,
  mergeObservabilitySettings,
  parseChecksum,
  requireClaudeVersion,
  setupPlan,
  startLgtm,
} = require('../bin/setup-observability.js');

test('requires Claude Code v2.1.212 or newer', () => {
  assert.equal(compareVersions('2.1.212', MIN_CLAUDE_VERSION), 0);
  assert.equal(compareVersions('2.1.213', MIN_CLAUDE_VERSION), 1);
  assert.equal(compareVersions('2.1.211', MIN_CLAUDE_VERSION), -1);
  assert.throws(() => requireClaudeVersion('2.1.211'), /2\.1\.212\+/);
});

test('merges safe local OTLP settings and wraps an existing status line', () => {
  const settings = mergeObservabilitySettings({
    env: { KEEP_ME: 'yes' },
    hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'existing-hook' }] }] },
    statusLine: { type: 'command', command: 'node custom-statusline.js', padding: 2 },
  }, { workbenchRoot: 'C:/Workbench' });

  assert.equal(settings.env.KEEP_ME, 'yes');
  assert.equal(settings.env.WORKBENCH_STATUSLINE_RENDER, 'node custom-statusline.js');
  assert.deepEqual(Object.fromEntries(Object.entries(settings.env).filter(([key]) => key in OBSERVABILITY_ENV)), OBSERVABILITY_ENV);
  assert.match(settings.statusLine.command, /workbench-statusline\.js/);
  assert.deepEqual(settings.hooks, { SessionEnd: [{ hooks: [{ type: 'command', command: 'existing-hook' }] }] });
});

test('does not replace a Workbench status line on repeat setup', () => {
  const settings = mergeObservabilitySettings({
    env: { WORKBENCH_STATUSLINE_RENDER: 'existing renderer' },
    statusLine: { type: 'command', command: 'node workbench-statusline.js', padding: 3 },
  });

  assert.equal(settings.statusLine.padding, 3);
  assert.equal(settings.env.WORKBENCH_STATUSLINE_RENDER, 'existing renderer');
});

test('preserves existing project settings when applying the setup', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-observability-'));
  try {
    const claudeDir = path.join(directory, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ permissions: { allow: ['Read'] } }));
    const result = applySettings(directory, { workbenchRoot: 'C:/Workbench' });
    assert.equal(result.settings.permissions.allow[0], 'Read');
    assert.match(result.settings.statusLine.command, /workbench-statusline\.js/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('uses a pinned platform collector archive and verifies release checksums', () => {
  assert.match(collectorArchiveUrl('win32', 'x64'), new RegExp(`v${COLLECTOR_VERSION}/otelcol-contrib_${COLLECTOR_VERSION}_windows_amd64\\.tar\\.gz$`));
  const checksum = 'a'.repeat(64);
  assert.equal(parseChecksum(`${checksum}  otelcol-contrib_${COLLECTOR_VERSION}_windows_amd64.tar.gz`, `otelcol-contrib_${COLLECTOR_VERSION}_windows_amd64.tar.gz`), checksum);
  assert.throws(() => parseChecksum('', 'missing.tar.gz'), /No SHA-256/);
});

test('plans current-user application data and only starts LGTM on request', () => {
  const plan = setupPlan({ projectDir: '.', environment: { LOCALAPPDATA: 'C:/Users/example/AppData/Local' } });
  assert.match(plan.dataDir, /Eigenwise[\\/]Workbench$/);
  assert.equal(plan.lgtm, false);
  const calls = [];
  const lgtm = startLgtm(plan.dataDir, { spawnSync(command, args) {
    calls.push([command, args]);
    return args[0] === 'inspect' ? { status: 1, stdout: '' } : { status: 0, stdout: 'container' };
  } });
  assert.equal(lgtm.image, LGTM_IMAGE);
  assert.deepEqual(calls[1][1].filter((argument) => argument.startsWith('127.0.0.1:')), ['127.0.0.1:3000:3000', '127.0.0.1:14318:4318']);
  const resumed = [];
  startLgtm(plan.dataDir, { spawnSync(command, args) { resumed.push([command, args]); return { status: 0, stdout: 'true' }; } });
  assert.equal(resumed.length, 1);
});
