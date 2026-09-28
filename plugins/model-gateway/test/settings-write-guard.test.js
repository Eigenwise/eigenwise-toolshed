'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { writeSettings } = require('../lib/settings-wiring.js');

function insideTmp(file) {
  const relative = path.relative(fs.realpathSync.native(os.tmpdir()), fs.realpathSync.native(file));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

test('the suite runs against a throwaway home, never the real one', () => {
  assert.ok(insideTmp(os.homedir()), `HOME is ${os.homedir()}, expected a temp dir; run the suite with npm test`);
  assert.ok(process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.startsWith(os.homedir()));
});

test('a settings write outside the temp directory is refused under the test runner', () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'this negative control only means something under node --test');
  const outside = path.join(__dirname, 'must-never-be-written', '.claude', 'settings.json');
  assert.throws(() => writeSettings(outside, { env: { SHOULD_NOT: 'land' } }), /refusing to touch/);
  assert.equal(fs.existsSync(path.dirname(path.dirname(outside))), false, 'nothing was created on the refused path');
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

test('the pin probe refuses to launch the real claude under the test runner', async (t) => {
  const saved = process.env.CODEX_GATEWAY_CLAUDE_BIN;
  t.after(() => { process.env.CODEX_GATEWAY_CLAUDE_BIN = saved; });
  delete process.env.CODEX_GATEWAY_CLAUDE_BIN;
  const { realClaudeRefusedUnderTest } = require('../lib/pins.js');
  assert.equal(realClaudeRefusedUnderTest(), true);
});

test('a temp path that symlinks out of the temp directory is refused', (t) => {
  if (process.platform === 'win32') return t.skip('directory symlinks need privileges on Windows');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-gateway-guard-link-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.symlinkSync(__dirname, path.join(directory, '.claude'), 'dir');
  assert.throws(() => writeSettings(path.join(directory, '.claude', 'settings.json'), {}), /refusing to touch/);
  assert.equal(fs.existsSync(path.join(__dirname, 'settings.json')), false);
});
