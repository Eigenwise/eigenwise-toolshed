'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { settingsPath, writeSettings } = require('../lib/settings-wiring.js');
const { probeClaudeAlias, realClaudeRefusedUnderTest } = require('../lib/pins.js');

function insideTmp(file) {
  const relative = path.relative(fs.realpathSync.native(os.tmpdir()), fs.realpathSync.native(file));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// A path that is outside the temp directory on every machine, whatever directory
// the checkout lives in (a checkout under os.tmpdir() would make __dirname useless here).
const OUTSIDE_TMP = path.join(path.parse(os.tmpdir()).root, 'model-gateway-must-never-be-written');

test('the suite runs against a throwaway home, never the real one', () => {
  assert.ok(insideTmp(os.homedir()), `HOME is ${os.homedir()}, expected a temp dir; run the suite with npm test`);
  assert.ok(process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.startsWith(os.homedir()));
});

test('the user settings path resolves inside the throwaway home', () => {
  const file = settingsPath('user');
  assert.equal(file, path.join(os.homedir(), '.claude', 'settings.json'));
  assert.ok(insideTmp(path.dirname(path.dirname(file))));
});

test('the user settings path is refused when HOME leaks outside the temp directory', (t) => {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  t.after(() => Object.assign(process.env, saved));
  process.env.HOME = OUTSIDE_TMP;
  process.env.USERPROFILE = OUTSIDE_TMP;
  assert.throws(() => settingsPath('user'), /refusing to touch/);
  assert.equal(fs.existsSync(OUTSIDE_TMP), false, 'nothing was created on the refused path');
});

test('a settings write outside the temp directory is refused under the test runner', () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'this negative control only means something under node --test');
  const outside = path.join(OUTSIDE_TMP, '.claude', 'settings.json');
  assert.throws(() => writeSettings(outside, { env: { SHOULD_NOT: 'land' } }), /refusing to touch/);
  assert.equal(fs.existsSync(OUTSIDE_TMP), false, 'nothing was created on the refused path');
});

test('a settings write inside the temp directory still goes through', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-guard-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, '.claude', 'settings.json');
  writeSettings(file, { env: { OK: '1' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { env: { OK: '1' } });
});

test('the suite never points the pin probe at the real claude binary', () => {
  assert.ok(insideTmp(path.dirname(process.env.CODEX_GATEWAY_CLAUDE_BIN)), 'CODEX_GATEWAY_CLAUDE_BIN must be a throwaway path');
});

test('the pin probe refuses to launch the real claude under the test runner', (t) => {
  const saved = process.env.CODEX_GATEWAY_CLAUDE_BIN;
  t.after(() => { process.env.CODEX_GATEWAY_CLAUDE_BIN = saved; });
  assert.equal(realClaudeRefusedUnderTest(), false, 'a test that names its own fake claude may launch it');
  delete process.env.CODEX_GATEWAY_CLAUDE_BIN;
  assert.equal(realClaudeRefusedUnderTest(), true);
});

test('the alias probe resolves null without spawning when no fake claude is named', async (t) => {
  const saved = process.env.CODEX_GATEWAY_CLAUDE_BIN;
  t.after(() => { process.env.CODEX_GATEWAY_CLAUDE_BIN = saved; });
  delete process.env.CODEX_GATEWAY_CLAUDE_BIN;
  const started = Date.now();
  assert.equal(await probeClaudeAlias('sonnet', 'http://127.0.0.1:9'), null);
  assert.ok(Date.now() - started < 1000, 'the probe returned before any spawn timeout could fire');
});

// Negative control for both probe callbacks in one go: a child process with a real-looking
// `claude` first on PATH and no CODEX_GATEWAY_CLAUDE_BIN. If either claudeVersion() or
// probeClaudeAlias() still spawned, the fake binary would leave a marker file behind.
test('neither probe launches the claude on PATH under the test runner', (t) => {
  if (process.platform === 'win32') return t.skip('the fake claude is a POSIX shell script');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-guard-probe-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const marker = path.join(directory, 'claude-was-launched');
  const fakeClaude = path.join(directory, 'bin', 'claude');
  fs.mkdirSync(path.dirname(fakeClaude));
  fs.writeFileSync(fakeClaude, `#!/bin/sh\ntouch '${marker}'\necho 9.9.9\n`, { mode: 0o755 });
  const script = `
    const { refreshDetectedPins, probeClaudeAlias } = require(${JSON.stringify(require.resolve('../lib/pins.js'))});
    Promise.all([refreshDetectedPins({ force: true }), probeClaudeAlias('sonnet', 'http://127.0.0.1:9')])
      .then(([pins, alias]) => { console.log(JSON.stringify({ pins, alias })); });
  `;
  const { CODEX_GATEWAY_CLAUDE_BIN, ...environment } = process.env;
  const result = spawnSync(process.execPath, ['-e', script], {
    env: { ...environment, NODE_TEST_CONTEXT: 'child', PATH: `${path.dirname(fakeClaude)}${path.delimiter}${process.env.PATH}` },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(marker), false, 'the fake claude on PATH was launched');
  assert.deepEqual(JSON.parse(result.stdout.trim()), { pins: {}, alias: null });
});

test('a temp path that symlinks out of the temp directory is refused', (t) => {
  if (process.platform === 'win32') return t.skip('directory symlinks need privileges on Windows');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-guard-link-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.symlinkSync(__dirname, path.join(directory, '.claude'), 'dir');
  assert.throws(() => writeSettings(path.join(directory, '.claude', 'settings.json'), {}), /refusing to touch/);
  assert.equal(fs.existsSync(path.join(__dirname, 'settings.json')), false);
});
