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

const TERRA = { slug: 'codex-gpt-5-6-terra', id: 'claude-codex-gpt-5.6-terra[1m]', label: 'GPT-5.6 Terra', suggestedTier: 'opus' };
const SOL = { slug: 'codex-gpt-5-6-sol', id: 'claude-codex-gpt-5.6-sol[1m]', label: 'GPT-5.6 Sol', suggestedTier: 'fable' };
const LUNA = { slug: 'codex-gpt-5-6-luna', id: 'claude-codex-gpt-5.6-luna[1m]', label: 'GPT-5.6 Luna', suggestedTier: 'haiku' };

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

// The four non-max effort filenames a discovered model slug produces, sorted the
// way readDir sorts (high, low, medium, xhigh).
function fourFiles(slug) {
  return ['high', 'low', 'medium', 'xhigh'].map((e) => `sidequest-exec-${slug}-${e}.md`).sort();
}

/* -------------------------------------------------------------- *
 *  Filenames + frontmatter for a discovered model
 * -------------------------------------------------------------- */

test('one file per discovered model x every non-max effort, correct frontmatter', () => {
  seedCatalog([TERRA]);
  const dir = tmpDir();
  const res = agentsync.syncExecAgents({}, { dir });
  assert.strictEqual(res.written, 4);
  assert.deepStrictEqual(readDir(dir), fourFiles('codex-gpt-5-6-terra'));

  const src = fs.readFileSync(path.join(dir, 'sidequest-exec-codex-gpt-5-6-terra-high.md'), 'utf8');
  const fmEnd = src.indexOf('\n---\n', 4);
  const frontmatter = src.slice(0, fmEnd);
  const body = src.slice(fmEnd + 5);
  assert.match(frontmatter, /^name: sidequest-exec-codex-gpt-5-6-terra-high$/m);
  assert.match(frontmatter, /^effort: high$/m);
  assert.match(frontmatter, /^model: claude-codex-gpt-5\.6-terra\[1m\]$/m);
  assert.ok(body.includes(agentsync.MARKER));
  assert.match(body, /codex-gpt-5-6-terra/);
});

test('max effort is never generated', () => {
  seedCatalog([TERRA]);
  const dir = tmpDir();
  agentsync.syncExecAgents({}, { dir });
  assert.ok(!readDir(dir).includes('sidequest-exec-codex-gpt-5-6-terra-max.md'));
  assert.strictEqual(readDir(dir).length, 4);
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
  assert.strictEqual(res.written, 4);
  assert.deepStrictEqual(readDir(dir), fourFiles('codex-gpt-5-6-sol'));
});

test('the effort allowlist does not change the generated files', () => {
  seedCatalog([TERRA]);
  const dir = tmpDir();
  const prefs = { efforts: { opus: { low: false, medium: false, high: true, xhigh: false, max: false } } };
  agentsync.syncExecAgents(prefs, { dir });
  // all four non-max efforts are present regardless of what the allowlist enables
  assert.deepStrictEqual(readDir(dir), fourFiles('codex-gpt-5-6-terra'));
});

test('empty catalog (codex-gateway not installed) -> nothing generated', () => {
  clearCatalog();
  const dir = tmpDir();
  const res = agentsync.syncExecAgents({}, { dir });
  assert.strictEqual(res.written, 0);
  assert.deepStrictEqual(readDir(dir), []);
});

/* -------------------------------------------------------------- *
 *  Idempotency + catalog-change cleanup
 * -------------------------------------------------------------- */

test('re-running with the same catalog writes nothing new (idempotent)', () => {
  seedCatalog([TERRA]);
  const dir = tmpDir();
  assert.strictEqual(agentsync.syncExecAgents({}, { dir }).written, 4);
  const second = agentsync.syncExecAgents({}, { dir });
  assert.strictEqual(second.written, 0);
  assert.strictEqual(second.unchanged, 4);
});

test('a model dropped from the catalog has its files removed', () => {
  seedCatalog([TERRA, SOL]);
  const dir = tmpDir();
  agentsync.syncExecAgents({}, { dir });
  assert.strictEqual(readDir(dir).length, 8);
  seedCatalog([TERRA]); // SOL vanished from the catalog
  const second = agentsync.syncExecAgents({}, { dir });
  assert.strictEqual(second.removed, 4);
  assert.deepStrictEqual(readDir(dir), fourFiles('codex-gpt-5-6-terra'));
});

test('swapping the catalog swaps the files', () => {
  seedCatalog([TERRA]);
  const dir = tmpDir();
  agentsync.syncExecAgents({}, { dir });
  assert.deepStrictEqual(readDir(dir), fourFiles('codex-gpt-5-6-terra'));
  seedCatalog([SOL]);
  const second = agentsync.syncExecAgents({}, { dir });
  assert.strictEqual(second.removed, 4);
  assert.strictEqual(second.written, 4);
  assert.deepStrictEqual(readDir(dir), fourFiles('codex-gpt-5-6-sol'));
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
  assert.strictEqual(res.written, 3); // the other three efforts; the collider is left alone
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
  assert.strictEqual(res.written, 12);
  assert.deepStrictEqual(readDir(dir), [
    ...fourFiles('codex-gpt-5-6-luna'),
    ...fourFiles('codex-gpt-5-6-sol'),
    ...fourFiles('codex-gpt-5-6-terra'),
  ].sort());
});

/* -------------------------------------------------------------- *
 *  defaultAgentsDir never targets the real ~/.claude/agents under a test home
 * -------------------------------------------------------------- */

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
