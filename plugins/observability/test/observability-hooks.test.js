'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { normalizeObservation } = require('../lib/observability/ingest.js');
const { drainHookSpool } = require('../lib/observability/hook-spool.js');
const { openObservabilityStore } = require('../lib/observability/store.js');
const { canonicalPath } = require('../lib/observability/path-identity.js');
const { buildObservation, projectMetadata, repositoryRoot, spool, EVENT_MAP } = require('../hooks/observability.js');
const { buildStatuslineObservations } = require('../bin/statusline.js');

const NOW = new Date('2026-07-19T10:00:00.000Z');

function accept(observation) {
  const result = normalizeObservation(observation);
  assert.equal(result.accepted, true, `${observation && observation.event_name} rejected: ${JSON.stringify(result.rejectedFields)}`);
}

test('every mapped hook event yields an acceptable canonical observation', () => {
  const payloads = {
    SessionStart: { hook_event_name: 'SessionStart', session_id: 'session-1', source: 'resume', permission_mode: 'default', effort: { level: 'high' } },
    SessionEnd: { hook_event_name: 'SessionEnd', session_id: 'session-1', reason: 'logout' },
    UserPromptSubmit: { hook_event_name: 'UserPromptSubmit', session_id: 'session-1', prompt_id: 'prompt-9', permission_mode: 'acceptEdits' },
    PreToolUse: { hook_event_name: 'PreToolUse', session_id: 'session-1', tool_name: 'Bash', tool_use_id: 'toolu_1', permission_mode: 'default' },
    PostToolUse: { hook_event_name: 'PostToolUse', session_id: 'session-1', tool_name: 'mcp__plugin_sidequest_board__list', tool_use_id: 'toolu_2', status: 'ok' },
    Stop: { hook_event_name: 'Stop', session_id: 'session-1', reason: 'end_turn' },
    SubagentStop: { hook_event_name: 'SubagentStop', session_id: 'session-1', agent_id: 'agent-a', agent_type: 'sidequest-exec-dispatch-high', model: 'gpt-5.6-sol', status: 'completed' },
  };
  for (const [event, payload] of Object.entries(payloads)) {
    const observation = buildObservation({ ...payload, cwd: 'C:\\dev\\eigenwise-public\\eigenwise-toolshed' }, NOW);
    assert.equal(observation.event_name, EVENT_MAP[event]);
    assert.equal(observation.attributes.project_name, 'eigenwise-toolshed');
    assert.match(observation.project_id, /^[0-9a-f]{64}$/);
    if (event === 'SessionStart') assert.equal(observation.attributes.effort, 'high');
    accept(observation);
  }
});

test('every mapped hook event ingests without schema drops', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-hook-schema-'));
  const store = openObservabilityStore(path.join(dir, 'observability.db'), { outboxEnabled: false });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const payloads = [
    { hook_event_name: 'SessionStart', session_id: 'session-1', permission_mode: 'default', effort: 'medium' },
    { hook_event_name: 'SessionEnd', session_id: 'session-1', reason: 'logout' },
    { hook_event_name: 'UserPromptSubmit', session_id: 'session-1', permission_mode: 'acceptEdits' },
    { hook_event_name: 'PreToolUse', session_id: 'session-1', tool_name: 'mcp__server__read', permission_mode: 'default' },
    { hook_event_name: 'PostToolUse', session_id: 'session-1', tool_name: 'mcp__server__read', status: 'ok' },
    { hook_event_name: 'Stop', session_id: 'session-1', reason: 'end_turn' },
    { hook_event_name: 'SubagentStart', session_id: 'session-1', agent_type: 'worker', model: 'claude-test', effort: 'high' },
    { hook_event_name: 'SubagentStop', session_id: 'session-1', agent_type: 'worker', model: 'claude-test', effort: 'high', status: 'completed' },
    { hook_event_name: 'TaskCompleted', session_id: 'session-1', task_status: 'completed' },
  ];
  for (const payload of payloads) store.ingest(buildObservation(payload, NOW));
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM observation WHERE event_name = 'schema_drop'").get().count, 0);
});
test('session start emits the project basename and cwd hash, never the path itself', () => {
  const cwd = 'C:\\dev\\eigenwise-public\\eigenwise-toolshed';
  const observation = buildObservation({
    hook_event_name: 'SessionStart', session_id: 'session-1', source: 'startup', cwd,
  }, NOW);
  assert.equal(observation.attributes.project_name, 'eigenwise-toolshed');
  assert.match(observation.project_id, /^[0-9a-f]{64}$/);
  const serialized = JSON.stringify(observation);
  assert.equal(serialized.includes('eigenwise-public'), false, 'full path leaked into the observation');
  assert.equal(serialized.includes('C:\\\\dev'), false, 'path prefix leaked into the observation');
  accept(observation);

  const nameless = buildObservation({ hook_event_name: 'SessionStart', session_id: 'session-1', source: 'startup' }, NOW);
  assert.equal(nameless.attributes.project_name, undefined);
  assert.equal(nameless.project_id, undefined);
});

test('post-tool observations re-announce their project after an observer restart', () => {
  const observation = buildObservation({
    hook_event_name: 'PostToolUse',
    session_id: 'session-1',
    tool_name: 'Bash',
    cwd: 'C:\\dev\\eigenwise-public\\eigenwise-toolshed',
  }, NOW);
  assert.equal(observation.attributes.project_name, 'eigenwise-toolshed');
  assert.match(observation.project_id, /^[0-9a-f]{64}$/);
  accept(observation);
});

function temporaryTree(t, name) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-repo-identity-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, name);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('every working directory inside one repository reports as that repository', (t) => {
  const root = temporaryTree(t, 'sample-repo');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  const nested = path.join(root, 'apps', 'gui');
  fs.mkdirSync(nested, { recursive: true });

  const alias = path.join(path.dirname(root), `${path.basename(root)}-alias`);
  fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => fs.rmSync(alias, { recursive: true, force: true }));

  assert.equal(repositoryRoot(nested), root);
  assert.deepEqual(projectMetadata(nested), projectMetadata(root));
  assert.deepEqual(projectMetadata(alias), projectMetadata(root));
  assert.equal(projectMetadata(nested).project_name, 'sample-repo');
  assert.equal(projectMetadata(root).project_id, sha256(canonicalPath(root)));
});

test('canonical paths preserve missing segments after resolving their existing ancestor', (t) => {
  const root = temporaryTree(t, 'path-identity');
  fs.mkdirSync(root, { recursive: true });
  const alias = path.join(path.dirname(root), `${path.basename(root)}-alias`);
  fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => fs.rmSync(alias, { recursive: true, force: true }));

  assert.equal(
    canonicalPath(path.join(alias, 'missing', 'child')),
    canonicalPath(path.join(root, 'missing', 'child')),
  );
  assert.equal(
    canonicalPath(path.join(root, 'Missing', 'Child'), 'win32'),
    canonicalPath(path.join(root, 'missing', 'child'), 'win32'),
  );
});

test('a linked worktree or submodule reports as its main worktree, never as agent-<hash>', (t) => {
  const root = temporaryTree(t, 'sample-repo');
  const gitDir = path.join(root, '.git');
  const worktreeGitDir = path.join(gitDir, 'worktrees', 'agent-ab53c815804ab49dd');
  fs.mkdirSync(worktreeGitDir, { recursive: true });
  fs.writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n');
  const worktree = path.join(root, '.claude', 'worktrees', 'agent-ab53c815804ab49dd');
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${worktreeGitDir.replaceAll('\\', '/')}\n`);

  assert.deepEqual(projectMetadata(worktree), projectMetadata(root));
  assert.deepEqual(projectMetadata(path.join(worktree, 'plugins', 'workbench')), projectMetadata(root));

  const submodule = path.join(root, 'vendor', 'shared');
  fs.mkdirSync(path.join(gitDir, 'modules', 'shared'), { recursive: true });
  fs.mkdirSync(submodule, { recursive: true });
  fs.writeFileSync(path.join(submodule, '.git'), 'gitdir: ../../.git/modules/shared\n');
  assert.deepEqual(projectMetadata(submodule), projectMetadata(root));
});

test('project identity falls back to the directory itself outside a readable repository', (t) => {
  const loose = temporaryTree(t, 'loose-project');
  fs.mkdirSync(loose, { recursive: true });
  assert.equal(repositoryRoot(loose), null);
  assert.deepEqual(projectMetadata(loose), { project_id: sha256(canonicalPath(loose)), project_name: 'loose-project' });

  const broken = temporaryTree(t, 'broken-repo');
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, '.git'), 'this is not a gitdir pointer\n');
  assert.deepEqual(projectMetadata(broken), { project_id: sha256(canonicalPath(broken)), project_name: 'broken-repo' });

  assert.equal(repositoryRoot(path.join(broken, 'never', 'created')), null);
  assert.deepEqual(projectMetadata(''), {});
  assert.deepEqual(projectMetadata(undefined), {});
});

test('tool facets classify native vs MCP tools without capturing arguments', () => {
  const mcp = buildObservation({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'mcp__plugin_sidequest_board__list', tool_input: { secret: 'x' } }, NOW);
  assert.equal(mcp.attributes.is_mcp, true);
  assert.equal(mcp.attributes.mcp_server, 'plugin_sidequest_board');
  assert.equal(mcp.attributes.mcp_tool, 'list');
  const native = buildObservation({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash' }, NOW);
  assert.equal(native.attributes.is_mcp, false);
  assert.equal(native.attributes.tool_kind, 'native');
});

test('SendMessage observations retain recipient and source tool-use ID without retaining message text', () => {
  const observation = buildObservation({
    hook_event_name: 'PostToolUse',
    session_id: 'session-1',
    tool_name: 'SendMessage',
    tool_use_id: 'toolu-message-1',
    tool_input: { recipient: 'main', message: 'private milestone details' },
    status: 'ok',
  }, NOW);
  assert.equal(observation.attributes.recipient, 'main');
  assert.equal(observation.tool_use_id, 'toolu-message-1');
  assert.equal(JSON.stringify(observation).includes('private milestone details'), false);
  accept(observation);
});

test('PostToolUse measures serialized input and result sizes without retaining content', () => {
  const toolInput = { command: 'printf héllo' };
  const toolResponse = { stdout: 'private result', exitCode: 0 };
  const observation = buildObservation({
    hook_event_name: 'PostToolUse',
    session_id: 'session-1',
    tool_name: 'mcp__plugin_sidequest_board__list',
    tool_input: toolInput,
    tool_response: toolResponse,
    duration_ms: 12,
  }, NOW);
  const measurements = Object.fromEntries(observation.measurements.map((measurement) => [measurement.name, measurement]));
  const inputBytes = Buffer.byteLength(JSON.stringify(toolInput), 'utf8');
  const resultBytes = Buffer.byteLength(JSON.stringify(toolResponse), 'utf8');

  assert.equal(measurements.tool_input_bytes.value, inputBytes);
  assert.equal(measurements.tool_input_bytes.quality, 'exact_client');
  assert.equal(measurements.tool_input_tokens_estimate.value, inputBytes / 4);
  assert.equal(measurements.tool_input_tokens_estimate.quality, 'estimate');
  assert.equal(measurements.tool_result_bytes.value, resultBytes);
  assert.equal(measurements.tool_result_tokens_estimate.value, resultBytes / 4);
  assert.equal(measurements.tool_result_tokens_estimate.quality, 'estimate');
  assert.equal(measurements.duration_ms.value, 12);
  assert.equal(JSON.stringify(observation).includes('private result'), false);
  accept(observation);
});

test('hook observations never carry prompt, tool payloads, cwd, or transcript paths', () => {
  const observation = buildObservation({
    hook_event_name: 'PostToolUse',
    session_id: 'session-1',
    tool_name: 'Bash',
    tool_input: { command: 'cat /etc/passwd' },
    tool_response: 'root:x:0:0',
    prompt: 'DO NOT LEAK PROMPT',
    cwd: '/home/kenny/secret',
    transcript_path: '/home/kenny/.claude/transcript.jsonl',
  }, NOW);
  const serialized = JSON.stringify(observation);
  for (const secret of ['passwd', 'root:x', 'DO NOT LEAK', '/home/kenny', 'transcript']) {
    assert.equal(serialized.includes(secret), false, `leaked: ${secret}`);
  }
});

test('unknown hook events are ignored', () => {
  assert.equal(buildObservation({ hook_event_name: 'Notification', session_id: 's' }, NOW), null);
});

test('spool appends JSON lines and truncates rather than growing unbounded', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-hooks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const spoolPath = path.join(dir, 'nested', 'spool.jsonl');
  const observation = buildObservation({ hook_event_name: 'Stop', session_id: 's', reason: 'end_turn' }, NOW);
  assert.equal(spool(spoolPath, observation), true);
  assert.equal(spool(spoolPath, observation), true);
  const lines = fs.readFileSync(spoolPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).event_name, 'hook.stop');
  // Fail-open on an unwritable path (a file used as a directory component).
  const filePath = path.join(dir, 'blocker');
  fs.writeFileSync(filePath, 'x');
  assert.equal(spool(path.join(filePath, 'child.jsonl'), observation), false);
});

test('hook spool drains into the observer store and replays idempotently', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-hook-drain-'));
  const spoolPath = path.join(dir, 'hook-spool.jsonl');
  const store = openObservabilityStore(path.join(dir, 'observability.db'), { outboxEnabled: false });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const observation = buildObservation({
    hook_event_name: 'PostToolUse', session_id: 'session-1', tool_name: 'mcp__sidequest__list',
    tool_use_id: 'tool-1', status: 'ok', duration_ms: 42,
  }, NOW);
  spool(spoolPath, observation);
  spool(spoolPath, observation);
  fs.appendFileSync(spoolPath, '{malformed}\n');

  const projectId = 'a'.repeat(64);
  const result = drainHookSpool({ spoolPath, store, projectId, batchSize: 1 });
  assert.deepEqual(result, { drained: 1, duplicates: 1, rejected: 0, malformed: 1, droppedBytes: 0 });
  assert.equal(fs.existsSync(spoolPath), false);
  const [tool] = store.queryView('tool_calls');
  assert.equal(tool.mcp_server, 'sidequest');
  assert.equal(tool.mcp_tool, 'list');
  assert.equal(tool.duration_ms, 42);
  assert.equal(store.database.prepare('SELECT project_id FROM observation').get().project_id, projectId);
});

test('hook wake signals annotate only the first subsequent orchestrator request', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-wake-'));
  const store = openObservabilityStore(path.join(dir, 'observability.db'), { outboxEnabled: false });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const gateway = (id, at) => ({
    source: 'codex_gateway',
    source_event_id: id,
    source_schema: 'gateway-usage-v1',
    observed_at: at,
    event_name: 'gateway.token.usage',
    session_id: 'session-1',
    request_id: 'request-' + id,
    attributes: { agent_role: 'orchestrator', model: 'gpt-5.6-terra' },
  });

  const stop = buildObservation({
    hook_event_name: 'SubagentStop',
    session_id: 'session-1',
    agent_id: 'agent-worker',
  }, new Date('2026-07-19T10:00:00.000Z'));
  const first = gateway('wake-after-stop', '2026-07-19T10:00:01.000Z');
  const second = gateway('ordinary-request', '2026-07-19T10:00:02.000Z');
  store.ingestBatch([stop, first, second]);

  const sent = buildObservation({
    hook_event_name: 'PostToolUse',
    session_id: 'session-1',
    tool_name: 'SendMessage',
    tool_use_id: 'toolu-message-main',
    tool_input: { to: 'main', message: 'private handoff' },
  }, new Date('2026-07-19T10:00:03.000Z'));
  const afterMessage = gateway('wake-after-message', '2026-07-19T10:00:04.000Z');
  store.ingestBatch([sent, afterMessage]);

  const byRequest = Object.fromEntries(store.database.prepare(
    "SELECT request_id, attributes_json FROM observation WHERE event_name = 'gateway.token.usage'",
  ).all().map((row) => [row.request_id, JSON.parse(row.attributes_json)]));
  assert.equal(byRequest['request-wake-after-stop'].wake_reason, 'subagent_stop');
  assert.equal(byRequest['request-ordinary-request'].wake_reason, undefined);
  assert.equal(byRequest['request-wake-after-message'].wake_reason, 'teammate_message');
});

test('statusline emits acceptable context + rate-limit snapshots and marks missing usage unavailable', () => {
  const full = buildStatuslineObservations({
    session_id: 'session-1',
    model: { id: 'claude-opus-4-8' },
    context: { used_tokens: 42000, window_tokens: 1000000 },
    cost: { total_cost_usd: 0.5, total_duration_ms: 120000 },
    rate_limit: { percent: 12, reset_ms: 3600000 },
    rate_limits: {
      five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
      seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
    },
  }, NOW);
  for (const observation of full) accept(observation);
  const snapshot = full.find((o) => o.event_name === 'statusline.context_snapshot');
  assert.equal(snapshot.measurements.find((m) => m.name === 'context_tokens').value, 42000);
  const rate = full.find((o) => o.event_name === 'statusline.rate_limit');
  assert.equal(rate.measurements.find((m) => m.name === 'rate_limit_reset_ms').value, 3600000);
  assert.equal(rate.measurements.find((m) => m.name === 'rate_limit_five_hour_used_percent').value, 23.5);
  assert.equal(rate.measurements.find((m) => m.name === 'rate_limit_five_hour_reset_at_ms').value, 1738425600000);
  assert.equal(rate.measurements.find((m) => m.name === 'rate_limit_seven_day_used_percent').value, 41.2);
  assert.equal(rate.measurements.find((m) => m.name === 'rate_limit_seven_day_reset_at_ms').value, 1738857600000);

  // Before the first response / after a compact: usage is unavailable (null), never zero.
  const empty = buildStatuslineObservations({ session_id: 'session-1', model: { id: 'claude-opus-4-8' }, context: {} }, NOW);
  for (const observation of empty) accept(observation);
  const emptySnapshot = empty.find((o) => o.event_name === 'statusline.context_snapshot');
  const ctx = emptySnapshot.measurements.find((m) => m.name === 'context_tokens');
  assert.equal(ctx.value, null);
  assert.equal(ctx.quality, 'unavailable');
});

test('hooks.json launches the observer and registers observability across lifecycle events', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8')).hooks;
  const commandsFor = (event) => (hooks[event] || []).flatMap((group) => group.hooks.map((h) => h.command)).join(' ');
  assert.ok(commandsFor('SessionStart').includes('lib/observability/ensure.js'));
  assert.ok(commandsFor('SessionStart').includes('--launch'));
  assert.ok(commandsFor('PreToolUse').includes('request-body-preflight.js'));
  for (const event of ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop']) {
    assert.ok(commandsFor(event).includes('observability.js'), `observability missing on ${event}`);
  }
});
