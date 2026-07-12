'use strict';
/**
 * Runtime exec agent sync for Codex-backed tiers. syncExecAgents generates one
 * agent file per DISCOVERED Codex model x every non-max effort (low/medium/high/
 * xhigh), independent of the tier mapping AND the effort allowlist: the files
 * must exist on disk before a tier is pointed at a model, so Claude Code
 * registers them at session start and a later mapping change needs no restart.
 * The wanted set is therefore a pure function of the catalog.
 * Run: node --test "plugins/sidequest/test/**\/*.test.js"
 *
 * EVERY test passes an explicit `dir` (a temp directory) to syncExecAgents —
 * this suite must NEVER write to (or delete from) the real ~/.claude/agents.
 */
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
const LUNA = { slug: 'codex-gpt-5-6-luna', id: 'claude-codex-gpt-5.6-luna[1m]', label: 'GPT-5.6 Luna', suggestedTier: 'grade-1' };

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sq-agentsync-test-')); }
function readDir(dir) { return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).sort(); }

// Point discovery at a fresh catalog holding exactly `models`. Re-seeding swaps
// the on-disk catalog (discovery is not cached across calls, so the next sync
// sees the new state). clearCatalog() = codex-gateway not installed.
function seedCatalog(models) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-agentsync-catalog-'));
  fs.mkdirSync(path.join(dir, 'codex-gateway'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'codex-gateway', 'catalog.json'),
    JSON.stringify({ schema: 2, source: 'codex-gateway', updatedAt: new Date().toISOString(), models }));
  process.env.SIDEQUEST_DISCOVERY_DIRS = dir;
}
function clearCatalog() { process.env.SIDEQUEST_DISCOVERY_DIRS = NO_CATALOG_DIR; }

function builtInFiles() {
  return ['high', 'low', 'max', 'medium', 'xhigh'].map((e) => `sidequest-exec-${e}.md`).sort();
}

function customFiles(dir) {
  return readDir(dir).filter((f) => !builtInFiles().includes(f));
}

// The four non-max effort filenames a discovered model slug produces, sorted the
// way readDir sorts (high, low, medium, xhigh).
function fourFiles(slug, source) {
  const prefix = source ? `${source}-` : '';
  return ['high', 'low', 'medium', 'xhigh'].map((e) => `sidequest-exec-${prefix}${slug}-${e}.md`).sort();
}

/* -------------------------------------------------------------- *
 *  Filenames + frontmatter for a discovered model
 * -------------------------------------------------------------- */

test('one file per discovered model x every non-max effort, correct frontmatter', () => {
  seedCatalog([TERRA]);
  const dir = tmpDir();
  const res = agentsync.syncExecAgents({}, { dir });
  assert.strictEqual(res.written, 9);
  assert.deepStrictEqual(customFiles(dir), fourFiles('codex-gpt-5-6-terra'));

  const src = fs.readFileSync(path.join(dir, 'sidequest-exec-codex-gpt-5-6-terra-high.md'), 'utf8');
  const fmEnd = src.indexOf('\n---\n', 4);
  const frontmatter = src.slice(0, fmEnd);
  const body = src.slice(fmEnd + 5);
  // The frontmatter IS the dispatch contract: routed Codex work is spawned via
  // the native Agent tool by this exact name with the Agent `model` param
  // OMITTED, so the pinned model + bypass below are what actually runs.
  assert.match(frontmatter, /^name: sidequest-exec-codex-gpt-5-6-terra-high$/m);
  assert.match(frontmatter, /^effort: high$/m);
  assert.match(frontmatter, /^model: claude-codex-gpt-5\.6-terra\[1m\]$/m);
  assert.strictEqual((frontmatter.match(/^model:/gm) || []).length, 1, 'exactly one model pin');
  assert.match(frontmatter, /^permissionMode: bypassPermissions$/m);
  assert.ok(body.includes(agentsync.MARKER));
  assert.match(body, /codex-gpt-5-6-terra/);
});

test('max effort is never generated', () => {
  seedCatalog([TERRA]);
  const dir = tmpDir();
  agentsync.syncExecAgents({}, { dir });
  assert.ok(!customFiles(dir).includes('sidequest-exec-codex-gpt-5-6-terra-max.md'));
  assert.strictEqual(customFiles(dir).length, 4);
});

/* -------------------------------------------------------------- *
 *  Mapping- and effort-independence (the headline behavior)
 * -------------------------------------------------------------- */

test('a discovered-but-unmapped model still generates its files (no tier mapping needed)', () => {
  seedCatalog([SOL]);
  const dir = tmpDir();
  // Every tier on Claude — nothing points at SOL — yet its agents exist on disk,
  // ready for the moment a tier IS pointed at it.
  const prefs = { tierBackend: { haiku: 'claude', sonnet: 'claude', opus: 'claude', fable: 'claude' } };
  const res = agentsync.syncExecAgents(prefs, { dir });
  assert.strictEqual(res.written, 9);
  assert.deepStrictEqual(customFiles(dir), fourFiles('codex-gpt-5-6-sol'));
});

test('the effort allowlist does not change the generated files', () => {
  seedCatalog([TERRA]);
  const dir = tmpDir();
  const prefs = { efforts: { opus: { low: false, medium: false, high: true, xhigh: false, max: false } } };
  agentsync.syncExecAgents(prefs, { dir });
  // all four non-max efforts are present regardless of what the allowlist enables
  assert.deepStrictEqual(customFiles(dir), fourFiles('codex-gpt-5-6-terra'));
});

test('empty catalog still mirrors five built-in executors with bypass permissions', () => {
  clearCatalog();
  const dir = tmpDir();
  const res = agentsync.syncExecAgents({}, { dir });
  assert.strictEqual(res.written, 5);
  assert.deepStrictEqual(readDir(dir), builtInFiles());
  for (const file of builtInFiles()) {
    assert.match(fs.readFileSync(path.join(dir, file), 'utf8'), /^permissionMode: bypassPermissions$/m);
  }
});

/* -------------------------------------------------------------- *
 *  Idempotency + catalog-change cleanup
 * -------------------------------------------------------------- */

test('re-running with the same catalog writes nothing new (idempotent)', () => {
  seedCatalog([TERRA]);
  const dir = tmpDir();
  assert.strictEqual(agentsync.syncExecAgents({}, { dir }).written, 9);
  const second = agentsync.syncExecAgents({}, { dir });
  assert.strictEqual(second.written, 0);
  assert.strictEqual(second.unchanged, 9);
});

test('a model dropped from the catalog has its files removed', () => {
  seedCatalog([TERRA, SOL]);
  const dir = tmpDir();
  agentsync.syncExecAgents({}, { dir });
  assert.strictEqual(customFiles(dir).length, 8);
  seedCatalog([TERRA]); // SOL vanished from the catalog
  const second = agentsync.syncExecAgents({}, { dir });
  assert.strictEqual(second.removed, 4);
  assert.deepStrictEqual(customFiles(dir), fourFiles('codex-gpt-5-6-terra'));
});

test('swapping the catalog swaps the files', () => {
  seedCatalog([TERRA]);
  const dir = tmpDir();
  agentsync.syncExecAgents({}, { dir });
  assert.deepStrictEqual(customFiles(dir), fourFiles('codex-gpt-5-6-terra'));
  seedCatalog([SOL]);
  const second = agentsync.syncExecAgents({}, { dir });
  assert.strictEqual(second.removed, 4);
  assert.strictEqual(second.written, 4);
  assert.deepStrictEqual(customFiles(dir), fourFiles('codex-gpt-5-6-sol'));
});

/* -------------------------------------------------------------- *
 *  Never touches an unmarked file
 * -------------------------------------------------------------- */

test('never overwrites a hand-authored file at a would-be-generated path', () => {
  seedCatalog([TERRA]);
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  const collidingPath = path.join(dir, 'sidequest-exec-codex-gpt-5-6-terra-high.md');
  const handAuthored = '---\nname: sidequest-exec-codex-gpt-5-6-terra-high\n---\nhand-authored, not ours.\n';
  fs.writeFileSync(collidingPath, handAuthored);
  const res = agentsync.syncExecAgents({}, { dir });
  assert.strictEqual(res.written, 8); // five built-ins plus the other three custom efforts
  assert.strictEqual(fs.readFileSync(collidingPath, 'utf8'), handAuthored);
});

test('never deletes a hand-authored file that is not in the wanted set', () => {
  clearCatalog();
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  const foreignPath = path.join(dir, 'sidequest-exec-totally-unrelated-high.md');
  const handAuthored = '---\nname: totally-unrelated\n---\nnot ours, no marker.\n';
  fs.writeFileSync(foreignPath, handAuthored);
  const res = agentsync.syncExecAgents({}, { dir });
  assert.strictEqual(res.removed, 0);
  assert.ok(fs.existsSync(foreignPath));
});

/* -------------------------------------------------------------- *
 *  Multiple discovered models at once
 * -------------------------------------------------------------- */

test('multiple discovered models each get their four files', () => {
  seedCatalog([TERRA, SOL, LUNA]);
  const dir = tmpDir();
  const res = agentsync.syncExecAgents({}, { dir });
  assert.strictEqual(res.written, 17);
  assert.deepStrictEqual(customFiles(dir), [
    ...fourFiles('codex-gpt-5-6-luna'),
    ...fourFiles('codex-gpt-5-6-sol'),
    ...fourFiles('codex-gpt-5-6-terra'),
  ].sort());
});

test('same slug from different sources gets source-namespaced agent files', () => {
  const source = { source: 'other-gateway', relPath: path.join('other-gateway', 'catalog.json') };
  const discovery = require('../lib/discovery.js');
  discovery.CATALOG_SOURCES.push(source);
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-agentsync-collision-'));
    const catalog = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-agentsync-collision-catalog-'));
    fs.mkdirSync(path.join(catalog, 'codex-gateway'), { recursive: true });
    fs.mkdirSync(path.join(catalog, source.source), { recursive: true });
    fs.writeFileSync(path.join(catalog, 'codex-gateway', 'catalog.json'), JSON.stringify({ models: [{ slug: 'shared-model', id: 'claude-primary', label: 'Primary' }] }));
    fs.writeFileSync(path.join(catalog, source.source, 'catalog.json'), JSON.stringify({ models: [{ slug: 'shared-model', id: 'claude-secondary', label: 'Secondary' }] }));
    process.env.SIDEQUEST_DISCOVERY_DIRS = catalog;
    agentsync.syncExecAgents({}, { dir });
    assert.deepStrictEqual(customFiles(dir), [
      ...fourFiles('shared-model', 'codex-gateway'),
      ...fourFiles('shared-model', source.source),
    ].sort());
  } finally {
    discovery.CATALOG_SOURCES.pop();
    clearCatalog();
  }
});

test('temporary native agent names itself after the resolved runtime (Codex slug), no hex nonce', () => {
  const dir = tmpDir();
  const created = agentsync.createNativeAgent({
    ref: 'SQ-198', runtime: 'codex-gpt-5-6-luna', modelId: 'claude-codex-gpt-5.6-luna[1m]',
    effort: 'medium', grade: 'grade-1', sessionId: 'session-198', tools: ['Read', 'Bash', 'SendMessage'],
  }, { dir, waitMs: 0 });
  // The runtime shows in the card; the noisy "codex-" catalog prefix is dropped
  // and there is no meaningless hex suffix.
  assert.strictEqual(created.name, 'sidequest-native-sq-198-gpt-5-6-luna');
  assert.ok(created.name.startsWith(agentsync.TEMP_PREFIX)); // still discoverable for cleanup
  assert.ok(!/-[0-9a-f]{8}$/.test(created.name)); // no hex nonce tail
  assert.deepStrictEqual(created.spawn, { subagent_type: created.name, name: created.name, mode: 'bypassPermissions' });
  const source = fs.readFileSync(created.file, 'utf8');
  assert.match(source, /^model: claude-codex-gpt-5\.6-luna\[1m\]$/m);
  assert.match(source, /^effort: medium$/m);
  assert.match(source, /^tools: Read, Bash, SendMessage$/m);
  assert.match(source, /^permissionMode: bypassPermissions$/m);
  assert.ok(source.includes(agentsync.TEMP_MARKER));
  assert.ok(source.includes('sidequest-native-grade: grade-1')); // routing id stays neutral
  assert.strictEqual(agentsync.cleanupNativeAgents({ name: created.name, dir }).removed, 1);
  assert.ok(!fs.existsSync(created.file));
});

test('a Claude-backed tier embeds its runtime alias in the name', () => {
  const dir = tmpDir();
  const created = agentsync.createNativeAgent({
    ref: 'SQ-7', runtime: 'opus', modelId: 'opus',
    effort: 'high', grade: 'grade-3', sessionId: 'session-7',
  }, { dir, waitMs: 0 });
  assert.strictEqual(created.name, 'sidequest-native-sq-7-opus');
});

test('same ref + same runtime collides safely: a nonce is appended, prefix cleanup still gets both', () => {
  const dir = tmpDir();
  const first = agentsync.createNativeAgent({
    ref: 'SQ-198', runtime: 'codex-gpt-5-6-luna', modelId: 'claude-codex-gpt-5.6-luna[1m]',
    effort: 'medium', grade: 'grade-1', sessionId: 'session-198',
  }, { dir, waitMs: 0 });
  const second = agentsync.createNativeAgent({
    ref: 'SQ-198', runtime: 'codex-gpt-5-6-luna', modelId: 'claude-codex-gpt-5.6-luna[1m]',
    effort: 'medium', grade: 'grade-1', sessionId: 'session-198',
  }, { dir, waitMs: 0 });
  assert.strictEqual(first.name, 'sidequest-native-sq-198-gpt-5-6-luna');
  assert.notStrictEqual(second.name, first.name); // unique
  assert.match(second.name, /^sidequest-native-sq-198-gpt-5-6-luna-[0-9a-f]{6,32}$/); // runtime kept, nonce appended
  assert.ok(fs.existsSync(first.file) && fs.existsSync(second.file));
  // Both are still TEMP_PREFIX-prefixed, so a by-session (prefix-scanning) cleanup takes both.
  assert.strictEqual(agentsync.cleanupNativeAgents({ sessionId: 'session-198', dir }).removed, 2);
  assert.ok(!fs.existsSync(first.file) && !fs.existsSync(second.file));
});

test('an explicit nonce is still honored (deterministic) and follows the runtime token', () => {
  const dir = tmpDir();
  const created = agentsync.createNativeAgent({
    ref: 'SQ-42', runtime: 'codex-gpt-5-6-terra', nonce: 'abcdef12', modelId: 'claude-codex-gpt-5.6-terra[1m]',
    effort: 'medium', grade: 'grade-3', sessionId: 'session-42',
  }, { dir, waitMs: 0 });
  assert.strictEqual(created.name, 'sidequest-native-sq-42-gpt-5-6-terra-abcdef12');
});

test('temporary native agent cleanup respects session boundaries and recovers stale files', () => {
  const dir = tmpDir();
  const a = agentsync.createNativeAgent({ ref: 'SQ-1', nonce: 'abcdef12', modelId: 'claude-a', effort: 'low', grade: 'grade-1', sessionId: 'one' }, { dir, waitMs: 0 });
  const b = agentsync.createNativeAgent({ ref: 'SQ-2', nonce: 'abcdef34', modelId: 'claude-b', effort: 'high', grade: 'grade-2', sessionId: 'two' }, { dir, waitMs: 0 });
  assert.strictEqual(agentsync.cleanupNativeAgents({ sessionId: 'one', dir }).removed, 1);
  assert.ok(!fs.existsSync(a.file));
  assert.ok(fs.existsSync(b.file));
  assert.strictEqual(agentsync.cleanupNativeAgents({ dir, staleBefore: Date.now() + 1000 }).removed, 1);
  assert.ok(!fs.existsSync(b.file));
});

test('defaultAgentsDir: SIDEQUEST_HOME redirects to <home>/agents, never the real dir (SQ-170)', () => {
  const realDir = path.join(os.homedir(), '.claude', 'agents');
  const savedHome = process.env.SIDEQUEST_HOME;
  const savedExplicit = process.env.SIDEQUEST_AGENTS_DIR;
  try {
    delete process.env.SIDEQUEST_AGENTS_DIR;
    const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-agentdir-'));
    process.env.SIDEQUEST_HOME = testHome;
    assert.strictEqual(agentsync.defaultAgentsDir(), path.join(testHome, 'agents'));
    assert.notStrictEqual(agentsync.defaultAgentsDir(), realDir);
    // explicit override wins over the home redirect
    process.env.SIDEQUEST_AGENTS_DIR = path.join(testHome, 'explicit');
    assert.strictEqual(agentsync.defaultAgentsDir(), path.join(testHome, 'explicit'));
  } finally {
    if (savedHome === undefined) delete process.env.SIDEQUEST_HOME; else process.env.SIDEQUEST_HOME = savedHome;
    if (savedExplicit === undefined) delete process.env.SIDEQUEST_AGENTS_DIR; else process.env.SIDEQUEST_AGENTS_DIR = savedExplicit;
  }
});
