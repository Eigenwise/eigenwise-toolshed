'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-agentsync-home-'));
const NO_CATALOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-agentsync-nodisc-'));
process.env.SIDEQUEST_DISCOVERY_DIRS = NO_CATALOG_DIR;

const agentsync = require('../lib/agentsync.js');

const TERRA = { slug: 'codex-gpt-5-6-terra', id: 'claude-codex-gpt-5.6-terra[1m]', label: 'GPT-5.6 Terra', suggestedTier: 'grade-3' };
const SOL = { slug: 'codex-gpt-5-6-sol', id: 'claude-codex-gpt-5.6-sol[1m]', label: 'GPT-5.6 Sol', suggestedTier: 'grade-4' };

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sq-agentsync-test-')); }
function readDir(dir) { return fs.readdirSync(dir).filter((file) => file.endsWith('.md')).sort(); }
function seedCatalog(models) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-agentsync-catalog-'));
  fs.mkdirSync(path.join(dir, 'codex-gateway'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'codex-gateway', 'catalog.json'), JSON.stringify({ source: 'codex-gateway', models }));
  process.env.SIDEQUEST_DISCOVERY_DIRS = dir;
}
function clearCatalog() { process.env.SIDEQUEST_DISCOVERY_DIRS = NO_CATALOG_DIR; }
function terraPrefs(overrides) {
  return Object.assign({
    tierBackend: { haiku: 'claude', sonnet: 'claude', opus: 'codex-gpt-5-6-terra', fable: 'claude' },
  }, overrides);
}
function genericFiles(efforts) {
  return efforts.map((effort) => `sidequest-exec-${effort}.md`);
}

test('sync writes the deduped image of reachable ladder executors', () => {
  seedCatalog([TERRA, SOL]);
  const dir = tmpDir();
  const prefs = terraPrefs({ efforts: { 'grade-3': { low: false, medium: true, high: true, xhigh: false, max: false } } });

  const result = agentsync.syncExecAgents(prefs, { dir });
  assert.strictEqual(result.written, 6);
  assert.deepStrictEqual(readDir(dir), [
    ...genericFiles(['high', 'low', 'max', 'medium', 'xhigh']),
    'sidequest-exec-codex-gpt-5-6-terra-high.md',
  ].sort());
  const source = fs.readFileSync(path.join(dir, 'sidequest-exec-codex-gpt-5-6-terra-high.md'), 'utf8');
  assert.match(source, /^model: claude-codex-gpt-5\.6-terra\[1m\]$/m);
  assert.match(source, /^permissionMode: bypassPermissions$/m);
  assert.ok(source.includes(agentsync.MARKER));
});

test('missing prefs and disabled routing retain five generic executors', () => {
  seedCatalog([TERRA]);
  for (const prefs of [undefined, { routing: false }]) {
    const dir = tmpDir();
    const result = agentsync.syncExecAgents(prefs, { dir });
    assert.strictEqual(result.written, 5);
    assert.deepStrictEqual(readDir(dir), genericFiles(['high', 'low', 'max', 'medium', 'xhigh']).sort());
  }
});

test('a max ladder rung generates max only when reachable', () => {
  seedCatalog([TERRA]);
  const dir = tmpDir();
  const prefs = terraPrefs({ efforts: { 'grade-3': { low: false, medium: false, high: false, xhigh: false, max: true } } });

  agentsync.syncExecAgents(prefs, { dir });
  assert.ok(readDir(dir).includes('sidequest-exec-codex-gpt-5-6-terra-max.md'));
});

test('a remap removes stale marked agents and keeps unmarked files', () => {
  seedCatalog([TERRA, SOL]);
  const dir = tmpDir();
  const terra = terraPrefs({ efforts: { 'grade-3': { low: false, medium: true, high: false, xhigh: false, max: false } } });
  agentsync.syncExecAgents(terra, { dir });
  const stale = path.join(dir, 'sidequest-exec-codex-gpt-5-6-terra-medium.md');
  const foreign = path.join(dir, 'sidequest-exec-user-high.md');
  fs.writeFileSync(foreign, '---\nname: user\n---\nunmarked\n');

  const sol = {
    tierBackend: { haiku: 'claude', sonnet: 'claude', opus: 'claude', fable: 'codex-gpt-5-6-sol' },
    efforts: { 'grade-4': { low: false, medium: false, high: true, xhigh: false, max: false } },
  };
  const result = agentsync.syncExecAgents(sol, { dir });
  assert.ok(result.removed >= 1);
  assert.ok(!fs.existsSync(stale));
  assert.ok(fs.existsSync(foreign));
  assert.ok(readDir(dir).includes('sidequest-exec-codex-gpt-5-6-sol-high.md'));
});

test('sync is idempotent for unchanged preferences', () => {
  seedCatalog([TERRA]);
  const dir = tmpDir();
  const prefs = terraPrefs();
  agentsync.syncExecAgents(prefs, { dir });
  const second = agentsync.syncExecAgents(prefs, { dir });
  assert.strictEqual(second.written, 0);
  assert.ok(second.unchanged > 0);
});

test('never overwrites an unmarked colliding executor file', () => {
  seedCatalog([TERRA]);
  const dir = tmpDir();
  const file = path.join(dir, 'sidequest-exec-codex-gpt-5-6-terra-medium.md');
  fs.writeFileSync(file, '---\nname: hand-authored\n---\n');
  agentsync.syncExecAgents(terraPrefs(), { dir });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '---\nname: hand-authored\n---\n');
});

test('native dispatch fallback does not write a temporary agent file', () => {
  const dir = tmpDir();
  const created = agentsync.createNativeAgent({
    ref: 'SQ-249', agentType: 'sidequest-exec-codex-gpt-5-6-terra-medium',
    runtime: 'codex-gpt-5-6-terra', effort: 'medium', grade: 'grade-3', sessionId: 'session-249',
  }, { dir, waitMs: 0 });
  assert.strictEqual(created.fallback, true);
  assert.strictEqual(created.file, null);
  assert.deepStrictEqual(readDir(dir), []);
});
