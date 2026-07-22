'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('node:child_process');

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
function readDir(dir?: any) { return fs.readdirSync(dir).filter((file: string) => file.endsWith('.md')).sort(); }
function seedCatalog(models?: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-agentsync-catalog-'));
  fs.mkdirSync(path.join(dir, 'codex-gateway'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'codex-gateway', 'catalog.json'), JSON.stringify({ schemaVersion: 3, source: 'codex-gateway', models }));
  process.env.SIDEQUEST_DISCOVERY_DIRS = dir;
}
function clearCatalog() { process.env.SIDEQUEST_DISCOVERY_DIRS = NO_CATALOG_DIR; }
function configure(store?: any, id?: any, route?: any, fallback?: any) {
  store.setCategory({ id, name: id, route, fallback: fallback || null, enabled: true });
}

test('SQ-677: briefing comments preserve the full chronological durable thread byte-for-byte', () => {
  const comments = [
    {
      by: 'investigator', kind: 'comment', at: '2026-07-20T00:00:00.000Z',
      body: 'Decision:\n\n- keep the **markdown**\n- preserve the blank line\n\nUnicode: 測試 🧪',
    },
    {
      by: 'reviewer', kind: 'warning', at: '2026-07-20T00:01:00.000Z',
      body: 'Integration risk:\ninspect every attachment before implementation.',
    },
    {
      by: 'worker', kind: 'comment', at: '2026-07-20T00:02:00.000Z',
      body: 'Verification:\n`node --test plugins/sidequest/test/*.test.js` passed.',
    },
  ];
  const expected = comments.map((comment, index) => [
    `### Comment ${index + 1}`,
    `Author: ${comment.by}`,
    `Kind: ${comment.kind}`,
    `Recorded: ${comment.at}`,
    'Body:',
    comment.body,
  ].join('\n')).join('\n\n');
  assert.strictEqual(agentsync.ticketCommentsPacket(comments), expected);
});

test('SQ-760: oversized briefing packets stay bounded and direct compact comment reads', () => {
  const description = `Start with this scope.\n\n${'測試 '.repeat(5000)}`;
  const comments = Array.from({ length: 20 }, (_, index) => ({
    by: `worker-${index + 1}`,
    kind: index === 0 ? 'decision' : 'comment',
    at: `2026-07-22T00:${String(index).padStart(2, '0')}:00.000Z`,
    body: index === 19
      ? 'Decision:\nKeep this latest decision verbatim in the packet.'
      : `Comment ${index + 1}: ${'x'.repeat(1000)}`,
  }));
  const ticket = {
    id: 'bounded-briefing', ref: 'SQ-760', title: 'Bound briefing packets', description,
    model: 'opus', effort: 'high', dispatchExecutor: 'sidequest-exec-high', category: {},
    executorVerify: 'node --test plugins/sidequest/test/agentsync.test.ts',
    files: ['plugins/sidequest/src/lib/agentsync.ts'],
    assets: ['briefing.png'], comments,
  };

  const packet = agentsync.ticketCommentsPacket(comments);
  assert.ok(Buffer.byteLength(packet) <= 6 * 1024, `comment packet is ${Buffer.byteLength(packet)} bytes`);
  assert.match(packet, /### Comment 20/);
  assert.match(packet, /Keep this latest decision verbatim in the packet\./);
  assert.ok(packet.indexOf('### Comment 20') < packet.indexOf('### Comment 19'));
  assert.doesNotMatch(packet, /Comment 2: x/);
  assert.match(packet, /Comment packet truncated/);
  assert.match(packet, /compact comments reads \(latest-first\)/);
  assert.match(packet, /decision or constraint is in omitted history: fetch the full thread/);

  const briefing = agentsync.renderTicketBriefing(ticket, 'bounded-briefing-token');
  const descriptionPacket = briefing.match(/Description:\n([\s\S]*?)\n\nCategory contract:/);
  assert.ok(descriptionPacket);
  assert.ok(Buffer.byteLength(descriptionPacket![1]) <= 8 * 1024, `description packet is ${Buffer.byteLength(descriptionPacket![1])} bytes`);
  assert.match(descriptionPacket![1], /Description truncated at 8 KB/);
  assert.match(briefing, /Comment packet \(newest-first excerpts; read full history only when flagged below\):/);
  assert.match(briefing, new RegExp(ticket.executorVerify));
  assert.match(briefing, /plugins\/sidequest\/src\/lib\/agentsync\.ts/);
  assert.match(briefing, /briefing\.png/);
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

  const legacyGcWouldDelete = (file?: any) => fs.readFileSync(file, 'utf8').includes(agentsync.LEGACY_MARKER);
  assert.ok(!legacyGcWouldDelete(generationTwo));
  assert.ok(legacyGcWouldDelete(legacy));

  const result = agentsync.syncExecAgents(null, { dir });
  assert.equal(result.removed, 1);
  assert.ok(fs.existsSync(generationTwo));
  assert.ok(!fs.existsSync(legacy));
});

test('sync writes the complete stable executor ladder with the smallest valid taxonomy', () => {
  clearCatalog();
  const store = require('../lib/store.js');
  const db = require('../lib/db.js').openDb(process.env.SIDEQUEST_HOME);
  const categories = store.getCategories({ includeDisabled: true });
  db.prepare("DELETE FROM routing_profile_entries WHERE profile_id = 'coding' AND category_id <> 'general'").run();
  const dir = tmpDir();
  try {
    assert.deepStrictEqual(store.getCategories({ includeDisabled: true }).map((category?: any) => category.id), ['general']);
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
    db.close();
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
  assert.equal(agentsync.EXECUTOR_CHECKPOINT_TOOL_ROUNDS, 100);
  assert.match(body, /every `Read` or `Grep` result stays in this run's history/);
  assert.match(body, /scoped `Read` calls with `offset`\/`limit`, `Grep` with `head_limit`/);
  assert.match(body, /Around 100 tool rounds, do not limp onward/);
  assert.match(body, /`Continuation checkpoint`/);
  assert.match(body, /then `release` the ticket to `todo` and end/);
  assert.match(body, /Do not submit at a checkpoint/);
  assert.match(body, /mcp__plugin_sidequest_board__commit/);
  assert.match(body, /mcp__plugin_sidequest_board__submit/);
  assert.match(body, /absolute `worktree`/);
  assert.match(body, /Never publish, push/);
  assert.match(body, /full final report: changed paths, verification evidence, commit hash/);
  assert.match(body, /After a terminal board closeout, stop without a routine `SendMessage` to `main`/);
  assert.match(body, /`kind=question` needs, a scope conflict, or a failure the board cannot/);
  assert.doesNotMatch(body, /verified milestone/);
  assert.match(body, /Teammate subagent fan-out must omit the Agent `name` parameter/);
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


test('unchanged install hash skips the full executor ladder comparison', () => {
  const dir = tmpDir();
  const first = agentsync.syncExecAgentsIfChanged(null, { dir });
  assert.equal(first.skipped, false);
  assert.equal(first.written, 10);
  const second = agentsync.syncExecAgentsIfChanged(null, { dir });
  assert.deepStrictEqual(second, {
    written: 0,
    removed: 0,
    unchanged: 0,
    skipped: true,
    installHash: first.installHash,
  });
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

test('renderDispatchStub keeps its briefing command alive after the dispatched cache version is removed', () => {
  clearCatalog();
  const claudeHome = tmpDir();
  const staleInstall = path.join(claudeHome, 'cache', 'sidequest', '2.42.0');
  const currentInstall = path.join(claudeHome, 'cache', 'sidequest', '2.41.0');
  const writeCli = (install?: any) => {
    const bin = path.join(install, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'sidequest.js'), "process.stdout.write(process.argv.slice(2).join(' '));");
  };
  writeCli(staleInstall);
  writeCli(currentInstall);
  fs.mkdirSync(path.join(claudeHome, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({
    plugins: {
      'sidequest@eigenwise-toolshed': [
        { installPath: staleInstall, version: '2.42.0', lastUpdated: '2026-07-19T00:00:00.000Z' },
        { installPath: currentInstall, version: '2.41.0', lastUpdated: '2026-07-20T00:00:00.000Z' },
      ],
    },
  }));

  const stub = agentsync.renderDispatchStub({
    ref: 'SQ-586', title: 'Stable briefing launcher', model: 'opus', effort: 'high',
    dispatchExecutor: 'sidequest-exec-high', category: {},
  }, 'briefing-token', 'C:\\dev\\fixture');
  const launcher = stub.match(/FIRST action: run `node "([^"]+)"/)[1];
  assert.match(launcher, /sidequest-launcher\.js$/);
  assert.doesNotMatch(stub, new RegExp(staleInstall.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const runBriefing = () => spawnSync(process.execPath, [launcher, 'briefing', 'SQ-586', '--token', 'briefing-token', '--project', 'C:\\dev\\fixture'], {
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_CLAUDE_HOME: claudeHome },
  });
  const intact = runBriefing();
  assert.equal(intact.status, 0, intact.stderr);
  assert.equal(intact.stdout, 'briefing SQ-586 --token briefing-token --project C:\\dev\\fixture');

  fs.rmSync(staleInstall, { recursive: true, force: true });
  const recovered = runBriefing();
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.stdout, 'briefing SQ-586 --token briefing-token --project C:\\dev\\fixture');
});

test('SQ-677: fetched briefing carries the complete durable ticket packet while the spawn stays tiny', () => {
  seedCatalog([TERRA]);
  const slug = 'briefing-測試';
  const ticket = {
    id: 'briefing-assets', ref: 'SQ-334', title: 'Instant dispatch',
    description: 'First paragraph.\n\n- markdown keeps its **exact** shape\n- blank lines stay blank\n\nUnicode survives: 測試 🧪',
    model: TERRA.slug, effort: 'high', dispatchExecutor: 'sidequest-exec-dispatch-high',
    executorAnchors: 'lib/store.js prepareDispatch', executorVerify: 'node --test plugins/sidequest/test/agentsync.test.js',
    files: ['plugins/sidequest/src/lib/agentsync.ts', 'docs/briefing notes.md'],
    labels: ['dispatch', 'unicode'], priority: 'urgent', storyId: 'US-99', status: 'todo',
    links: [{ type: 'blocked-by', ref: 'SQ-12' }, { type: 'related', ref: 'SQ-33' }],
    comments: [
      { by: 'scout', kind: 'comment', at: '2026-07-20T00:00:00.000Z', body: 'First durable comment.\n\nKeep **this** spacing and Unicode: λ測試.' },
      { by: 'reviewer', kind: 'warning', at: '2026-07-20T00:01:00.000Z', body: 'Second durable comment, added before redispatch.\n\nDo not flatten this paragraph.' },
    ],
    assets: ['space file.png', '画像.png', 'missing file.png'],
    category: { id: 'briefing.contract', route: { model: TERRA.slug, effort: 'high' }, contract: 'Plan against the durable packet, then verify end to end.' },
  };
  const assetDir = path.join(process.env.SIDEQUEST_HOME, 'projects', slug, 'assets', ticket.id);
  fs.mkdirSync(assetDir, { recursive: true });
  fs.writeFileSync(path.join(assetDir, ticket.assets[0]!), 'first');
  fs.writeFileSync(path.join(assetDir, ticket.assets[1]!), 'second');

  const briefing = agentsync.renderTicketBriefing(ticket, 'instant-token-334', slug);
  const descriptionPacket = briefing.match(/Description:\n([\s\S]*?)\n\nCategory contract:/);
  assert.ok(descriptionPacket);
  assert.strictEqual(descriptionPacket![1], ticket.description);
  const commentsPacket = briefing.match(/Complete comment thread \(chronological, inspect every entry before implementation\):\n([\s\S]*?)\n\nAttachments/);
  assert.ok(commentsPacket);
  assert.strictEqual(commentsPacket![1], agentsync.ticketCommentsPacket(ticket.comments));
  const stub = agentsync.renderDispatchStub(Object.assign({}, ticket, { description: 'y'.repeat(100000), comments: [{ body: 'z'.repeat(100000) }] }), 'instant-token-334', 'C:\\dev\\fixture');
  assert.doesNotMatch(briefing, /^---$/m);
  assert.match(briefing, /## This ticket/);
  assert.ok(briefing.includes(ticket.description));
  assert.ok(briefing.includes(ticket.comments[0]!.body));
  assert.ok(briefing.includes(ticket.comments[1]!.body));
  assert.ok(briefing.indexOf(ticket.comments[0]!.body) < briefing.indexOf(ticket.comments[1]!.body));
  assert.match(briefing, /Category: briefing\.contract/);
  assert.match(briefing, /Configured route: codex-gpt-5-6-terra \/ high/);
  assert.match(briefing, /Dispatch route: codex-gpt-5-6-terra \/ high/);
  assert.match(briefing, /Closeout: submit for repo work; otherwise done --model codex-gpt-5-6-terra --effort high\. Put the full final report in the terminal board comment, then stop without a routine SendMessage\./);
  assert.match(briefing, /Priority: urgent/);
  assert.match(briefing, /Story: US-99/);
  assert.match(briefing, /blocked-by: SQ-12/);
  assert.match(briefing, /docs\/briefing notes\.md/);
  assert.match(briefing, /space file\.png/);
  assert.match(briefing, /画像\.png/);
  assert.match(briefing, /Inspect this attachment before implementation\./);
  assert.match(briefing, /missing file\.png.*missing or unreadable/s);
  assert.match(briefing, /inspect every entry before implementation/i);
  assert.ok(briefing.trimEnd().endsWith('[sidequest-route model=gpt-5.6-terra effort=high]'));
  assert.ok(Buffer.byteLength(stub) < 600, `spawn stub is ${Buffer.byteLength(stub)} bytes`);
  assert.doesNotMatch(stub, /y{1000}/);
  assert.doesNotMatch(stub, /z{1000}/);
  assert.doesNotMatch(stub, /## This ticket/);
});

test('SQ-677: malformed and foreign asset names stay bounded and inaccessible', () => {
  const slug = 'briefing-assets-測試';
  const ticket = {
    id: 'asset-boundary',
    assets: [
      '../escape.png',
      '../../foreign-project/outside.png',
      'C:\\foreign\\secret.png',
      '/var/tmp/elsewhere.png',
    ],
  };
  const packet = agentsync.ticketAssetsPacket(ticket, slug);
  const lines = packet.split('\n');
  assert.equal(lines.length, ticket.assets.length);
  assert.equal(lines.filter((line: string) => line.includes('WARNING:')).length, ticket.assets.length);
  for (const line of lines) {
    assert.ok(Buffer.byteLength(line) < 1024, `asset warning is ${Buffer.byteLength(line)} bytes`);
    assert.match(line, /missing or unreadable/);
    assert.doesNotMatch(line, /\.\.[\\/]/);
    assert.doesNotMatch(line, /foreign-project/);
  }
  assert.match(packet, /escape\.png/);
  assert.match(packet, /outside\.png/);
  assert.match(packet, /secret\.png/);
  assert.match(packet, /elsewhere\.png/);
});

test('artifact lifecycle marker appears only for a validated shared-tree artifact dispatch', () => {
  clearCatalog();
  const store = require('../lib/store.js');
  const base = {
    ref: 'SQ-646',
    title: 'Write a bounded artifact',
    description: store.SHARED_TREE_ARTIFACT_MARKER,
    model: 'opus',
    effort: 'high',
    files: ['.claude/.codebase-info'],
    category: {},
  };
  const active = agentsync.renderTicketBriefing(Object.assign({}, base, {
    dispatch: { sharedTree: true, artifactMode: true, artifactRoot: '.claude/.codebase-info', artifactScope: '.claude/.codebase-info' },
  }), 'artifact-token');
  assert.ok(active.includes(agentsync.ARTIFACT_LIFECYCLE_MARKER));
  assert.match(active, /Do not commit or submit it/);

  for (const dispatch of [
    { sharedTree: true, artifactMode: false },
    { sharedTree: false, artifactMode: false },
  ]) {
    const ordinary = agentsync.renderTicketBriefing(Object.assign({}, base, { dispatch }), 'ordinary-token');
    assert.doesNotMatch(ordinary, /\[sidequest-artifact-mode\]/);
  }
});

test('worktree setup appears only in isolated worktree briefings', () => {
  const store = require('../lib/store.js');
  const slug = store.ensureProject(tmpDir(), 'worktree setup briefing').slug;
  const setup = 'cd plugins/sidequest && npm ci';
  store.setBoardConfig(slug, { worktreeSetup: setup });
  const ticket = {
    ref: 'SQ-745', title: 'Worktree setup', model: 'opus', effort: 'high', category: {},
    files: ['plugins/sidequest/src/lib/agentsync.ts'], dispatch: { sharedTree: false },
  };

  assert.match(agentsync.renderTicketBriefing(ticket, 'worktree-token', slug), new RegExp(`Worktree setup \\(run before verify\\): ${setup}`));
  assert.doesNotMatch(
    agentsync.renderTicketBriefing(Object.assign({}, ticket, { dispatch: { sharedTree: true } }), 'shared-token', slug),
    /Worktree setup \(run before verify\):/,
  );

  store.setBoardConfig(slug, { worktreeSetup: null });
  assert.doesNotMatch(agentsync.renderTicketBriefing(ticket, 'unset-token', slug), /Worktree setup \(run before verify\):/);
  assert.throws(() => store.setBoardConfig(slug, { worktreeSetup: 'npm ci\nnode --test' }), /one-line command/);
  assert.throws(() => store.setBoardConfig(slug, { worktreeSetup: 'x'.repeat(1001) }), /1000-character/);
});

test('renderTicketBriefing embeds no route marker for a Claude-backed route', () => {
  clearCatalog();
  const briefing = agentsync.renderTicketBriefing({
    ref: 'SQ-347', title: 'Claude route', model: 'opus', effort: 'high',
    dispatchExecutor: 'sidequest-exec-high', category: {},
  }, 'claude-token-347');
  assert.doesNotMatch(briefing, /\[sidequest-route model=/);
  assert.match(briefing, /Closeout: submit for repo work; otherwise done --model opus --effort high\. Put the full final report in the terminal board comment, then stop without a routine SendMessage\./);
});

test('renderTicketBriefing omits closeout when the ticket route is unresolved', () => {
  clearCatalog();
  const briefing = agentsync.renderTicketBriefing({
    ref: 'SQ-733', title: 'Unresolved route', model: 'codex-missing', effort: 'high', category: {},
  }, 'unresolved-token');
  assert.doesNotMatch(briefing, /Closeout:/);
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
  const createOldTicketFile = (name?: any, sessionId?: any) => {
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
  const names = readDir(dir).map((file: string) => file.replace(/\.md$/, ''));
  assert.ok(names.length > 0, 'sync must write executor definitions');
  for (const name of names) {
    const { kind } = classify(name);
    assert.ok(
      ['codex_dispatch', 'claude_builtin'].includes(kind),
      `${name} did not classify to a stable kind (got ${kind})`,
    );
  }
});

export {};
