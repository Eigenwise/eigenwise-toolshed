'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { normalizeObservation } = require('../lib/observability/ingest.js');
const { drainHookSpool } = require('../lib/observability/hook-spool.js');
const { openObservabilityStore } = require('../lib/observability/store.js');
const { buildObservation, spool, EVENT_MAP } = require('../hooks/observability.js');
const { buildStatuslineObservations } = require('../bin/workbench-statusline.js');

const NOW = new Date('2026-07-19T10:00:00.000Z');

function accept(observation) {
  const result = normalizeObservation(observation);
  assert.equal(result.accepted, true, `${observation && observation.event_name} rejected: ${JSON.stringify(result.rejectedFields)}`);
}

test('every mapped hook event yields an acceptable canonical observation', () => {
  const payloads = {
    SessionStart: { hook_event_name: 'SessionStart', session_id: 'session-1', source: 'resume', permission_mode: 'default' },
    SessionEnd: { hook_event_name: 'SessionEnd', session_id: 'session-1', reason: 'logout' },
    UserPromptSubmit: { hook_event_name: 'UserPromptSubmit', session_id: 'session-1', prompt_id: 'prompt-9', permission_mode: 'acceptEdits' },
    PreToolUse: { hook_event_name: 'PreToolUse', session_id: 'session-1', tool_name: 'Bash', tool_use_id: 'toolu_1', permission_mode: 'default' },
    PostToolUse: { hook_event_name: 'PostToolUse', session_id: 'session-1', tool_name: 'mcp__plugin_sidequest_board__list', tool_use_id: 'toolu_2', status: 'ok' },
    Stop: { hook_event_name: 'Stop', session_id: 'session-1', reason: 'end_turn' },
    SubagentStop: { hook_event_name: 'SubagentStop', session_id: 'session-1', agent_id: 'agent-a', agent_type: 'sidequest-exec-dispatch-high', model: 'gpt-5.6-sol', status: 'completed' },
  };
  for (const [event, payload] of Object.entries(payloads)) {
    const observation = buildObservation(payload, NOW);
    assert.equal(observation.event_name, EVENT_MAP[event]);
    accept(observation);
  }
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

test('statusline emits acceptable context + rate-limit snapshots and marks missing usage unavailable', () => {
  const full = buildStatuslineObservations({
    session_id: 'session-1',
    model: { id: 'claude-opus-4-8' },
    context: { used_tokens: 42000, window_tokens: 1000000 },
    cost: { total_cost_usd: 0.5, total_duration_ms: 120000 },
    rate_limit: { percent: 12, reset_ms: 3600000 },
  }, NOW);
  for (const observation of full) accept(observation);
  const snapshot = full.find((o) => o.event_name === 'statusline.context_snapshot');
  assert.equal(snapshot.measurements.find((m) => m.name === 'context_tokens').value, 42000);
  const rate = full.find((o) => o.event_name === 'statusline.rate_limit');
  assert.equal(rate.measurements.find((m) => m.name === 'rate_limit_reset_ms').value, 3600000);

  // Before the first response / after a compact: usage is unavailable (null), never zero.
  const empty = buildStatuslineObservations({ session_id: 'session-1', model: { id: 'claude-opus-4-8' }, context: {} }, NOW);
  for (const observation of empty) accept(observation);
  const emptySnapshot = empty.find((o) => o.event_name === 'statusline.context_snapshot');
  const ctx = emptySnapshot.measurements.find((m) => m.name === 'context_tokens');
  assert.equal(ctx.value, null);
  assert.equal(ctx.quality, 'unavailable');
});

test('hooks.json keeps the freshness hooks and registers observability across lifecycle events', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8')).hooks;
  const commandsFor = (event) => (hooks[event] || []).flatMap((group) => group.hooks.map((h) => h.command)).join(' ');
  assert.ok(commandsFor('SessionStart').includes('session-start-freshness.js'));
  assert.ok(commandsFor('SessionStart').includes('lib/observability/ensure.js'));
  assert.ok(commandsFor('SessionStart').includes('--launch'));
  assert.ok(commandsFor('UserPromptSubmit').includes('user-prompt-freshness.js'));
  for (const event of ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop']) {
    assert.ok(commandsFor(event).includes('observability.js'), `observability missing on ${event}`);
  }
});
