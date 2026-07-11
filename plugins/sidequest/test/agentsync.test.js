'use strict';
/**
 * Runtime exec agent sync for Codex-backed tiers (1.36.0). syncExecAgents
 * generates one agent file per (Codex-backed tier x that tier's enabled non-max
 * effort). Driven by prefs.tierBackend + the discovered catalog.
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
const store = require('../lib/store.js');

const TERRA = { slug: 'codex-gpt-5-6-terra', id: 'claude-codex-gpt-5.6-terra[1m]', label: 'GPT-5.6 Terra', suggestedTier: 'opus' };
const SOL = { slug: 'codex-gpt-5-6-sol', id: 'claude-codex-gpt-5.6-sol[1m]', label: 'GPT-5.6 Sol', suggestedTier: 'fable' };
const LUNA = { slug: 'codex-gpt-5-6-luna', id: 'claude-codex-gpt-5.6-luna[1m]', label: 'GPT-5.6 Luna', suggestedTier: 'haiku' };

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sq-agentsync-test-')); }
function readDir(dir) { return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).sort(); }

function seedCatalog(models) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-agentsync-catalog-'));
  fs.mkdirSync(path.join(dir, 'codex-gateway'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'codex-gateway', 'catalog.json'),
    JSON.stringify({ schema: 2, source: 'codex-gateway', updatedAt: new Date().toISOString(), models }));
  process.env.SIDEQUEST_DISCOVERY_DIRS = dir;
}

// Build a prefs with a given tierBackend map + a per-tier effort matrix. Always
// sends a FULL 4-tier map (unspecified tiers -> claude) so a mapping set by an
// earlier test in this shared home can't leak in. `efforts` maps tier -> list of
// enabled efforts.
function prefsWith(tierBackend, efforts) {
  const full = { haiku: 'claude', sonnet: 'claude', opus: 'claude', fable: 'claude' };
  const p = store.setModelPrefs({ tierBackend: Object.assign(full, tierBackend) });
  if (efforts) {
    p.efforts = p.efforts || {};
    for (const tier of Object.keys(efforts)) {
      const row = {};
      for (const e of ['low', 'medium', 'high', 'xhigh', 'max']) row[e] = efforts[tier].includes(e);
      p.efforts[tier] = row;
    }
  }
  return p;
}

/* -------------------------------------------------------------- *
 *  Filenames + frontmatter for a Codex-backed tier
 * -------------------------------------------------------------- */

test('one file per Codex-backed tier x that tier\'s enabled non-max effort, correct frontmatter', () => {
  seedCatalog([TERRA]);
  const dir = tmpDir();
  const prefs = prefsWith({ opus: TERRA.slug }, { opus: ['high', 'xhigh'] });
  const res = agentsync.syncExecAgents(prefs, { dir });
  assert.strictEqual(res.written, 2);
  assert.deepStrictEqual(readDir(dir), ['sidequest-exec-codex-gpt-5-6-terra-high.md', 'sidequest-exec-codex-gpt-5-6-terra-xhigh.md']);

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

test('max effort is never generated even if the tier enables it', () => {
  seedCatalog([TERRA]);
  const dir = tmpDir();
  const prefs = prefsWith({ opus: TERRA.slug }, { opus: ['high', 'max'] });
  const res = agentsync.syncExecAgents(prefs, { dir });
  assert.strictEqual(res.written, 1);
  assert.deepStrictEqual(readDir(dir), ['sidequest-exec-codex-gpt-5-6-terra-high.md']);
});

test('a Codex-backed haiku tier gets a single fixed-effort file', () => {
  seedCatalog([LUNA]);
  const dir = tmpDir();
  const prefs = prefsWith({ haiku: LUNA.slug });
  const res = agentsync.syncExecAgents(prefs, { dir });
  assert.strictEqual(res.written, 1);
  assert.deepStrictEqual(readDir(dir), ['sidequest-exec-codex-gpt-5-6-luna-medium.md']);
});

test('no Codex-backed tier -> nothing generated', () => {
  seedCatalog([TERRA]);
  const dir = tmpDir();
  const prefs = prefsWith({}); // every tier claude
  const res = agentsync.syncExecAgents(prefs, { dir });
  assert.strictEqual(res.written, 0);
  assert.deepStrictEqual(readDir(dir), []);
});

/* -------------------------------------------------------------- *
 *  Idempotency + reassignment cleanup
 * -------------------------------------------------------------- */

test('re-running with the same prefs writes nothing new (idempotent)', () => {
  seedCatalog([TERRA]);
  const dir = tmpDir();
  const prefs = prefsWith({ opus: TERRA.slug }, { opus: ['low', 'high'] });
  assert.strictEqual(agentsync.syncExecAgents(prefs, { dir }).written, 2);
  const second = agentsync.syncExecAgents(prefs, { dir });
  assert.strictEqual(second.written, 0);
  assert.strictEqual(second.unchanged, 2);
});

test('turning off one of a tier\'s efforts removes just that file', () => {
  seedCatalog([TERRA]);
  const dir = tmpDir();
  agentsync.syncExecAgents(prefsWith({ opus: TERRA.slug }, { opus: ['high', 'xhigh'] }), { dir });
  assert.deepStrictEqual(readDir(dir), ['sidequest-exec-codex-gpt-5-6-terra-high.md', 'sidequest-exec-codex-gpt-5-6-terra-xhigh.md']);
  const second = agentsync.syncExecAgents(prefsWith({ opus: TERRA.slug }, { opus: ['high'] }), { dir });
  assert.strictEqual(second.removed, 1);
  assert.strictEqual(second.unchanged, 1);
  assert.deepStrictEqual(readDir(dir), ['sidequest-exec-codex-gpt-5-6-terra-high.md']);
});

test('clearing a tier back to Claude removes all its generated files', () => {
  seedCatalog([TERRA]);
  const dir = tmpDir();
  agentsync.syncExecAgents(prefsWith({ opus: TERRA.slug }, { opus: ['low', 'high', 'xhigh'] }), { dir });
  assert.strictEqual(readDir(dir).length, 3);
  const second = agentsync.syncExecAgents(prefsWith({ opus: 'claude' }), { dir });
  assert.strictEqual(second.removed, 3);
  assert.deepStrictEqual(readDir(dir), []);
});

test('reassigning a tier to a different model swaps the files', () => {
  seedCatalog([TERRA, SOL]);
  const dir = tmpDir();
  agentsync.syncExecAgents(prefsWith({ opus: TERRA.slug }, { opus: ['high'] }), { dir });
  assert.deepStrictEqual(readDir(dir), ['sidequest-exec-codex-gpt-5-6-terra-high.md']);
  const second = agentsync.syncExecAgents(prefsWith({ opus: SOL.slug }, { opus: ['high'] }), { dir });
  assert.strictEqual(second.removed, 1);
  assert.strictEqual(second.written, 1);
  assert.deepStrictEqual(readDir(dir), ['sidequest-exec-codex-gpt-5-6-sol-high.md']);
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
  const res = agentsync.syncExecAgents(prefsWith({ opus: TERRA.slug }, { opus: ['high'] }), { dir });
  assert.strictEqual(res.written, 0);
  assert.strictEqual(fs.readFileSync(collidingPath, 'utf8'), handAuthored);
});

test('never deletes a hand-authored file that is not in the wanted set', () => {
  seedCatalog([TERRA]);
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  const foreignPath = path.join(dir, 'sidequest-exec-totally-unrelated-high.md');
  const handAuthored = '---\nname: totally-unrelated\n---\nnot ours, no marker.\n';
  fs.writeFileSync(foreignPath, handAuthored);
  const res = agentsync.syncExecAgents(prefsWith({}), { dir });
  assert.strictEqual(res.removed, 0);
  assert.ok(fs.existsSync(foreignPath));
});

/* -------------------------------------------------------------- *
 *  Multiple Codex-backed tiers at once
 * -------------------------------------------------------------- */

test('multiple Codex-backed tiers each get their own files', () => {
  seedCatalog([TERRA, SOL, LUNA]);
  const dir = tmpDir();
  const prefs = prefsWith(
    { opus: TERRA.slug, fable: SOL.slug, haiku: LUNA.slug },
    { opus: ['high'], fable: ['high'] },
  );
  const res = agentsync.syncExecAgents(prefs, { dir });
  assert.strictEqual(res.written, 3); // opus·high + fable·high + haiku(medium)
  assert.deepStrictEqual(readDir(dir), [
    'sidequest-exec-codex-gpt-5-6-luna-medium.md',
    'sidequest-exec-codex-gpt-5-6-sol-high.md',
    'sidequest-exec-codex-gpt-5-6-terra-high.md',
  ]);
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
    // this whole suite sets SIDEQUEST_HOME at load; assert the redirect holds
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
