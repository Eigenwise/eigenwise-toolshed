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

const TERRA = { slug: 'codex-gpt-5-6-terra', id: 'claude-codex-gpt-5.6-terra[1m]', label: 'GPT-5.6 Terra' };
const SOL = { slug: 'codex-gpt-5-6-sol', id: 'claude-codex-gpt-5.6-sol[1m]', label: 'GPT-5.6 Sol' };
const PROJECT_ONLY = { slug: 'codex-gpt-5-6-project-only', id: 'claude-codex-gpt-5.6-project-only[1m]', label: 'GPT-5.6 Project Only' };

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const STABLE_EXECUTORS = EFFORTS.flatMap((effort) => [
  `sidequest-exec-dispatch-${effort}.md`,
  `sidequest-exec-${effort}.md`,
]).sort();

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sq-agentsync-test-')); }
function readDir(dir) { return fs.readdirSync(dir).filter((file) => file.endsWith('.md')).sort(); }
function seedCatalog(models) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-agentsync-catalog-'));
  fs.mkdirSync(path.join(dir, 'codex-gateway'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'codex-gateway', 'catalog.json'), JSON.stringify({ schemaVersion: 3, source: 'codex-gateway', models }));
  process.env.SIDEQUEST_DISCOVERY_DIRS = dir;
}
function clearCatalog() { process.env.SIDEQUEST_DISCOVERY_DIRS = NO_CATALOG_DIR; }
function configure(store, id, route, fallback) {
  store.setCategory({ id, name: id, route, fallback: fallback || null, enabled: true });
}

test('SQ-404: dispatch comments stay bounded while preserving a handoff cue', () => {
  const digest = agentsync.ticketCommentsDigest([
    { by: 'investigator', body: `Decision: use the durable thread. ${'x'.repeat(5481)}` },
    { by: 'reviewer', kind: 'question', body: 'Integration risk: confirm the handoff before cherry-picking.' },
    { by: 'worker', body: 'Verification: node --test plugins/sidequest/test/*.test.js passed.' },
    { by: 'worker', body: 'Changed paths: plugins/sidequest/lib/agentsync.js.' },
    { by: 'older-worker', body: 'Older context.' },
  ]);
  assert.ok(digest.length <= agentsync.COMMENT_DIGEST_MAX_CHARS, 'the executor prompt cannot absorb the full thread');
  assert.match(digest, /read the full thread/i);
  assert.match(digest, /Integration risk/);
  assert.doesNotMatch(digest, /x{1000}/);
});

test('generation-two marker cannot be mistaken for the legacy marker', () => {
  assert.ok(!agentsync.MARKER.includes(agentsync.LEGACY_MARKER));
});

test('spawn descriptions are bounded and retain Codex route labels', () => {
  const title = 'Make Sidequest own executor card labels '.repeat(4);
  const codex = agentsync.spawnDescription({ title }, { backend: 'codex', runsLabel: TERRA.label });
  assert.ok(codex.length <= 80);
  assert.match(codex, /\(GPT-5\.6 Terra\)$/);
  assert.equal(agentsync.spawnDescription({ title: 'Claude title' }, { backend: 'claude', runsLabel: 'Fable' }), 'Claude title');
});

test('sync protects generation-two executors from legacy marker GC and prunes legacy definitions', () => {
  const dir = tmpDir();
  const generationTwo = path.join(dir, 'sidequest-exec-dispatch-high.md');
  const legacy = path.join(dir, 'sidequest-exec-codex-gpt-5-6-terra-high.md');
  fs.writeFileSync(generationTwo, `generation two\n${agentsync.MARKER}\n`);
  fs.writeFileSync(legacy, `legacy\n${agentsync.LEGACY_MARKER}\n`);

  const legacyGcWouldDelete = (file) => fs.readFileSync(file, 'utf8').includes(agentsync.LEGACY_MARKER);
  assert.ok(!legacyGcWouldDelete(generationTwo));
  assert.ok(legacyGcWouldDelete(legacy));

  const result = agentsync.syncExecAgents(null, { dir });
  assert.equal(result.removed, 1);
  assert.ok(fs.existsSync(generationTwo));
  assert.ok(!fs.existsSync(legacy));
});

test('sync writes the complete stable executor ladder with an empty taxonomy', () => {
  clearCatalog();
  const store = require('../lib/store.js');
  const db = require('../lib/db.js').openDb(process.env.SIDEQUEST_HOME);
  const categories = store.getCategories({ includeDisabled: true });
  db.prepare('DELETE FROM categories').run();
  const dir = tmpDir();
  try {
    assert.deepStrictEqual(store.getCategories({ includeDisabled: true }), []);
    const result = agentsync.syncExecAgents(null, { dir });
    assert.equal(result.written, 10);
    assert.deepStrictEqual(readDir(dir), STABLE_EXECUTORS);
    for (const effort of EFFORTS) {
      const dispatch = fs.readFileSync(path.join(dir, `sidequest-exec-dispatch-${effort}.md`), 'utf8');
      const builtin = fs.readFileSync(path.join(dir, `sidequest-exec-${effort}.md`), 'utf8');
      assert.match(dispatch, /^model: claude-codex-auto$/m);
      assert.doesNotMatch(builtin, /^model:/m);
      assert.match(dispatch, new RegExp(`^effort: ${effort}$`, 'm'));
      assert.match(builtin, new RegExp(`^effort: ${effort}$`, 'm'));
    }
  } finally {
    for (const category of categories) store.setCategory(category);
  }
});

test('sync keeps the complete stable ladder after route removal', () => {
  seedCatalog([TERRA, PROJECT_ONLY]);
  const store = require('../lib/store.js');
  const project = store.ensureProject(path.join(process.env.SIDEQUEST_HOME, 'project-only'), 'Project only').slug;
  store.setProjectCategory(project, 'project-only', 'ADD', {
    name: 'Project only',
    description: 'Project route',
    contract: 'Project route',
    route: { model: PROJECT_ONLY.slug, effort: 'low' },
    fallback: null,
    enabled: true,
  });
  const dir = tmpDir();
  agentsync.syncExecAgents(null, { dir });
  store.removeProjectCategory(project, 'project-only');
  const result = agentsync.syncExecAgents(null, { dir });
  assert.equal(result.removed, 0);
  assert.deepStrictEqual(readDir(dir), STABLE_EXECUTORS);
});

test('sync prunes legacy per-combo codex executors in favor of the shared dispatch set', () => {
  seedCatalog([TERRA]);
  const store = require('../lib/store.js');
  configure(store, 'sync-legacy', { model: TERRA.slug, effort: 'high' });
  const dir = tmpDir();
  const legacy = path.join(dir, 'sidequest-exec-codex-gpt-5-6-terra-high.md');
  fs.writeFileSync(legacy, `---\nname: sidequest-exec-codex-gpt-5-6-terra-high\n---\n${agentsync.MARKER}\nlegacy body\n`);
  const result = agentsync.syncExecAgents(null, { dir });
  assert.ok(result.removed >= 1);
  assert.ok(!fs.existsSync(legacy));
  assert.ok(readDir(dir).includes('sidequest-exec-dispatch-high.md'));
});


test('sync writes route-independent generated executors', () => {
  seedCatalog([TERRA, SOL]);
  const store = require('../lib/store.js');
  configure(store, 'sync-terra', { model: TERRA.slug, effort: 'high' }, { model: 'opus', effort: 'high' });
  const dir = tmpDir();
  const result = agentsync.syncExecAgents(null, { dir });
  assert.equal(result.written, 10);
  assert.deepStrictEqual(readDir(dir), STABLE_EXECUTORS);
  const body = fs.readFileSync(path.join(dir, 'sidequest-exec-dispatch-high.md'), 'utf8');
  assert.match(body, /^model: claude-codex-auto$/m);
  assert.match(body, /resolves the real Codex model/);
  assert.match(body, /NEVER write, quote, or echo such a line/);
  assert.ok(body.includes(agentsync.MARKER));
  assert.match(body, /Never read large files whole/);
  assert.match(body, /mcp__plugin_sidequest_board__commit/);
  assert.match(body, /mcp__plugin_sidequest_board__submit/);
  assert.match(body, /absolute `worktree`/);
  assert.match(body, /Never publish, push/);
  assert.match(body, /`SendMessage` is only for `main`/);
  assert.doesNotMatch(body, /sidequest submit <ref>/);
  assert.doesNotMatch(body, /\{\{[A-Z_]+\}\}/);
});

test('sync keeps stable executors when category policy is remapped', () => {
  seedCatalog([TERRA, SOL]);
  const store = require('../lib/store.js');
  configure(store, 'sync-remap', { model: TERRA.slug, effort: 'medium' });
  const dir = tmpDir();
  agentsync.syncExecAgents(null, { dir });
  configure(store, 'sync-remap', { model: SOL.slug, effort: 'xhigh' });
  const result = agentsync.syncExecAgents(null, { dir });
  assert.equal(result.removed, 0);
  assert.deepStrictEqual(readDir(dir), STABLE_EXECUTORS);
});

test('sync is idempotent and never overwrites an unmarked collision', () => {
  seedCatalog([TERRA]);
  const store = require('../lib/store.js');
  configure(store, 'sync-idempotent', { model: TERRA.slug, effort: 'medium' });
  const dir = tmpDir();
  const filePath = path.join(dir, 'sidequest-exec-dispatch-medium.md');
  fs.writeFileSync(filePath, 'hand-authored\n');
  agentsync.syncExecAgents(null, { dir });
  assert.equal(fs.readFileSync(filePath, 'utf8'), 'hand-authored\n');
  fs.unlinkSync(filePath);
  agentsync.syncExecAgents(null, { dir });
  const second = agentsync.syncExecAgents(null, { dir });
  assert.equal(second.written, 0);
  assert.ok(second.unchanged > 0);
});

test('native dispatch fallback does not write a temporary agent file', () => {
  const dir = tmpDir();
  const created = agentsync.createNativeAgent({
    ref: 'SQ-249', agentType: 'sidequest-exec-codex-gpt-5-6-terra-medium',
    runtime: 'codex-gpt-5-6-terra', effort: 'medium', sessionId: 'session-249',
  }, { dir, waitMs: 0 });
  assert.strictEqual(created.fallback, true);
  assert.strictEqual(created.file, null);
  assert.deepStrictEqual(readDir(dir), []);
});

test('declared-file tickets receive a worktree spawn unless shared-tree is explicit', () => {
  const ticket = { files: ['plugins/sidequest'] };
  assert.equal(agentsync.ticketIsolation(ticket, false), 'worktree');
  assert.equal(agentsync.ticketIsolation(ticket, true), null);
  assert.equal(agentsync.ticketIsolation({ files: [] }, false), null);

  const created = agentsync.createNativeAgent({
    ref: 'SQ-396', agentType: 'sidequest-exec-dispatch-high', runtime: 'codex-gpt-5-6-terra',
    effort: 'high', isolation: 'worktree',
  }, { dir: tmpDir(), waitMs: 0 });
  assert.equal(created.spawn.isolation, 'worktree');
});

test('renderTicketBriefing contains only ticket-specific dispatch context', () => {
  seedCatalog([TERRA]);
  const briefing = agentsync.renderTicketBriefing({
    ref: 'SQ-334', title: 'Instant dispatch', description: 'Ride the briefing on the spawn prompt.',
    model: TERRA.slug, effort: 'high', dispatchExecutor: 'sidequest-exec-dispatch-high',
    executorAnchors: 'lib/store.js prepareDispatch', executorVerify: 'node --test plugins/sidequest/test/agentsync.test.js',
    comments: [{ by: 'scout', body: 'Stable exec is pre-registered.' }],
    category: { contract: 'Plan against the system, verify end to end.' },
  }, 'instant-token-334');
  assert.doesNotMatch(briefing, /^---$/m);
  assert.doesNotMatch(briefing, /^name:/m);
  assert.doesNotMatch(briefing, /You are a sidequest ticket executor/);
  assert.match(briefing, /## This ticket/);
  assert.match(briefing, /Instant dispatch/);
  assert.match(briefing, /Ride the briefing on the spawn prompt/);
  assert.match(briefing, /Stable exec is pre-registered/);
  assert.match(briefing, /Plan against the system, verify end to end/);
  assert.doesNotMatch(briefing, /mcp__plugin_sidequest_board__claim/);
  assert.match(briefing, /--token instant-token-334/);
  assert.doesNotMatch(briefing, /mcp__plugin_sidequest_board__submit/);
  assert.ok(Buffer.byteLength(briefing) < 4000, `ticket briefing is ${Buffer.byteLength(briefing)} bytes`);
  assert.ok(briefing.trimEnd().endsWith('[sidequest-route model=gpt-5.6-terra effort=high]'));
});

test('renderTicketBriefing embeds no route marker for a Claude-backed route', () => {
  clearCatalog();
  const briefing = agentsync.renderTicketBriefing({
    ref: 'SQ-347', title: 'Claude route', model: 'opus', effort: 'high',
    dispatchExecutor: 'sidequest-exec-high', category: {},
  }, 'claude-token-347');
  assert.doesNotMatch(briefing, /\[sidequest-route model=/);
});

test('workflow recipes use the dispatch pin and normalized catalog marker for Codex routes', () => {
  seedCatalog([TERRA]);
  const store = require('../lib/store.js');
  configure(store, 'workflow-codex', { model: TERRA.slug, effort: 'medium' });
  const category = Object.assign(store.getCategory('workflow-codex'), { project: 'recipe-project' });

  assert.deepStrictEqual(agentsync.workflowRecipe(category, store.resolveCategoryRoute(category)), {
    project: 'recipe-project',
    category: 'workflow-codex',
    categoryName: 'workflow-codex',
    backend: 'codex',
    route: { model: TERRA.slug, effort: 'medium' },
    runsLabel: TERRA.label,
    agent: {
      model: agentsync.DISPATCH_MODEL_ID,
      promptPrefix: '[sidequest-route model=gpt-5.6-terra effort=medium]\n\n',
    },
    effortCarrier: 'marker',
    warnings: [],
  });
});

test('workflow recipes use the Claude runtime alias without a prompt prefix', () => {
  clearCatalog();
  const store = require('../lib/store.js');
  configure(store, 'workflow-claude', { model: 'opus', effort: 'high' });
  const category = Object.assign(store.getCategory('workflow-claude'), { project: 'recipe-project' });

  assert.deepStrictEqual(agentsync.workflowRecipe(category, store.resolveCategoryRoute(category)), {
    project: 'recipe-project',
    category: 'workflow-claude',
    categoryName: 'workflow-claude',
    backend: 'claude',
    route: { model: 'opus', effort: 'high' },
    runsLabel: 'Claude Opus',
    agent: { model: 'opus', promptPrefix: '' },
    effortCarrier: 'none',
    warnings: [],
  });
});

test('workflow recipes preserve live fallback warnings', () => {
  clearCatalog();
  const store = require('../lib/store.js');
  configure(store, 'workflow-fallback', { model: TERRA.slug, effort: 'high' }, { model: 'opus', effort: 'medium' });
  const category = Object.assign(store.getCategory('workflow-fallback'), { project: 'recipe-project' });
  const recipe = agentsync.workflowRecipe(category, store.resolveCategoryRoute(category));

  assert.deepStrictEqual(recipe.route, { model: 'opus', effort: 'medium' });
  assert.equal(recipe.effortCarrier, 'none');
  assert.deepStrictEqual(recipe.warnings, ['Category "workflow-fallback" route model "codex-gpt-5-6-terra" isn\'t currently available.']);
});

test('workflow recipes reject an invalid Codex marker before spawning', () => {
  assert.throws(() => agentsync.workflowRecipe({ id: 'invalid-route', name: 'Invalid route', project: 'recipe-project' }, {
    model: 'codex-invalid',
    effort: 'high',
    exec: { backend: 'codex', dispatchModel: 'not marker-safe', runsLabel: 'Invalid' },
    warnings: [],
  }), /model id is not marker-safe/);
});

test('routeMarker rejects ids and efforts outside the gateway grammar', () => {
  for (const effort of EFFORTS) {
    assert.equal(agentsync.routeMarker('gpt-5.6-sol', effort), `[sidequest-route model=gpt-5.6-sol effort=${effort}]`);
  }
  for (const bad of ['', 'UPPER', 'has space', 'has]bracket', '-leading', 'x'.repeat(70)]) {
    assert.throws(() => agentsync.routeMarker(bad, 'high'), /model id is not marker-safe/);
  }
  for (const bad of ['', 'highest', 'HIGH', ' has-space', 'high\nlow']) {
    assert.throws(() => agentsync.routeMarker('gpt-5.6-sol', bad), /effort is not marker-safe/);
  }
});

test('renderTicketBriefing rejects an empty or multi-line nonce', () => {
  seedCatalog([TERRA]);
  const ticket = { ref: 'SQ-334', title: 't', model: TERRA.slug, effort: 'high', dispatchExecutor: 'sidequest-exec-codex-gpt-5-6-terra-high', category: {} };
  for (const nonce of [undefined, '', '  ', 'line1\nline2']) {
    assert.throws(() => agentsync.renderTicketBriefing(ticket, nonce), /nonce is required/);
  }
});

test('cleanup retains one-release support for old ticket executor files', () => {
  const dir = tmpDir();
  const createOldTicketFile = (name, sessionId) => {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, `${agentsync.TEMP_MARKER}\n<!-- sidequest-native-session: ${sessionId} -->\n`);
    return file;
  };
  const byName = createOldTicketFile('sidequest-ticket-sq-312-gpt-5-6-terra-a1b2c3d4', 'session-a');
  const bySession = createOldTicketFile('sidequest-ticket-sq-313-gpt-5-6-terra-a1b2c3d4', 'session-b');
  const stale = createOldTicketFile('sidequest-ticket-sq-314-gpt-5-6-terra-a1b2c3d4', 'session-c');
  assert.equal(agentsync.cleanupNativeAgents({ name: 'sidequest-ticket-sq-312-gpt-5-6-terra-a1b2c3d4', dir }).removed, 1);
  assert.ok(!fs.existsSync(byName));
  assert.equal(agentsync.cleanupNativeAgents({ sessionId: 'session-b', dir }).removed, 1);
  assert.ok(!fs.existsSync(bySession));
  fs.utimesSync(stale, new Date(0), new Date(0));
  assert.equal(agentsync.cleanupNativeAgents({ staleBefore: Date.now() - 1, dir }).removed, 1);
  assert.ok(!fs.existsSync(stale));
});

test('every executor name syncExecAgents writes classifies to a stable kind', () => {
  const { classify } = require('../lib/exec-names.js');
  const dir = tmpDir();
  agentsync.syncExecAgents(null, { dir });
  const names = readDir(dir).map((file) => file.replace(/\.md$/, ''));
  assert.ok(names.length > 0, 'sync must write executor definitions');
  for (const name of names) {
    const { kind } = classify(name);
    assert.ok(
      ['codex_dispatch', 'claude_builtin'].includes(kind),
      `${name} did not classify to a stable kind (got ${kind})`,
    );
  }
});
