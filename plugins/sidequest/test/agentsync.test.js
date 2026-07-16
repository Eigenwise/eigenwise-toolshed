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

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sq-agentsync-test-')); }
function readDir(dir) { return fs.readdirSync(dir).filter((file) => file.endsWith('.md')).sort(); }
function seedCatalog(models) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-agentsync-catalog-'));
  fs.mkdirSync(path.join(dir, 'codex-gateway'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'codex-gateway', 'catalog.json'), JSON.stringify({ source: 'codex-gateway', models }));
  process.env.SIDEQUEST_DISCOVERY_DIRS = dir;
}
function clearCatalog() { process.env.SIDEQUEST_DISCOVERY_DIRS = NO_CATALOG_DIR; }
function configure(store, id, route, fallback) {
  store.setCategory({ id, name: id, route, fallback: fallback || null, enabled: true });
}

test('sync includes project-scoped routes and prunes them when removed', () => {
  seedCatalog([TERRA, PROJECT_ONLY]);
  const store = require('../lib/store.js');
  const project = store.ensureProject(path.join(process.env.SIDEQUEST_HOME, 'project-only'), 'Project only').slug;
  store.setProjectCategory(project, 'project-only', 'ADD', {
    name: 'Project only',
    description: 'Project route',
    contract: 'Project route',
    // 'low' is used by no default category route, so this project route is the
    // only reason a dispatch-low executor exists — making the prune observable.
    route: { model: PROJECT_ONLY.slug, effort: 'low' },
    fallback: null,
    enabled: true,
  });
  const dir = tmpDir();
  agentsync.syncExecAgents(null, { dir });
  const generated = path.join(dir, 'sidequest-exec-dispatch-low.md');
  assert.ok(fs.existsSync(generated));
  store.removeProjectCategory(project, 'project-only');
  const result = agentsync.syncExecAgents(null, { dir });
  assert.ok(result.removed >= 1);
  assert.ok(!fs.existsSync(generated));
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


test('sync writes generated executors for concrete category routes', () => {
  seedCatalog([TERRA, SOL]);
  const store = require('../lib/store.js');
  configure(store, 'sync-terra', { model: TERRA.slug, effort: 'high' }, { model: 'opus', effort: 'high' });
  const dir = tmpDir();
  const result = agentsync.syncExecAgents(null, { dir });
  assert.ok(result.written > 0);
  assert.ok(readDir(dir).includes('sidequest-exec-dispatch-high.md'));
  assert.ok(readDir(dir).includes('sidequest-exec-high.md'));
  const body = fs.readFileSync(path.join(dir, 'sidequest-exec-dispatch-high.md'), 'utf8');
  assert.match(body, /^model: claude-codex-auto$/m);
  assert.match(body, /resolves the real Codex model/);
  assert.match(body, /NEVER write, quote, or echo such a line/);
  assert.ok(body.includes(agentsync.MARKER));
  assert.match(body, /Never read large files whole/);
  assert.match(body, /siblings may share this tree/);
  assert.match(body, /session scratchpad path handed in your prompt/);
  assert.match(body, /full output tail/);
  assert.match(body, /Commit and ship before done/);
  assert.match(body, /include its hash in your own done comment/);
  assert.match(body, /Never SendMessage/);
});

test('sync removes generated executors no longer reachable from category policy', () => {
  seedCatalog([TERRA, SOL]);
  const store = require('../lib/store.js');
  configure(store, 'sync-remap', { model: TERRA.slug, effort: 'medium' });
  const dir = tmpDir();
  agentsync.syncExecAgents(null, { dir });
  const stale = path.join(dir, 'sidequest-exec-dispatch-medium.md');
  assert.ok(fs.existsSync(stale));
  configure(store, 'sync-remap', { model: SOL.slug, effort: 'xhigh' });
  const result = agentsync.syncExecAgents(null, { dir });
  assert.ok(result.removed >= 1);
  assert.ok(!fs.existsSync(stale));
  assert.ok(readDir(dir).includes('sidequest-exec-dispatch-xhigh.md'));
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

test('ticket executor renders the briefing and nonce while keeping spawn short', () => {
  seedCatalog([TERRA]);
  const dir = tmpDir();
  const created = agentsync.createTicketExecutor({
    ref: 'SQ-311', title: 'Ship ephemeral agents', description: 'Carry the complete ticket briefing.',
    model: TERRA.slug, effort: 'high', dispatchExecutor: 'sidequest-ticket-sq-311-gpt-5-6-terra-a1b2c3d4', executorAnchors: 'lib/agentsync.js:235 createTicketExecutor',
    executorVerify: 'node --test plugins/sidequest/test/agentsync.test.js',
    comments: [{ by: 'scout', body: 'Watcher registration takes time.' }],
    category: { contract: 'Establish the local pattern, then verify it.' },
  }, { nonce: 'dispatch-token-311', sessionId: 'session-311', dir, waitMs: 0 });
  const body = fs.readFileSync(created.file, 'utf8');
  assert.equal(created.name, 'sidequest-ticket-sq-311-gpt-5-6-terra-a1b2c3d4');
  assert.match(body, /^model: claude-codex-gpt-5\.6-terra\[1m\]$/m);
  assert.match(body, /^effort: high$/m);
  assert.match(body, /^maxTurns: 60$/m);
  assert.ok(body.includes(agentsync.TEMP_MARKER));
  assert.match(body, /sidequest-native-session: session-311/);
  assert.match(body, /Ship ephemeral agents/);
  assert.match(body, /Watcher registration takes time/);
  assert.match(body, /Establish the local pattern/);
  assert.match(body, /--token dispatch-token-311/);
  assert.match(body, /Never read large files whole/);
  assert.match(body, /siblings may share this tree/);
  assert.match(body, /session scratchpad path handed in your prompt/);
  assert.match(body, /full output tail/);
  assert.match(body, /Commit and ship before done/);
  assert.match(body, /include its hash in your own done comment/);
  assert.match(body, /Never SendMessage/);
  assert.deepStrictEqual(created.spawn, {
    subagent_type: created.name, name: created.name, mode: 'bypassPermissions',
  });
  assert.ok(JSON.stringify(created.spawn).length < 200);
});

test('ticket executors use a fresh prepared name and prune a superseded definition', () => {
  seedCatalog([TERRA]);
  const dir = tmpDir();
  const base = { ref: 'SQ-319', title: 'Fresh dispatch', model: TERRA.slug, effort: 'high', category: {} };
  const first = agentsync.createTicketExecutor(Object.assign({}, base, { dispatchExecutor: 'sidequest-ticket-sq-319-gpt-5-6-terra-a1b2c3d4' }), {
    nonce: 'first-token', sessionId: 'session-319', dir, waitMs: 0,
  });
  const second = agentsync.createTicketExecutor(Object.assign({}, base, { dispatchExecutor: 'sidequest-ticket-sq-319-gpt-5-6-terra-d4c3b2a1' }), {
    nonce: 'second-token', sessionId: 'session-319', dir, waitMs: 0,
  });
  assert.notEqual(first.name, second.name);
  assert.ok(!fs.existsSync(first.file));
  assert.ok(fs.existsSync(second.file));
});

test('ticket executor rejects non-string and empty dispatch nonces', () => {
  seedCatalog([TERRA]);
  const ticket = { ref: 'SQ-315', title: 'Nonce validation', model: TERRA.slug, effort: 'high', dispatchExecutor: 'sidequest-ticket-sq-315-gpt-5-6-terra-a1b2c3d4', category: {} };
  for (const nonce of [undefined, null, '', '   ', { token: 'wrong-shape' }]) {
    assert.throws(() => agentsync.createTicketExecutor(ticket, { nonce, dir: tmpDir(), waitMs: 0 }), /nonce is required/);
  }
});

test('renderTicketBriefing reuses the template body with the ticket brief and token, minus frontmatter', () => {
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
  assert.match(briefing, /You are a sidequest ticket executor/);
  assert.match(briefing, /Instant dispatch/);
  assert.match(briefing, /Ride the briefing on the spawn prompt/);
  assert.match(briefing, /Stable exec is pre-registered/);
  assert.match(briefing, /Plan against the system, verify end to end/);
  assert.match(briefing, /--executor sidequest-exec-dispatch-high/);
  assert.match(briefing, /--token instant-token-334/);
  assert.match(briefing, /Commit and ship before done/);
  assert.match(briefing, /include its hash in your own done comment/);
  assert.ok(briefing.trimEnd().endsWith('[sidequest-route model=gpt-5.6-terra]'));
});

test('renderTicketBriefing embeds no route marker for a Claude-backed route', () => {
  clearCatalog();
  const briefing = agentsync.renderTicketBriefing({
    ref: 'SQ-347', title: 'Claude route', model: 'opus', effort: 'high',
    dispatchExecutor: 'sidequest-exec-high', category: {},
  }, 'claude-token-347');
  assert.doesNotMatch(briefing, /\[sidequest-route model=/);
});

test('routeMarker rejects ids outside the gateway grammar', () => {
  assert.equal(agentsync.routeMarker('gpt-5.6-sol'), '[sidequest-route model=gpt-5.6-sol]');
  for (const bad of ['', 'UPPER', 'has space', 'has]bracket', '-leading', 'x'.repeat(70)]) {
    assert.throws(() => agentsync.routeMarker(bad), /not marker-safe/);
  }
});

test('renderTicketBriefing rejects an empty or multi-line nonce', () => {
  seedCatalog([TERRA]);
  const ticket = { ref: 'SQ-334', title: 't', model: TERRA.slug, effort: 'high', dispatchExecutor: 'sidequest-exec-codex-gpt-5-6-terra-high', category: {} };
  for (const nonce of [undefined, '', '  ', 'line1\nline2']) {
    assert.throws(() => agentsync.renderTicketBriefing(ticket, nonce), /nonce is required/);
  }
});

test('ticket executors use the existing temporary cleanup lifecycle', () => {
  seedCatalog([TERRA]);
  const dir = tmpDir();
  const ticket = (ref) => ({ ref, title: ref, model: TERRA.slug, effort: 'high', dispatchExecutor: `sidequest-ticket-${ref.toLowerCase()}-gpt-5-6-terra-a1b2c3d4`, category: {} });
  const byName = agentsync.createTicketExecutor(ticket('SQ-312'), { nonce: 'nonce-312', sessionId: 'session-a', dir, waitMs: 0 });
  const bySession = agentsync.createTicketExecutor(ticket('SQ-313'), { nonce: 'nonce-313', sessionId: 'session-b', dir, waitMs: 0 });
  const stale = agentsync.createTicketExecutor(ticket('SQ-314'), { nonce: 'nonce-314', sessionId: 'session-c', dir, waitMs: 0 });
  assert.equal(agentsync.cleanupNativeAgents({ name: byName.name, dir }).removed, 1);
  assert.ok(!fs.existsSync(byName.file));
  assert.equal(agentsync.cleanupNativeAgents({ sessionId: 'session-b', dir }).removed, 1);
  assert.ok(!fs.existsSync(bySession.file));
  fs.utimesSync(stale.file, new Date(0), new Date(0));
  assert.equal(agentsync.cleanupNativeAgents({ staleBefore: Date.now() - 1, dir }).removed, 1);
  assert.ok(!fs.existsSync(stale.file));
});
