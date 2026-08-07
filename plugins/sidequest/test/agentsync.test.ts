import './_temp-cleanup.js';
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

const TERRA = { slug: 'codex-gpt-5-6-terra', id: 'claude-gpt-5.6-terra[1m]', label: 'GPT-5.6 Terra' };
const SOL = { slug: 'codex-gpt-5-6-sol', id: 'claude-gpt-5.6-sol[1m]', label: 'GPT-5.6 Sol' };
const PROJECT_ONLY = { slug: 'codex-gpt-5-6-project-only', id: 'claude-gpt-5.6-project-only[1m]', label: 'GPT-5.6 Project Only' };

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Codex dispatch executors are effort-collapsed: model AND effort ride the route
// marker, so the stable set is 2 shared dispatch defs plus the per-effort Claude ladder.
const STABLE_EXECUTORS = [
  'sidequest-exec-dispatch.md',
  'sidequest-exec-dispatch-readonly.md',
  ...EFFORTS.flatMap((effort) => [
    `sidequest-exec-${effort}.md`,
    `sidequest-exec-readonly-${effort}.md`,
  ]),
].sort();

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sq-agentsync-test-')); }
function git(dir: string, args: string[]) { return spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true }); }
function readDir(dir?: any) { return fs.readdirSync(dir).filter((file: string) => file.endsWith('.md')).sort(); }
function parseExecutorFrontmatter(source: string) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match || match[1] == null) throw new Error('executor definition must begin with frontmatter');
  const frontmatter = new Map<string, string[]>();
  let list: string[] | null = null;
  for (const line of match[1].split(/\r?\n/)) {
    const property = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/);
    if (property) {
      const key = property[1];
      if (!key) continue;
      const value = property[2]?.trim() || '';
      const items = value ? value.split(', ').map((item) => item.trim()) : [];
      frontmatter.set(key, items);
      list = value ? null : items;
      continue;
    }
    const listItem = line.match(/^  - (.+)$/)?.[1];
    if (list && listItem) list.push(listItem);
  }
  return Object.fromEntries(frontmatter);
}
function seedCatalog(models?: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-agentsync-catalog-'));
  fs.mkdirSync(path.join(dir, 'model-gateway'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'model-gateway', 'catalog.json'), JSON.stringify({
    schemaVersion: 3,
    source: 'model-gateway',
    codexReadiness: { ready: true, state: 'ready', message: 'Codex readiness confirms the local gateway is ready.' },
    models,
  }));
  process.env.SIDEQUEST_DISCOVERY_DIRS = dir;
}
function clearCatalog() { process.env.SIDEQUEST_DISCOVERY_DIRS = NO_CATALOG_DIR; }
function configure(store?: any, id?: any, route?: any, fallback?: any) {
  store.setCategory({ id, name: id, route, fallback: fallback || null, enabled: true });
}

test('briefings surface tracked generated outputs paired into effective scope', () => {
  const root = tmpDir();
  assert.equal(git(root, ['init']).status, 0);
  assert.equal(git(root, ['config', 'user.name', 'Sidequest Test']).status, 0);
  assert.equal(git(root, ['config', 'user.email', 'sidequest-test@example.invalid']).status, 0);
  const source = 'plugins/sidequest/src/hooks/brief.ts';
  const output = 'plugins/sidequest/hooks/brief.js';
  fs.mkdirSync(path.dirname(path.join(root, source)), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(root, output)), { recursive: true });
  fs.writeFileSync(path.join(root, source), 'export const brief = true;\n');
  fs.writeFileSync(path.join(root, output), 'exports.brief = true;\n');
  assert.equal(git(root, ['add', '.']).status, 0);
  assert.equal(git(root, ['commit', '-m', 'fixture']).status, 0);
  const store = require('../lib/store.js');
  const slug = store.ensureProject(root, 'generated brief').slug;
  store.setBoardConfig(slug, { generatedPairs: [{ from: 'plugins/*/src/hooks/*.ts', to: 'plugins/*/hooks/*.js' }] });
  const ticket = store.createTicket(slug, { title: 'brief pair', files: [source], complexity: 2, complexityWhy: 'A tracked generated output must be visible to the executor.' });
  const briefing = agentsync.renderTicketBriefing(ticket, 'generated-brief-token', slug, root);
  assert.match(briefing, /Auto-paired tracked generated files \(regenerate before verifying\):/);
  assert.equal((briefing.match(/Auto-paired tracked generated files/g) || []).length, 1);
  assert.match(briefing, /plugins\/sidequest\/hooks\/brief\.js/);
  store.setBoardConfig(slug, { generatedPairs: [] });
  assert.doesNotMatch(agentsync.renderTicketBriefing(ticket, 'empty-generated-brief-token', slug, root), /Auto-paired tracked generated files/);
});

test('dispatch uncertainty does not inspect symbols named in ticket text', () => {
  const root = tmpDir();
  assert.equal(git(root, ['init', '-b', 'main']).status, 0);
  assert.equal(git(root, ['config', 'user.name', 'Sidequest Test']).status, 0);
  assert.equal(git(root, ['config', 'user.email', 'sidequest-test@example.invalid']).status, 0);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'fixture.ts'), 'const existingSymbol = true;\n');
  assert.equal(git(root, ['add', '.']).status, 0);
  assert.equal(git(root, ['commit', '-m', 'fixture']).status, 0);

  const store = require('../lib/store.js');
  const slug = store.ensureProject(root, 'dispatch uncertainty').slug;
  const ticket = store.createTicket(slug, {
    title: 'Change `missingSymbol()` and `existingSymbol`',
    description: 'A ticket may mention code-like identifiers and arbitrary backticked text such as `c_msampch0_3ac24a`.',
    files: ['src'],
  });

  const warnings = store.dispatchUncertaintyWarnings(ticket, slug);
  assert.deepStrictEqual(warnings, []);
  const briefing = agentsync.renderTicketBriefing(ticket, 'uncertainty-token', slug, root);
  assert.doesNotMatch(briefing, /ticket text includes|current main snapshot/);
});

test('dispatch uncertainty warns when a greenfield verify path does not exist', () => {
  const root = tmpDir();
  assert.equal(git(root, ['init', '-b', 'main']).status, 0);
  assert.equal(git(root, ['config', 'user.name', 'Sidequest Test']).status, 0);
  assert.equal(git(root, ['config', 'user.email', 'sidequest-test@example.invalid']).status, 0);
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  assert.equal(git(root, ['add', '.']).status, 0);
  assert.equal(git(root, ['commit', '-m', 'fixture']).status, 0);

  const store = require('../lib/store.js');
  const slug = store.ensureProject(root, 'greenfield verify path').slug;
  const ticket = store.createTicket(slug, {
    title: 'Create future verifier',
    executorVerify: 'node --test test/future.test.ts',
  });

  const warnings = store.dispatchUncertaintyWarnings(ticket, slug).join('\n');
  assert.match(warnings, /recorded verify references paths absent from this repo: test\/future\.test\.ts/);
  assert.match(agentsync.renderTicketBriefing(ticket, 'greenfield-token', slug, root), /greenfield work/);
});


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
  assert.match(briefing, /Verify completion discipline: the harness does not expose your remaining tool-call budget/);
  assert.match(briefing, /Plan against the observed ~90-call backstop/);
  assert.match(briefing, /Run the declared verify command as soon as a first implementation-ready change is in place/);
  assert.match(briefing, /If a deliberate checkpoint is necessary before verification, say explicitly that verification was not reached and why/);
  assert.match(briefing, /plugins\/sidequest\/src\/lib\/agentsync\.ts/);
  assert.match(briefing, /briefing\.png/);
});

test('SQ-929: experiment log briefings carry the bounded packet and the continuation target', () => {
  const store = require('../lib/store.js');
  const slug = store.ensureProject(tmpDir(), 'experiment briefing').slug;
  const created = store.createTicket(slug, {
    title: 'Experiment briefing fixture',
    description: 'Run one hypothesis.',
    category: 'coding.normal',
    files: ['fixture.ts'],
  });
  for (let round = 1; round <= 4; round++) {
    assert.equal(store.appendExperimentEntry(slug, created.ref, {
      round,
      headline: `round ${round}`,
      measured: '測'.repeat(6_000),
    }).ok, true);
  }

  const ticket = Object.assign({}, store.getTicket(slug, created.ref), {
    dispatch: { launchSeq: 5 },
  });
  const briefing = agentsync.renderTicketBriefing(ticket, 'experiment-token', slug);
  const section = briefing.match(/Experiment log:\n([\s\S]*?)\n\nDeclared files:/);

  assert.ok(section);
  assert.ok(Buffer.byteLength(section![1], 'utf8') <= 12 * 1024, `experiment packet is ${Buffer.byteLength(section![1], 'utf8')} bytes`);
  assert.ok(section![1].includes(`Read the full log at \`${store.assetPath(slug, created.id, `experiment-${created.ref}.md`)}\` before the first edit.`));
  assert.match(section![1], new RegExp(`Round checkout target: refs/sidequest/${created.ref}/r4 \\(continue from the prior round\\)\\.`));

  const withoutLog = agentsync.renderTicketBriefing(Object.assign({}, ticket, { id: 'no-log', ref: 'SQ-no-log' }), 'experiment-token', slug);
  assert.doesNotMatch(withoutLog, /Experiment log:/);
});

test('SQ-1015: a plan document briefing carries only the path, never the body, and grows by roughly one line', () => {
  const store = require('../lib/store.js');
  const slug = store.ensureProject(tmpDir(), 'plan briefing').slug;
  const upstream = store.getTicket(slug, store.createTicket(slug, {
    title: 'Upstream plan ticket', description: 'Has a plan.', category: 'coding.normal', files: ['fixture.ts'],
  }).ref);

  const beforeBriefing = agentsync.renderTicketBriefing(upstream, 'plan-token', slug);
  assert.doesNotMatch(beforeBriefing, /Plan document:/);

  // writeTicketPlan trims like a comment does, so end the fixture on a
  // non-whitespace character to compare the stored body byte-for-byte.
  const planBody = `# Plan\n\n${'測試 '.repeat(20_000)}x`;
  assert.ok(Buffer.byteLength(planBody, 'utf8') > 50 * 1024, 'fixture plan exceeds 50 KB');
  const written = store.writeTicketPlan(slug, upstream.ref, 'planner', planBody);
  assert.equal(written.ok, true);
  assert.strictEqual(fs.readFileSync(written.path, 'utf8'), planBody);

  // Re-render with the same (stale) ticket object: everything else in the
  // packet is byte-identical, so any growth is isolated to the plan line.
  const afterBriefing = agentsync.renderTicketBriefing(upstream, 'plan-token', slug);
  const grown = Buffer.byteLength(afterBriefing, 'utf8') - Buffer.byteLength(beforeBriefing, 'utf8');
  assert.ok(grown > 0 && grown < 500, `briefing grew by ${grown} bytes, expected roughly one path line, not the ~50 KB body`);
  assert.ok(afterBriefing.includes(`Plan document: \`${written.path}\``));
  assert.match(afterBriefing, /revision 1, planner,/);
  assert.doesNotMatch(afterBriefing, /測試 測試 測試/, 'the plan body itself is never inlined into a briefing');
});

test('SQ-1015: a dependency line carries the upstream plan path on blocks/blocked-by edges, not on related', () => {
  const store = require('../lib/store.js');
  const slug = store.ensureProject(tmpDir(), 'plan dependency briefing').slug;
  const upstream = store.createTicket(slug, { title: 'Upstream', category: 'coding.normal', files: ['fixture.ts'] });
  const dependent = store.createTicket(slug, { title: 'Dependent', category: 'coding.normal', files: ['fixture.ts'] });
  const sibling = store.createTicket(slug, { title: 'Sibling', category: 'coding.normal', files: ['fixture.ts'] });

  const written = store.writeTicketPlan(slug, upstream.ref, 'planner', '# Upstream plan\n\nContext for dependents.');
  assert.equal(written.ok, true);

  store.linkTickets(slug, dependent.ref, 'depends-on', upstream.ref);
  store.linkTickets(slug, sibling.ref, 'related', upstream.ref);

  const dependentBriefing = agentsync.renderTicketBriefing(store.getTicket(slug, dependent.ref), 'plan-token', slug);
  assert.match(dependentBriefing, new RegExp(`- blocked-by: ${upstream.ref} \\(plan: ${written.path.replace(/[\\.]/g, '\\$&')}\\)`));

  const siblingBriefing = agentsync.renderTicketBriefing(store.getTicket(slug, sibling.ref), 'plan-token', slug);
  assert.match(siblingBriefing, new RegExp(`- related: ${upstream.ref}$`, 'm'));
  assert.doesNotMatch(siblingBriefing, /related:[^\n]*\(plan:/, 'a related link carries no ordering relationship, so no plan pointer');

  const upstreamBriefing = agentsync.renderTicketBriefing(store.getTicket(slug, upstream.ref), 'plan-token', slug);
  assert.match(upstreamBriefing, new RegExp(`- blocks: ${dependent.ref}$`, 'm'), 'the upstream side has no plan of its own to point at');
});

test('story execution contracts lead member briefings from their dispatch snapshot', () => {
  const ticket = {
    ref: 'SQ-750', title: 'Member scope', model: 'opus', effort: 'high', category: {},
    storyId: 'story-execution-contract',
    dispatch: { storyContract: { revision: 3, body: 'Frozen decision: keep packet order.\n\nInvariant: do not rebrief claimed work.' } },
  };
  const briefing = agentsync.renderTicketBriefing(ticket, 'story-contract-token');
  assert.match(briefing, /## Story execution contract \(revision 3\)/);
  assert.match(briefing, /Frozen decision: keep packet order/);
  assert.ok(briefing.indexOf('## Story execution contract') < briefing.indexOf('## This ticket'));
  assert.ok(briefing.indexOf('Invariant: do not rebrief claimed work.') < briefing.indexOf('Ref: SQ-750'));
});

test('story decision logs render live after frozen contract snapshots', () => {
  const store = require('../lib/store.js');
  const slug = store.ensureProject(tmpDir(), 'story decision log briefing').slug;
  const story = store.createStory(slug, { title: 'Live log', executionContract: 'Current contract body.' });
  const created = store.createTicket(slug, { title: 'Log member', storyId: story.id });
  const ticket = Object.assign({}, store.getTicket(slug, created.ref), {
    model: 'opus', effort: 'high', category: {},
    dispatch: { storyContract: { revision: 3, body: 'Frozen contract snapshot.' } },
  });

  const before = agentsync.renderTicketBriefing(ticket, 'story-log-token', slug);
  assert.doesNotMatch(before, /## Story decision log/);
  assert.match(before, /Frozen contract snapshot\./);
  assert.doesNotMatch(before, /Current contract body\./);

  assert.equal(store.claimTicket(slug, created.ref, 'exec-a').ok, true);
  store.appendStoryLogEntry(slug, story.ref, {
    ref: created.ref, by: 'exec-a', kind: 'DISCOVERY', text: 'Render from the live story record.',
  });
  store.appendStoryLogEntry(slug, story.ref, {
    ref: created.ref, by: 'exec-a', kind: 'CONSTRAINT', text: 'Keep the dispatch contract frozen.',
  });

  const after = agentsync.renderTicketBriefing(ticket, 'story-log-token', slug);
  const packet = after.match(/## Story decision log[\s\S]*?(?=\n\n## This ticket)/);
  assert.ok(packet);
  assert.ok(Buffer.byteLength(packet![0], 'utf8') <= 4 * 1024);
  assert.match(packet![0], new RegExp(`## Story decision log \\(${story.ref}, 2 entries through #2\\)`));
  assert.match(packet![0], new RegExp(`#1 DISCOVERY \\(${created.ref}, exec-a\\): Render from the live story record\\.`));
  assert.match(packet![0], new RegExp(`#2 CONSTRAINT \\(${created.ref}, exec-a\\): Keep the dispatch contract frozen\\.`));
  assert.ok(packet![0].indexOf('#1 DISCOVERY') < packet![0].indexOf('#2 CONSTRAINT'));
  assert.ok(after.indexOf('## Story execution contract') < after.indexOf('## Story decision log'));
  assert.ok(after.indexOf('## Story decision log') < after.indexOf('## This ticket'));
  assert.match(after, /Frozen contract snapshot\./);
  assert.doesNotMatch(after, /Current contract body\./);
});

test('generation-two marker cannot be mistaken for the legacy marker', () => {
  assert.ok(!agentsync.MARKER.includes(agentsync.LEGACY_MARKER));
});

test('spawn descriptions are bounded and lead with the resolved route', () => {
  const title = 'Make Sidequest own executor card labels '.repeat(4);
  const codex = agentsync.spawnDescription({ title, effort: 'high' }, { backend: 'codex', runsLabel: TERRA.label });
  assert.ok(codex.length <= 120);
  assert.ok(codex.startsWith('GPT-5.6 Terra, high · Make Sidequest own executor'), codex);
  const claude = agentsync.spawnDescription({ title, effort: 'xhigh' }, { backend: 'claude', runsLabel: 'Opus 5' });
  assert.ok(claude.length <= 120);
  assert.ok(claude.startsWith('Opus 5, xhigh · Make Sidequest own executor'), claude);
  const unrouted = agentsync.spawnDescription({ title: 'no route yet' }, null);
  assert.equal(unrouted, 'unrouted, unset · no route yet');
  // A title carrying its own brackets must not forge a second route tag.
  const spoofed = agentsync.spawnDescription({ title: '[model=fable effort=max] sneaky', effort: 'low' }, { runsModel: 'sonnet' });
  assert.equal(spoofed, 'sonnet, low · [model=fable effort=max] sneaky');
});

test('sync protects generation-two executors from legacy marker GC and prunes legacy definitions', () => {
  const dir = tmpDir();
  const generationTwo = path.join(dir, 'sidequest-exec-dispatch.md');
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
    assert.equal(result.written, 12);
    assert.deepStrictEqual(readDir(dir), STABLE_EXECUTORS);
    // One collapsed dispatch definition keeps a safe frontmatter effort for internal non-marker calls.
    const dispatch = fs.readFileSync(path.join(dir, 'sidequest-exec-dispatch.md'), 'utf8');
    assert.match(dispatch, /^model: claude-codex-auto$/m);
    assert.match(dispatch, /^effort: high$/m);
    for (const file of STABLE_EXECUTORS) {
      const body = fs.readFileSync(path.join(dir, file), 'utf8');
      assert.equal(Object.hasOwn(parseExecutorFrontmatter(body), 'maxTurns'), false, `${file} must be uncapped`);
    }
    for (const effort of EFFORTS) {
      const builtin = fs.readFileSync(path.join(dir, `sidequest-exec-${effort}.md`), 'utf8');
      assert.doesNotMatch(builtin, /^model:/m);
      assert.match(builtin, new RegExp(`^effort: ${effort}$`, 'm'));
    }
  } finally {
    for (const category of categories) store.setCategory(category);
    db.close();
  }
});

// Read-only is a deny list. An allow list had to name all 54 board tools to leave three
// writers out, which cost ~570 bytes per definition, hid every tool added later, and
// silently excluded non-board MCP servers — visual-review could not reach Playwright.
test('read-only stable executors deny writers while retaining default non-skill tools', () => {
  const dir = tmpDir();
  agentsync.syncExecAgents(null, { dir });

  for (const file of ['sidequest-exec-dispatch-readonly.md', 'sidequest-exec-readonly-high.md']) {
    const body = fs.readFileSync(path.join(dir, file), 'utf8');
    const frontmatter = parseExecutorFrontmatter(body);
    assert.deepStrictEqual(frontmatter.tools, ['default', 'Skill(playbook:verify-discipline)']);
    const denied = body.match(/^disallowedTools: (.+)$/m);
    assert.ok(denied, `${file} must carry a disallowedTools line`);
    for (const writer of ['Edit', 'Write', 'NotebookEdit']) {
      assert.ok(denied![1].includes(writer), `${file} must deny ${writer}`);
    }
    // Playwright, Context7, and the board are read-only work's actual tools; denying them was the
    // accidental side effect of the old allow list.
    assert.doesNotMatch(denied![1], /playwright|context7|mcp__plugin_sidequest_board__/i);
    // Bash stays, so this is not a write-proof sandbox and must not claim to be.
    assert.doesNotMatch(body, /tools cannot change files/i);
  }

  for (const file of ['sidequest-exec-dispatch.md', 'sidequest-exec-high.md']) {
    const body = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.deepStrictEqual(parseExecutorFrontmatter(body).tools, ['default', 'Skill(playbook:verify-discipline)']);
    assert.doesNotMatch(body, /^disallowedTools:/m);
  }
});

test('a newly registered board tool needs no agentsync change to reach read-only executors', () => {
  // The old allow list named every board tool, so adding one silently withheld it until
  // someone updated ten lists. Nothing may name board tools for grant purposes now.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'agentsync.ts'), 'utf8');
  // A grant list would name all 54. A handful of references is fine: the briefing shows
  // the executor how to call claim, which is an example, not a grant.
  const named = new Set(source.match(/mcp__plugin_sidequest_board__[a-zA-Z_]+/g) || []);
  assert.ok(named.size <= 2,
    `agentsync names ${named.size} board tools; read-only is a deny list, so it must not enumerate grants: ${[...named].join(', ')}`);
});

test('read-only executor denylists add configured MCP tools without dropping the writers', () => {
  const body = agentsync.renderReadOnlyDispatchAgent('high', ['mcp__notion__search']);
  assert.deepStrictEqual(parseExecutorFrontmatter(body).tools, ['default', 'Skill(playbook:verify-discipline)']);
  assert.match(body, /^disallowedTools: .*\bEdit\b/m);
  assert.match(body, /^disallowedTools: .*mcp__notion__search/m);
  assert.match(agentsync.renderReadOnlyClaudeAgent('high', ['mcp__plugin_svelte_svelte__*']), /^disallowedTools: .*mcp__plugin_svelte_svelte__\*/m);
  assert.notEqual(
    agentsync.stableInstallHash(agentsync.EXECUTOR_SKILLS, ['mcp__notion__search']),
    agentsync.stableInstallHash(agentsync.EXECUTOR_SKILLS, ['mcp__github__create_issue']),
  );
});

test('stable executors preload only declared skills', () => {
  const dir = tmpDir();
  agentsync.syncExecAgents(null, { dir });

  for (const file of [
    'sidequest-exec-dispatch.md',
    'sidequest-exec-high.md',
    'sidequest-exec-dispatch-readonly.md',
    'sidequest-exec-readonly-high.md',
  ]) {
    const body = fs.readFileSync(path.join(dir, file), 'utf8');
    const frontmatter = parseExecutorFrontmatter(body);
    assert.deepStrictEqual(frontmatter.skills, ['playbook:verify-discipline']);
    assert.deepStrictEqual(frontmatter.tools, ['default', 'Skill(playbook:verify-discipline)']);
  }

  const unrestricted = parseExecutorFrontmatter(agentsync.renderExecAgent({
    name: 'unrestricted-control',
    effort: 'high',
    tools: null,
  }));
  assert.equal(Object.hasOwn(unrestricted, 'tools'), false);

  assert.notEqual(
    agentsync.stableInstallHash(),
    agentsync.stableInstallHash([...agentsync.EXECUTOR_SKILLS, 'sidequest:another-skill']),
  );
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
  assert.ok(readDir(dir).includes('sidequest-exec-dispatch.md'));
});


test('dispatch executors use a safe frontmatter effort without a turn cap', () => {
  for (const body of [
    agentsync.renderDispatchAgent(),
    agentsync.renderReadOnlyDispatchAgent(),
  ]) {
    assert.match(body, /^effort: high$/m);
    assert.doesNotMatch(body, /^effort: max$/m);
    assert.equal(Object.hasOwn(parseExecutorFrontmatter(body), 'maxTurns'), false);
  }
});


test('sync writes route-independent generated executors', () => {
  seedCatalog([TERRA, SOL]);
  const store = require('../lib/store.js');
  configure(store, 'sync-terra', { model: TERRA.slug, effort: 'high' }, { model: 'opus', effort: 'high' });
  const dir = tmpDir();
  const result = agentsync.syncExecAgents(null, { dir });
  assert.equal(result.written, 12);
  assert.deepStrictEqual(readDir(dir), STABLE_EXECUTORS);
  const body = fs.readFileSync(path.join(dir, 'sidequest-exec-dispatch.md'), 'utf8');
  assert.match(body, /^model: claude-codex-auto$/m);
  assert.ok(body.includes(agentsync.MARKER));
  assert.equal(agentsync.EXECUTOR_CHECKPOINT_TOOL_ROUNDS, 100);
  assert.doesNotMatch(body, /verified milestone/);
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
  const filePath = path.join(dir, 'sidequest-exec-dispatch.md');
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
  assert.equal(first.written, 12);
  const second = agentsync.syncExecAgentsIfChanged(null, { dir });
  assert.deepStrictEqual(second, {
    written: 0,
    removed: 0,
    unchanged: 0,
    skipped: true,
    installHash: first.installHash,
  });
});

test('native dispatch fallback names Claude agents after their runtime', () => {
  const dir = tmpDir();
  const created = agentsync.createNativeAgent({
    ref: 'SQ-249', agentType: 'sidequest-exec-high',
    runsModel: 'opus', effort: 'high', sessionId: 'session-249',
  }, { dir, waitMs: 0 });
  assert.strictEqual(created.fallback, true);
  assert.strictEqual(created.name, 'sidequest-native-sq-249-opus');
  assert.strictEqual(created.file, null);
  assert.deepStrictEqual(readDir(dir), []);
});

test('dispatch intent controls worktree isolation regardless of declared files', () => {
  assert.equal(agentsync.ticketIsolation({ files: ['plugins/sidequest'] }, false), 'worktree');
  assert.equal(agentsync.ticketIsolation({ files: [] }, false), 'worktree');
  assert.equal(agentsync.ticketIsolation({}, false), 'worktree');
  assert.equal(agentsync.ticketIsolation({ files: ['plugins/sidequest'] }, true), null);
  assert.equal(agentsync.ticketIsolation({ files: [] }, true), null);

  const created = agentsync.createNativeAgent({
    ref: 'SQ-396', agentType: 'sidequest-exec-dispatch', runtime: 'codex-gpt-5-6-terra',
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

test('SQ-677: fetched briefing carries the complete durable packet while the spawn carries bounded implementation context', () => {
  seedCatalog([TERRA]);
  const slug = 'briefing-測試';
  const ticket = {
    id: 'briefing-assets', ref: 'SQ-334', title: 'Instant dispatch',
    description: 'First paragraph.\n\n- markdown keeps its **exact** shape\n- blank lines stay blank\n\nUnicode survives: 測試 🧪',
    model: TERRA.slug, effort: 'high', dispatchExecutor: 'sidequest-exec-dispatch',
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

  const briefing = agentsync.renderTicketBriefing(ticket, 'instant-token-334', slug, 'C:\\dev\\fixture');
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
  assert.match(briefing, /mcp__plugin_sidequest_board__claim\(\{/);
  assert.ok(briefing.includes('ref: "SQ-334"'));
  assert.ok(briefing.includes('executor: "sidequest-exec-dispatch"'));
  assert.ok(briefing.includes('effort: "high"'));
  assert.ok(briefing.includes(`project: ${JSON.stringify('C:\\dev\\fixture')}`));
  assert.ok(briefing.includes('token: "instant-token-334"'));
  assert.match(briefing, /Do not pass `direct`\. Do not substitute the model slug for `executor`\./);
  assert.match(briefing, /Verify output discipline: run this single Node command in a Bash tool/);
  const captureScript = path.resolve(__dirname, '..', 'lib', 'verify-capture.js');
  assert.ok(path.isAbsolute(captureScript));
  assert.ok(fs.existsSync(captureScript));
  assert.ok(!captureScript.startsWith('plugins/'));
  assert.ok(briefing.includes(`node "${captureScript}" --base64 bm9kZSAtLXRlc3QgcGx1Z2lucy9zaWRlcXVlc3QvdGVzdC9hZ2VudHN5bmMudGVzdC5qcw==`));
  assert.match(briefing, /verify=<passed\|failed-suite\|could-not-run>/);
  assert.match(briefing, /could-not-run.*do not call the suite red/);
  assert.match(briefing, /integrator owns the merged-tree full gate/);
  assert.match(briefing, /Verify liveness: immediately before running the exact verify command/);
  assert.match(briefing, /\[sidequest:verify-start\] <command>/);
  assert.match(briefing, /\[sidequest:verify-complete\] could-not-run/);
  assert.match(briefing, /Billable resources: when this work creates a cloud pod, VM, or other billable external resource, comment its id on the ticket immediately and terminate it before every stop, including error paths\./);
  assert.match(briefing, /Closeout: this prepared dispatch is write-capable\. Commit scoped repo changes, then submit with the commit hash, verification evidence, and final report\./);
  assert.match(briefing, /keep the terminal board comment to the commit hash, verify evidence, and a reference to the submission instead of repeating its narrative/);
  assert.match(briefing, /Non-repo done comments still carry the full report/);
  assert.match(briefing, /Priority: urgent/);
  assert.match(briefing, /Story: US-99/);
  assert.match(briefing, /blocked-by: SQ-12/);
  assert.match(briefing, /docs\/briefing notes\.md/);
  assert.match(briefing, /A declared directory covers descendants/);
  assert.match(briefing, /first uncovered scope miss/);
  assert.match(briefing, /one consolidated request/);
  assert.match(briefing, /tests, fixtures, goldens, and generated outputs/);
  assert.match(briefing, /Keep your claim held/);
  assert.match(briefing, /pass the current linked worktree/);
  assert.match(briefing, /Do not release or weaken scope lint/);
  assert.match(briefing, /space file\.png/);
  assert.match(briefing, /画像\.png/);
  assert.match(briefing, /Inspect this attachment before implementation\./);
  assert.match(briefing, /missing file\.png.*missing or unreadable/s);
  assert.match(briefing, /inspect every entry before implementation/i);
  assert.ok(briefing.trimEnd().endsWith('[sidequest-route model=gpt-5.6-terra effort=high]'));
  assert.ok(stub.startsWith('[sidequest-route model=gpt-5.6-terra effort=high]\n'));
  assert.ok(Buffer.byteLength(stub) < 1600, `spawn context is ${Buffer.byteLength(stub)} bytes`);
  assert.match(stub, /Title: Instant dispatch/);
  assert.match(stub, /Description:\ny{128}/);
  assert.match(stub, /Description excerpt capped\. Full body is in briefing\./);
  assert.match(stub, /Declared files:\n- plugins\/sidequest\/src\/lib\/agentsync\.ts\n- docs\/briefing notes\.md/);
  assert.match(stub, /Anchors:\nlib\/store\.js prepareDispatch/);
  assert.doesNotMatch(stub, /z{1000}/);
  assert.doesNotMatch(stub, /Complete comment thread/);
  assert.match(stub, /FIRST action: run `node .*sidequest-launcher\.js" briefing SQ-334 --token instant-token-334 --project "C:\\dev\\fixture"`/);
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
  assert.match(active, /Do not apply the linked-worktree self-check, commit, or submit/);

  for (const dispatch of [
    { sharedTree: true, artifactMode: false },
    { sharedTree: false, artifactMode: false },
  ]) {
    const ordinary = agentsync.renderTicketBriefing(Object.assign({}, base, { dispatch }), 'ordinary-token');
    assert.doesNotMatch(ordinary, /\[sidequest-artifact-mode\]/);
  }
});

test('briefings surface resolved worktree identities for linked and shared dispatches', () => {
  const root = tmpDir();
  const linkedWorktree = path.join(root, '.claude', 'worktrees', 'agent-briefing-worker');
  const base = {
    ref: 'SQ-1091', title: 'Surface worktree identity', model: 'opus', effort: 'high', category: {},
  };

  const linked = agentsync.renderTicketBriefing(Object.assign({}, base, {
    dispatch: { sharedTree: false, worktree: linkedWorktree },
  }), 'linked-token', undefined, root);
  assert.ok(linked.includes('Worktree identity: linked worktree'));
  assert.ok(linked.includes(`Path: ${linkedWorktree}`));
  assert.ok(linked.includes(`Git dir: ${path.join(root, '.git', 'worktrees', 'agent-briefing-worker')}`));
  assert.doesNotMatch(linked, /Working directory binding:/);

  const shared = agentsync.renderTicketBriefing(Object.assign({}, base, {
    dispatch: { sharedTree: true },
  }), 'shared-token', undefined, root);
  assert.ok(shared.includes('Worktree identity: shared tree'));
  assert.ok(shared.includes(`Path: ${root}`));
  assert.ok(shared.includes(`Git dir: ${path.join(root, '.git')}`));
  assert.ok(shared.includes(`Working directory binding: your inherited shell cwd is wherever the spawning session ran and may be a stale leftover worktree under ${root}${path.sep}.claude${path.sep}worktrees${path.sep}.`));
  assert.ok(shared.includes('Before any git or file operation, `cd "' + root + '"` and confirm `git rev-parse --show-toplevel` prints `' + root + '`.'));
  assert.match(shared, /If it still differs after cd, stop and report to the orchestrator\. Do not release or write anything in the wrong tree\./);
});

test('stale worktree cwd warnings identify dispatch-specific consequences', () => {
  const store = require('../lib/store.js');
  const projectRoot = tmpDir();
  const slug = store.ensureProject(projectRoot, 'stale worktree cwd warning').slug;
  const staleCwd = path.join(projectRoot, '.CLAUDE', 'WORKTREES', 'SQ-538-river-bluffs');
  const originalCwd = process.cwd;
  process.cwd = () => staleCwd;
  try {
    const sharedWarning = store.dispatchUncertaintyWarnings({ dispatch: { sharedTree: true } }, slug).join('\n');
    assert.match(sharedWarning, /Shared-tree dispatch/);
    assert.match(sharedWarning, /has no worktree of its own/);
    assert.match(sharedWarning, /whatever cwd it inherits/);
    assert.match(sharedWarning, /leftover/);
    assert.ok(sharedWarning.includes(projectRoot));

    const isolatedWarning = store.dispatchUncertaintyWarnings({ dispatch: { sharedTree: false } }, slug).join('\n');
    assert.match(isolatedWarning, /Isolated-worktree dispatch/);
    assert.match(isolatedWarning, /may fail to bind/);
    assert.match(isolatedWarning, /Restart the session/);
    assert.doesNotMatch(isolatedWarning, /Shared-tree dispatch/);

    process.cwd = () => projectRoot;
    assert.deepStrictEqual(store.dispatchUncertaintyWarnings({ dispatch: { sharedTree: true } }, slug), []);
    assert.deepStrictEqual(store.dispatchUncertaintyWarnings({ dispatch: { sharedTree: false } }, slug), []);
  } finally {
    process.cwd = originalCwd;
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

test('briefings synchronize stale worktrees to their recorded integration target', () => {
  const root = tmpDir();
  const commit = 'a'.repeat(40);
  const briefing = agentsync.renderTicketBriefing({
    ref: 'SQ-1334', title: 'Sync worktree', model: 'opus', effort: 'high', category: {},
    dispatch: {
      sharedTree: false,
      baseCommit: commit,
      integrationTarget: { mode: 'local', branch: 'main' },
    },
  }, 'sync-token', undefined, root);

  assert.ok(briefing.includes(`git merge-base --is-ancestor ${commit} HEAD`));
  assert.ok(briefing.includes(`git fetch "${root}" "main"`));
  assert.ok(briefing.includes(`git reset --hard ${commit}`));
  assert.ok(briefing.includes(`[sidequest:worktree-sync] synced to ${commit}`));
  assert.ok(briefing.includes('If fetching or resetting fails, stop and report the failure instead of working from the stale base.'));
});

test('renderTicketBriefing embeds no route marker for a Claude-backed route', () => {
  clearCatalog();
  const briefing = agentsync.renderTicketBriefing({
    ref: 'SQ-347', title: 'Claude route', model: 'opus', effort: 'high',
    dispatchExecutor: 'sidequest-exec-high', category: {},
  }, 'claude-token-347');
  assert.doesNotMatch(briefing, /\[sidequest-route model=/);
  assert.match(briefing, /Closeout: this prepared dispatch is write-capable\. Commit scoped repo changes, then submit with the commit hash, verification evidence, and final report\./);
  assert.match(briefing, /reference to the submission instead of repeating its narrative/);
});

test('renderTicketBriefing makes the prepared read-only closeout path explicit', () => {
  clearCatalog();
  const briefing = agentsync.renderTicketBriefing({
    ref: 'SQ-872', title: 'Read-only closeout', model: 'opus', effort: 'high',
    dispatchExecutor: 'sidequest-exec-readonly-high', category: {}, dispatch: { readonly: true },
  }, 'readonly-token-872');
  assert.match(briefing, /Closeout: this prepared dispatch is read-only\./);
  assert.match(briefing, /done --model opus --effort high/);
  assert.match(briefing, /Do not commit or submit\./);
});

test('briefings checkpoint findings for read-only and investigation work without burdening coding', () => {
  const base = { ref: 'SQ-1138', title: 'Checkpoint findings', model: 'opus', effort: 'high', dispatchExecutor: 'sidequest-exec-high' };
  const readOnly = agentsync.renderTicketBriefing({
    ...base, category: {}, dispatch: { readonly: true },
  }, 'readonly-checkpoint-token');
  assert.match(readOnly, /board comments are its only durable artifact/);
  assert.match(readOnly, /Post each substantive intermediate finding as a ticket comment when it lands/);
  assert.match(readOnly, /theory pass, a measurement, or a reproduction/);
  assert.match(readOnly, /not a progress diary/);

  const investigation = agentsync.renderTicketBriefing({
    ...base, category: { id: 'codebase-investigation', name: 'Codebase investigation' },
  }, 'investigation-checkpoint-token');
  assert.match(investigation, /This is analysis, research, or investigation work/);

  const coding = agentsync.renderTicketBriefing({
    ...base, category: { id: 'plugin-dev', name: 'Plugin development' },
  }, 'coding-checkpoint-token');
  assert.doesNotMatch(coding, /Durable finding checkpoints:/);
});

test('briefings reject compensating workarounds when the root cause is out of scope', () => {
  const briefing = agentsync.renderTicketBriefing({
    ref: 'SQ-1138', title: 'Scope wall', model: 'opus', effort: 'high', category: {},
  }, 'scope-wall-token');
  assert.match(briefing, /Always call `scopeRequest` with `wait: true`/);
  assert.match(briefing, /A `timeout` state is a wait, not a release/);
  assert.match(briefing, /checkpoint-and-hold work in hand/);
  assert.match(briefing, /call `scopeRequest` again with `wait: true` and the same worktree/);
  assert.match(briefing, /send main one blocker message naming the pending files/);
  assert.match(briefing, /Do not send a final response while the ruling is pending/);
  assert.match(briefing, /SubagentStop hook blocks normal executor shutdown/);
  assert.match(briefing, /When the root cause is outside declared scope, request that scope and wait/);
  assert.match(briefing, /record the root-cause finding on the ticket and stop/);
  assert.match(briefing, /Never ship a compensating or downstream workaround inside scope instead/);
  assert.match(briefing, /verified workaround is not a substitute for the root fix/);
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

// SQ-1004: a catalog.json left behind by a pre-3.x gateway still carries
// claude-codex- ids. Deriving the marker from it must land on the same backend
// id, or every dispatch on the board breaks until the catalog is rewritten.
test('workflow recipes derive the same marker from a pre-rename catalog', () => {
  seedCatalog([{ slug: TERRA.slug, id: 'claude-codex-gpt-5.6-terra[1m]', label: TERRA.label }]);
  const store = require('../lib/store.js');
  configure(store, 'workflow-legacy-codex', { model: TERRA.slug, effort: 'medium' });
  const category = Object.assign(store.getCategory('workflow-legacy-codex'), { project: 'recipe-project' });

  const recipe = agentsync.workflowRecipe(category, store.resolveCategoryRoute(category));
  assert.equal(recipe.agent.model, agentsync.DISPATCH_MODEL_ID);
  assert.equal(recipe.agent.promptPrefix, '[sidequest-route model=gpt-5.6-terra effort=medium]\n\n');
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

test('workflow recipes refuse a silent cross-provider fallback', () => {
  clearCatalog();
  const store = require('../lib/store.js');
  configure(store, 'workflow-fallback', { model: TERRA.slug, effort: 'high' }, { model: 'opus', effort: 'medium' });
  const category = Object.assign(store.getCategory('workflow-fallback'), { project: 'recipe-project' });
  const resolved = store.resolveCategoryRoute(category);

  assert.equal(resolved.exec, null);
  assert.equal(resolved.model, TERRA.slug);
  assert.match(resolved.warnings.join('\n'), /crosses providers and was refused/);
  assert.throws(() => agentsync.workflowRecipe(category, resolved), /resolved category route is required/i);
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
      ['codex_dispatch', 'claude_builtin', 'read_only_codex_dispatch', 'read_only_claude_builtin'].includes(kind),
      `${name} did not classify to a stable kind (got ${kind})`,
    );
  }
});

export {};
