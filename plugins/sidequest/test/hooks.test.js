'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('node:child_process');

// A throwaway store home so the SubagentStop hook (which loads lib/store.js as a
// subprocess and inherits this env) reads a fixture board, never the real one. The
// other hooks in this file don't touch the store, so this redirect is harmless to
// them. Set BEFORE requiring store so its lazy home resolution picks it up.
const SIDEQUEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-test-'));
process.env.SIDEQUEST_HOME = SIDEQUEST_HOME;
const store = require('../lib/store.js');
const db = require('../lib/db.js');
const BOARD_PATH = path.join(os.tmpdir(), 'sq-hooks-fixtures', 'board');
const { slug } = store.ensureProject(BOARD_PATH);
const database = db.openDb(SIDEQUEST_HOME);

const HOOKS = path.join(__dirname, '..', 'hooks');
const SESSION = path.join(HOOKS, 'session-start.js');
const FORCE_BYPASS = path.join(HOOKS, 'force-exec-bypass.js');
const SUBAGENT_START = path.join(HOOKS, 'subagent-start.js');
const SUBAGENT_STOP = path.join(HOOKS, 'subagent-stop.js');
const GUARD_PEER = path.join(HOOKS, 'guard-peer-message.js');
const GUARD_HOME_DELETE = path.join(HOOKS, 'guard-home-delete.js');
const NEAR_TURN_CAP = path.join(HOOKS, 'near-turn-cap.js');
const INLINE_WORK_NUDGE = path.join(HOOKS, 'inline-work-nudge.js');
const BOARD_FIRST_REMINDER = path.join(HOOKS, 'board-first-reminder.js');
const GUARD_TASK_OUTPUT = path.join(HOOKS, 'guard-task-output.js');

const BUDGET = {
  session: 4700,
  compact: 2900,
  workforce: 1800,
  longrun: 400, // SubagentStop runaway note — one short line, like the standing reminder
};

const RETIRED_SCOUT = `sidequest-${'scout'}`;

// Run a hook with the given stdin payload and return the injected
// additionalContext string (or '' when the hook stays silent).
function runHookOutput(script, payload, envOverrides) {
  const out = execFileSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...(envOverrides || {}) },
  });
  return out.trim() ? JSON.parse(out) : null;
}

function runHook(script, payload, envOverrides) {
  const parsed = runHookOutput(script, payload, envOverrides);
  if (!parsed) return '';
  return (parsed.hookSpecificOutput && parsed.hookSpecificOutput.additionalContext) || '';
}

function runSessionWithHome(home, envOverrides) {
  return execFileSync(process.execPath, [SESSION], {
    input: JSON.stringify({ session_id: 'bootstrap-test' }),
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_HOME: home, ...(envOverrides || {}) },
  });
}

function writeCategory(home, category) {
  const database = db.openDb(home);
  db.putRow(database, 'categories', { id: category.id, data: category });
}

function writeModelPrefs(home, prefs) {
  const database = db.openDb(home);
  db.putRow(database, 'globals', { key: 'model-prefs', data: prefs });
}

// Phrases from the retired heavy doctrine that must NOT come back to any block.
const RETIRED = ['95%', 'read ~4+ files', 'AskUserQuestion', 'coreDiscipline', 'sidequest-scout'];

function assertNoRetiredDoctrine(ctx, where) {
  for (const phrase of RETIRED) {
    assert.ok(!ctx.includes(phrase), `${where} must not carry retired doctrine ("${phrase}")`);
  }
}

test('pre-tool hook: exact Sidequest executors remain allowed and forced to bypass', () => {
  const original = {
    subagent_type: 'sidequest-exec-high',
    isolation: 'worktree',
    model: 'grade-3',
    name: 'sq36-srs-cards',
    prompt: 'work SQ-36',
  };
  const out = runHookOutput(FORCE_BYPASS, { tool_name: 'Agent', tool_input: original });
  assert.deepStrictEqual(out.hookSpecificOutput.updatedInput, {
    ...original,
    mode: 'bypassPermissions',
  });
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PreToolUse');
});

test('pre-tool hook: harness utilities pass through and generic agents are denied', () => {
  for (const subagent_type of ['claude-code-guide', 'statusline-setup']) {
    const original = { subagent_type, isolation: 'worktree', model: 'opus', prompt: 'Read-only harness utility.' };
    const out = runHookOutput(FORCE_BYPASS, { tool_name: 'Agent', tool_input: original });
    assert.deepStrictEqual(out.hookSpecificOutput.updatedInput, original, subagent_type);
  }
  for (const [subagent_type, prompt] of [
    ['fork', 'Delegate a quick lookup.'],
    ['Explore', 'Locate the current hook contract.'],
    ['general-purpose', 'Investigate this code path.'],
    ['web-researcher', 'Research the latest routing guidance.'],
  ]) {
    const out = runHookOutput(FORCE_BYPASS, {
      tool_name: 'Agent',
      tool_input: { subagent_type, isolation: 'worktree', prompt },
    });
    const reason = out.hookSpecificOutput.permissionDecisionReason;
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', subagent_type);
    assert.match(reason, /generic Agent, not a Sidequest ticket executor/);
    assert.match(reason, /Read, Glob, Grep, or WebFetch inline/);
    assert.match(reason, /quick investigation, needs a ticket: file a spike/);
    assert.match(reason, /codebase-exploration/);
    assert.match(reason, /route it, dispatch it, then spawn the returned executor/);
    assert.doesNotMatch(reason, /fresh dispatch briefing/);
  }
  const mismatch = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-invalid', isolation: 'worktree', prompt: 'Quick lookup.' },
  });
  assert.equal(mismatch.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(
    mismatch.hookSpecificOutput.permissionDecisionReason,
    'sidequest: sidequest-invalid is not a recognized ticket executor — gate/executor version mismatch — update+reload sidequest, do not respawn or re-dispatch.'
  );
  assert.doesNotMatch(mismatch.hookSpecificOutput.permissionDecisionReason, new RegExp(RETIRED_SCOUT));
});

test('pre-tool hook: a marked generic agent is still denied', () => {
  const marked = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'Explore',
      isolation: 'worktree',
      prompt: ` \n\t[${RETIRED_SCOUT}]\nQuick read-only lookup.`,
    },
  });
  const reason = marked.hookSpecificOutput.permissionDecisionReason;
  assert.equal(marked.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(reason, /generic Agent, not a Sidequest ticket executor/);
  assert.match(reason, /file a spike/);
  assert.match(reason, /returned executor/);
});

test('pre-tool hook: executor-context generic agents pass through untouched', () => {
  const original = { subagent_type: 'Explore', isolation: 'worktree', prompt: 'Inspect mapper skill flows.' };
  assert.equal(runHookOutput(FORCE_BYPASS, {
    agent_id: 'executor-644', agent_type: 'sidequest-exec-dispatch-high', tool_name: 'Agent', tool_input: original,
  }), null);
});

test('pre-tool hook keeps builtin models and strips a stable dispatch executor model', () => {
  const dispatch = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'sidequest-exec-dispatch-high', model: 'fable', name: 'sq210-dispatch',
      prompt: 'work SQ-210\n[sidequest-route model=codex-gpt-5-6-terra effort=high]',
    },
  });
  assert.equal(dispatch.hookSpecificOutput.updatedInput.model, undefined);
  assert.equal(dispatch.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');
  assert.match(dispatch.systemMessage, /removed the Agent model override/);

  const builtIn = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-high', model: 'opus', name: 'sq210-builtin' },
  });
  assert.equal(builtIn.hookSpecificOutput.updatedInput.model, 'opus');
  assert.equal(builtIn.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');

  const haiku = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-medium', model: 'haiku', name: 'sq210-haiku' },
  });
  assert.equal(haiku.hookSpecificOutput.updatedInput.model, 'haiku');
  assert.equal(haiku.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');

  for (const subagent_type of ['sidequest-native-sq-210-gpt-5-6-terra', 'sidequest-ticket-sq-584-haiku-b37fffcb']) {
    const out = runHookOutput(FORCE_BYPASS, { tool_name: 'Agent', tool_input: { subagent_type, prompt: 'work SQ-210' } });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /not a recognized ticket executor/);
  }
});

test('pre-tool hook: malformed input fails soft', () => {
  const out = execFileSync(process.execPath, [FORCE_BYPASS], {
    input: '{"tool_input":',
    encoding: 'utf8',
    env: process.env,
  });
  assert.strictEqual(out, '');
});

test('task-output guard: blocks Sidequest native task identities and dispatched names', () => {
  const reason = 'native Agent results arrive automatically. Use pulse <ref> / changes --since for liveness. Use TaskStop only after terminal board evidence.';
  const direct = runHookOutput(GUARD_TASK_OUTPUT, {
    tool_name: 'TaskOutput', tool_input: { task_id: 'sidequest-exec-dispatch-high@session-abc' },
  });
  assert.equal(direct.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(direct.hookSpecificOutput.permissionDecisionReason, new RegExp(reason.replace(/[<>]/g, '\\$&')));

  const ticket = fixtureTicket('task-output mapped launch', 'sonnet', 'high');
  const sessionId = `task-output-${Date.now()}`;
  const agentName = 'friendly-launch-name';
  const agentId = 'native-task@session-sidequest-guard';
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId, token: prepared.token, executor: prepared.ticket.dispatchExecutor, agentName,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentId, agentName).ok, true);

  for (const tool_input of [{ task_id: agentName }, { id: agentId }]) {
    const out = runHookOutput(GUARD_TASK_OUTPUT, { session_id: sessionId, tool_name: 'TaskOutput', tool_input });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  }
});

test('task-output guard: leaves subagent calls, background task IDs, and malformed unrelated input alone', () => {
  assert.strictEqual(runHookOutput(GUARD_TASK_OUTPUT, {
    agent_id: 'executor-644', agent_type: 'sidequest-exec-dispatch-high',
    tool_name: 'TaskOutput', tool_input: { task_id: 'sidequest-exec-dispatch-high@session-abc' },
  }), null);
  for (const tool_input of [
    { task_id: 'build-123' },
    { id: 'unrelated-SQ-439-process' },
    { task_id: {} },
  ]) {
    assert.strictEqual(runHookOutput(GUARD_TASK_OUTPUT, { tool_name: 'TaskOutput', tool_input }), null);
  }
});

test('pre-tool near-cap hook leaves subagent calls untouched', () => {
  const payload = { tool_name: 'Read', agent_type: 'sidequest-exec-high', agent_id: `near-cap-${Date.now()}`, effort: 'high' };
  const first = execFileSync(process.execPath, [NEAR_TURN_CAP], {
    input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, SIDEQUEST_EXEC_MAX_TURNS: '1' },
  });
  assert.equal(first, '');
});

test('pre-tool near-cap hook ignores main-thread and unrelated subagent calls', () => {
  assert.equal(runHookOutput(NEAR_TURN_CAP, { tool_name: 'Read', agent_id: 'main-thread' }), null);
  assert.equal(runHookOutput(NEAR_TURN_CAP, { tool_name: 'Read', agent_type: 'explore', agent_id: 'other-agent' }), null);
});

test('pre-tool inline-work nudge gives three grace actions, then blocks with the board fix', () => {
  const session_id = `inline-nudge-${Date.now()}`;
  const payload = { session_id, cwd: BOARD_PATH, tool_name: 'Write', tool_input: {} };
  for (let i = 0; i < 4; i += 1) assert.equal(runHookOutput(INLINE_WORK_NUDGE, payload), null);
  const nudge = runHookOutput(INLINE_WORK_NUDGE, payload);
  assert.match(nudge.hookSpecificOutput.additionalContext, /REQUIRED/);
  assert.match(nudge.hookSpecificOutput.additionalContext, /3 more substantive actions/);
  assert.doesNotMatch(nudge.hookSpecificOutput.additionalContext, /looks like|consider/i);
  for (let i = 0; i < 3; i += 1) assert.equal(runHookOutput(INLINE_WORK_NUDGE, payload), null);
  const denial = runHookOutput(INLINE_WORK_NUDGE, payload);
  assert.equal(denial.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denial.hookSpecificOutput.permissionDecisionReason, /BLOCKED/);
  assert.match(denial.hookSpecificOutput.permissionDecisionReason, /`add` → `dispatch <ref>`/);
  assert.match(denial.hookSpecificOutput.permissionDecisionReason, /`claim <ref> --direct --reason/);
});

test('pre-tool inline-work nudge counts distinct source reads, then blocks the read spiral', () => {
  const session_id = `inline-read-${Date.now()}`;
  const reads = [
    { tool_name: 'Read', tool_input: { file_path: 'src/one.js' } },
    { tool_name: 'Read', tool_input: { file_path: 'src/two.js' } },
    { tool_name: 'Grep', tool_input: { path: 'src', pattern: 'three' } },
    { tool_name: 'Glob', tool_input: { path: 'src', pattern: '**/four.js' } },
    { tool_name: 'Bash', tool_input: { command: 'git show HEAD:src/five.js' } },
    { tool_name: 'Bash', tool_input: { command: 'git show HEAD:src/six.js' } },
  ];
  assert.equal(runHookOutput(INLINE_WORK_NUDGE, { session_id, cwd: BOARD_PATH, ...reads[0] }), null);
  for (let i = 1; i < reads.length - 1; i += 1) {
    assert.equal(runHookOutput(INLINE_WORK_NUDGE, { session_id, cwd: BOARD_PATH, ...reads[i] }), null);
  }
  assert.equal(runHookOutput(INLINE_WORK_NUDGE, { session_id, cwd: BOARD_PATH, ...reads[0] }), null);
  const nudge = runHookOutput(INLINE_WORK_NUDGE, { session_id, cwd: BOARD_PATH, ...reads[5] });
  assert.match(nudge.hookSpecificOutput.additionalContext, /cross-file investigation/);
  assert.match(nudge.hookSpecificOutput.additionalContext, /3 more distinct source reads\/searches/);
  for (const file_path of ['src/seven.js', 'src/eight.js', 'src/nine.js']) {
    assert.equal(runHookOutput(INLINE_WORK_NUDGE, {
      session_id, cwd: BOARD_PATH, tool_name: 'Read', tool_input: { file_path },
    }), null);
  }
  const denial = runHookOutput(INLINE_WORK_NUDGE, {
    session_id, cwd: BOARD_PATH, tool_name: 'Read', tool_input: { file_path: 'src/ten.js' },
  });
  assert.equal(denial.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denial.hookSpecificOutput.permissionDecisionReason, /cross-file investigation is a spike ticket/);
  assert.match(denial.hookSpecificOutput.permissionDecisionReason, /`add` → `dispatch <ref>`/);
  const retried = runHookOutput(INLINE_WORK_NUDGE, {
    session_id, cwd: BOARD_PATH, tool_name: 'Read', tool_input: { file_path: 'src/ten.js' },
  });
  assert.equal(retried.hookSpecificOutput.permissionDecision, 'deny',
    'a denied source retried verbatim must stay denied, not pass as a re-read');
  assert.equal(runHookOutput(INLINE_WORK_NUDGE, {
    session_id, cwd: BOARD_PATH, ...reads[0],
  }), null, 'a source read before the gate tripped stays re-readable');
});

test('pre-tool inline-work nudge keeps substantive and read counters separate', () => {
  const session_id = `inline-both-${Date.now()}`;
  const write = { session_id, cwd: BOARD_PATH, tool_name: 'Write', tool_input: {} };
  for (let i = 0; i < 4; i += 1) assert.equal(runHookOutput(INLINE_WORK_NUDGE, write), null);
  assert.match(runHookOutput(INLINE_WORK_NUDGE, write).hookSpecificOutput.additionalContext, /REQUIRED/);

  for (let i = 0; i < 5; i += 1) {
    assert.equal(runHookOutput(INLINE_WORK_NUDGE, {
      session_id, cwd: BOARD_PATH, tool_name: 'Read', tool_input: { file_path: `src/${i}.js` },
    }), null);
  }
  const nudge = runHookOutput(INLINE_WORK_NUDGE, {
    session_id, cwd: BOARD_PATH, tool_name: 'Read', tool_input: { file_path: 'src/six.js' },
  });
  assert.match(nudge.hookSpecificOutput.additionalContext, /cross-file investigation/);
  assert.equal(runHookOutput(INLINE_WORK_NUDGE, write), null);
  assert.equal(runHookOutput(INLINE_WORK_NUDGE, {
    session_id, cwd: BOARD_PATH, tool_name: 'Read', tool_input: { file_path: 'src/zero.js' },
  }), null);
});

test('pre-tool inline-work board interaction clears both gates', () => {
  const session_id = `inline-board-${Date.now()}`;
  for (let i = 0; i < 5; i += 1) {
    assert.equal(runHookOutput(INLINE_WORK_NUDGE, {
      session_id, cwd: BOARD_PATH, tool_name: 'Read', tool_input: { file_path: `src/${i}.js` },
    }), null);
  }
  assert.match(runHookOutput(INLINE_WORK_NUDGE, {
    session_id, cwd: BOARD_PATH, tool_name: 'Read', tool_input: { file_path: 'src/six.js' },
  }).hookSpecificOutput.additionalContext, /cross-file investigation/);
  assert.equal(runHookOutput(INLINE_WORK_NUDGE, {
    session_id, cwd: BOARD_PATH, tool_name: 'mcp__plugin_sidequest_board__claim', tool_input: { direct: true },
  }), null);
  for (let i = 0; i < 12; i += 1) {
    assert.equal(runHookOutput(INLINE_WORK_NUDGE, {
      session_id, cwd: BOARD_PATH, tool_name: 'Read', tool_input: { file_path: `src/after-${i}.js` },
    }), null);
    assert.equal(runHookOutput(INLINE_WORK_NUDGE, {
      session_id, cwd: BOARD_PATH, tool_name: 'Write', tool_input: {},
    }), null);
  }
  const cliSession = `inline-cli-${Date.now()}`;
  assert.equal(runHookOutput(INLINE_WORK_NUDGE, {
    session_id: cliSession, cwd: BOARD_PATH, tool_name: 'Bash',
    tool_input: { command: 'node "C:/plugins/sidequest/bin/sidequest.js" claim SQ-3 --direct' },
  }), null);
  for (let i = 0; i < 12; i += 1) {
    assert.equal(runHookOutput(INLINE_WORK_NUDGE, {
      session_id: cliSession, cwd: BOARD_PATH, tool_name: 'Read', tool_input: { file_path: `src/cli-${i}.js` },
    }), null);
  }
});

test('pre-tool inline-work board contact before the threshold never blocks', () => {
  const session_id = `inline-early-board-${Date.now()}`;
  const write = { session_id, cwd: BOARD_PATH, tool_name: 'Write', tool_input: {} };
  assert.equal(runHookOutput(INLINE_WORK_NUDGE, write), null);
  assert.equal(runHookOutput(INLINE_WORK_NUDGE, write), null);
  assert.equal(runHookOutput(INLINE_WORK_NUDGE, {
    session_id, cwd: BOARD_PATH, tool_name: 'mcp__plugin_sidequest_board__list', tool_input: {},
  }), null);
  for (let i = 0; i < 12; i += 1) assert.equal(runHookOutput(INLINE_WORK_NUDGE, write), null);
});

test('pre-tool inline-work nudge ignores subagents and routing-disabled boards', () => {
  for (const subagent of [
    { session_id: `inline-subagent-id-${Date.now()}`, cwd: BOARD_PATH, agent_id: 'executor', tool_name: 'Write', tool_input: {} },
    { session_id: `inline-subagent-type-${Date.now()}`, cwd: BOARD_PATH, agent_type: 'sidequest-exec-dispatch-high', tool_name: 'Write', tool_input: {} },
  ]) {
    for (let i = 0; i < 12; i += 1) assert.equal(runHookOutput(INLINE_WORK_NUDGE, subagent), null);
  }

  store.setProjectRouting(slug, 'disabled');
  try {
    const disabled = { session_id: `inline-disabled-${Date.now()}`, cwd: BOARD_PATH, tool_name: 'Write', tool_input: {} };
    for (let i = 0; i < 12; i += 1) assert.equal(runHookOutput(INLINE_WORK_NUDGE, disabled), null);
  } finally {
    store.setProjectRouting(slug, 'enabled');
  }
});

test('pre-tool inline-work nudge ignores automation prompts', () => {
  const payload = {
    session_id: `inline-automation-${Date.now()}`, cwd: BOARD_PATH, tool_name: 'Read', tool_input: {},
    prompt: '<task-notification>Executor completed.</task-notification>',
  };
  for (let i = 0; i < 12; i += 1) assert.equal(runHookOutput(INLINE_WORK_NUDGE, payload), null);
});

test('pre-tool inline-work nudge fails open on hook errors', () => {
  const result = runHookOutput(INLINE_WORK_NUDGE, {
    session_id: `inline-hook-error-${Date.now()}`, cwd: BOARD_PATH, tool_name: 'Write', tool_input: {},
  }, { CLAUDE_PLUGIN_ROOT: path.join(os.tmpdir(), 'missing-sidequest-plugin-root') });
  assert.equal(result, null);
});

test('user-prompt reminder establishes the orchestrator role and blocks ignored inline work', () => {
  const payload = { session_id: `board-first-${Date.now()}`, cwd: BOARD_PATH, prompt: 'Fix the board hook.' };
  const reminder = runHookOutput(BOARD_FIRST_REMINDER, payload);
  const context = reminder.hookSpecificOutput.additionalContext;
  assert.equal(reminder.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(context, /ROLE: you are the orchestrator/);
  assert.match(context, /REQUIRED/);
  assert.match(context, /BLOCKED/);
  assert.doesNotMatch(context, /looks like|consider/i);
  assert.ok(context.indexOf('ROLE:') < context.indexOf('REQUIRED:'), 'role framing must precede enforcement mechanics');
  assert.equal(runHookOutput(BOARD_FIRST_REMINDER, payload), null);
});

test('user-prompt reminder ignores automation without consuming the session flag', () => {
  const payload = { session_id: `board-automation-${Date.now()}`, cwd: BOARD_PATH };
  assert.equal(runHookOutput(BOARD_FIRST_REMINDER, { ...payload, prompt: '<task-notification>Executor completed.</task-notification>' }), null);
  assert.equal(runHookOutput(BOARD_FIRST_REMINDER, { ...payload, prompt: '<agent-message>Worker needs input.</agent-message>' }), null);
  assert.equal(runHookOutput(BOARD_FIRST_REMINDER, { ...payload, prompt: '<local-command>Command output.</local-command>' }), null);
  assert.equal(runHookOutput(BOARD_FIRST_REMINDER, { ...payload, prompt: '<local-command-caveat>Command output.</local-command-caveat>' }), null);
  assert.match(runHook(BOARD_FIRST_REMINDER, { ...payload, prompt: 'Implement the ticket.' }), /claim --direct/);
});

test('user-prompt reminder ignores subagents and routing-disabled boards', () => {
  for (const subagent of [
    { session_id: `board-subagent-id-${Date.now()}`, cwd: BOARD_PATH, agent_id: 'executor', prompt: 'Implement the ticket.' },
    { session_id: `board-subagent-type-${Date.now()}`, cwd: BOARD_PATH, agent_type: 'sidequest-exec-dispatch-high', prompt: 'Implement the ticket.' },
  ]) {
    assert.equal(runHookOutput(BOARD_FIRST_REMINDER, subagent), null);
  }

  store.setProjectRouting(slug, 'disabled');
  try {
    const disabled = { session_id: `board-disabled-${Date.now()}`, cwd: BOARD_PATH, prompt: 'Implement the ticket.' };
    assert.equal(runHookOutput(BOARD_FIRST_REMINDER, disabled), null);
  } finally {
    store.setProjectRouting(slug, 'enabled');
  }
});

/* ------------------------------------------------------------------ *
 *  Builtin executors spawned WITHOUT a model must not silently inherit
 *  the session model — resolve the routed model from a ref in the prompt,
 *  or deny the spawn when it can't be resolved unambiguously (SQ-232).
 * ------------------------------------------------------------------ */

let fixtureSeq = 0;
function fixtureTicket(title, model, effort) {
  const category = `hooks-route-${++fixtureSeq}`;
  store.setCategory({
    id: category,
    name: category,
    route: { model, effort },
    fallback: null,
    enabled: true,
  });
  return store.createTicket(slug, { title, category, source: 'cli' });
}

test('pre-tool hook keeps a complete Claude worktree spawn valid outside its board cwd', () => {
  const ticket = fixtureTicket('SQ-399 worktree spawn regression', 'fable', 'xhigh');
  const unregisteredWorktree = path.join(os.tmpdir(), 'sq-unregistered-worktree');
  const original = {
    subagent_type: 'sidequest-exec-xhigh',
    name: 'sq399-worktree',
    mode: 'bypassPermissions',
    isolation: 'worktree',
    model: 'fable',
    prompt: `Implement ${ticket.ref}. --project "${path.join(os.tmpdir(), 'sq-hooks-fixtures', 'board')}"`,
  };
  const out = runHookOutput(FORCE_BYPASS, { tool_name: 'Agent', cwd: unregisteredWorktree, tool_input: original });

  assert.deepStrictEqual(out.hookSpecificOutput.updatedInput, original);
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
});
test('pre-tool hook: builtin exec without a model injects the resolved Claude model from a prompt ref', () => {
  const t = fixtureTicket('SQ-232 inject fixture', 'sonnet', 'high');
  const out = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-high', name: 'w-inject', prompt: `work ${t.ref} --project "${slug}"` },
  });
  assert.equal(out.hookSpecificOutput.updatedInput.model, 'sonnet');
  assert.equal(out.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');
  assert.ok(!out.hookSpecificOutput.permissionDecision, 'a resolvable spawn must not be denied');
  assert.match(out.systemMessage, /injected "sonnet"/);
  assert.match(out.systemMessage, /resolved category route/);
  assert.ok(out.systemMessage.includes(t.ref), 'systemMessage must name the ref it resolved from');
});

test('pre-tool hook: builtin exec without a model and no ticket ref in the prompt is denied', () => {
  const out = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-high', name: 'w-norefs', prompt: 'go fix the reporter, no ticket named here' },
  });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /ready --brief/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /model: exec\.model/);
});

test('pre-tool hook: builtin exec without a model and conflicting concrete models across refs is denied', () => {
  const a = fixtureTicket('SQ-232 conflict fixture A', 'sonnet', 'high');
  const b = fixtureTicket('SQ-232 conflict fixture B', 'opus', 'high');
  const out = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-high', name: 'w-conflict', prompt: `batch ${a.ref} and ${b.ref} --project "${slug}"` },
  });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /conflicting concrete models/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /split it per model/);
});

test('pre-tool hook: builtin exec spawned WITH a model that mismatches the resolved route keeps the caller value and warns', () => {
  const t = fixtureTicket('SQ-232 mismatch fixture', 'sonnet', 'high');
  const out = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-high', name: 'w-mismatch', model: 'opus', prompt: `work ${t.ref} --project "${slug}"` },
  });
  assert.equal(out.hookSpecificOutput.updatedInput.model, 'opus', 'a deliberate cap must be kept, not overwritten');
  assert.match(out.systemMessage, /model "opus" but .* resolves to "sonnet"/);
});

test('pre-tool hook: stable dispatch executor strips model even when a ref resolves', () => {
  const t = fixtureTicket('SQ-232 dispatch passthrough fixture', 'codex-gpt-5-6-terra', 'high');
  const out = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'sidequest-exec-dispatch-high', model: 'fable', name: 'w-dispatch',
      prompt: `work ${t.ref} --project "${slug}"\n[sidequest-route model=codex-gpt-5-6-terra effort=high]`,
    },
  });
  assert.equal(out.hookSpecificOutput.updatedInput.model, undefined);
  assert.equal(out.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');
  assert.match(out.systemMessage, /removed the Agent model override/);
});



/* ------------------------------------------------------------------ *
 *  CLAUDE_CODE_SUBAGENT_MODEL defeats routing (it overrides both the Agent
 *  model and the frontmatter pin) — so a sidequest executor spawn must be
 *  denied while it's set, not run on the wrong model.
 * ------------------------------------------------------------------ */

function runForceBypassWithEnv(toolInput, envOverrides) {
  const out = execFileSync(process.execPath, [FORCE_BYPASS], {
    input: JSON.stringify({ tool_name: 'Agent', tool_input: toolInput }),
    encoding: 'utf8',
    env: { ...process.env, ...envOverrides },
  });
  return out.trim() ? JSON.parse(out) : null;
}

test('pre-tool hook: CLAUDE_CODE_SUBAGENT_MODEL set denies a dispatch executor spawn', () => {
  const out = runForceBypassWithEnv(
    { subagent_type: 'sidequest-exec-dispatch-high', name: 'sq-env-codex', prompt: 'work SQ-1\n[sidequest-route model=codex-gpt-5-6-terra effort=high]' },
    { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' }
  );
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /CLAUDE_CODE_SUBAGENT_MODEL/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /defeat(s|ing) routing/);
});

test('pre-tool hook: CLAUDE_CODE_SUBAGENT_MODEL set denies a builtin executor spawn too', () => {
  const out = runForceBypassWithEnv(
    { subagent_type: 'sidequest-exec-high', name: 'sq-env-builtin', prompt: 'work SQ-1' },
    { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' }
  );
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /Unset it/);
});

test('pre-tool hook: an unset CLAUDE_CODE_SUBAGENT_MODEL leaves the spawn alone', () => {
  const out = runForceBypassWithEnv(
    { subagent_type: 'sidequest-exec-dispatch-high', model: 'fable', name: 'sq-env-off', prompt: 'work SQ-1\n[sidequest-route model=codex-gpt-5-6-terra effort=high]' },
    { CLAUDE_CODE_SUBAGENT_MODEL: '' }
  );
  assert.ok(!out.hookSpecificOutput.permissionDecision, 'no override -> no deny');
  assert.equal(out.hookSpecificOutput.updatedInput.model, undefined, 'the pin still wins by stripping the Agent model');
});

/* ------------------------------------------------------------------ *
 *  Peer-message guard — an executor reports UP (final message + its own
 *  ticket comments), never sideways to a peer. This is the other half of
 *  the Contractify loop.
 * ------------------------------------------------------------------ */

function runGuardPeer(payload) {
  const out = execFileSync(process.execPath, [GUARD_PEER], {
    input: JSON.stringify({ tool_name: 'SendMessage', ...payload }),
    encoding: 'utf8',
  });
  return out.trim() ? JSON.parse(out) : null;
}

test('peer-guard: subagent calls are untouched', () => {
  for (const agent_type of ['sidequest-exec-high', 'sidequest-exec-dispatch-high', 'code-reviewer']) {
    assert.strictEqual(runGuardPeer({ agent_id: `peer-${agent_type}`, agent_type, tool_input: { to: 'reviewer', message: 'look at SQ-70' } }), null);
  }
});

test('peer-guard: an executor reporting to main is allowed', () => {
  assert.strictEqual(runGuardPeer({ agent_type: 'sidequest-exec-high', tool_input: { to: 'main', message: 'done' } }), null);
});

test('peer-guard: a main-thread SendMessage (no agent_type) is allowed', () => {
  assert.strictEqual(runGuardPeer({ tool_input: { to: 'reviewer', message: 'assign' } }), null);
});

test('peer-guard: terminal dispatch blocks delayed steering before delivery', () => {
  const ticket = addEffortTicket('terminal executor cannot be revived', 'high');
  const sessionId = `terminal-message-${++sqSeq}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const executorName = 'finished-dispatch-worker';
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    agentName: executorName,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, 'terminal-agent-id', executorName).ok, true);
  assert.equal(store.claimTicket(slug, ticket.ref, 'terminal-worker', {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.completeTicket(slug, ticket.ref, 'terminal-worker', { sessionId }).ok, true);

  const after = store.getTicket(slug, ticket.ref);
  assert.equal(after.claim, null, 'done clears the worker claim before a message can arrive');
  assert.equal(after.dispatch.agentName, executorName, 'done retains the mapped executor for terminal cleanup');
  assert.equal(after.dispatch.outcome, 'done');
  assert.ok(after.dispatch.terminalAt);

  const out = runGuardPeer({ tool_input: { to: executorName, message: 'one more thing' } });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, new RegExp(ticket.ref));
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /queued steering message/);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /Redispatch/);
});

test('peer-guard: an active dispatch still accepts main-thread steering', () => {
  const ticket = addEffortTicket('active executor accepts steering', 'high');
  const sessionId = `active-message-${++sqSeq}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const executorName = 'active-dispatch-worker';
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    agentName: executorName,
  }).ok, true);

  assert.strictEqual(runGuardPeer({ tool_input: { to: executorName, message: 'please check the test' } }), null);
});

test('peer-guard: a non-sidequest subagent messaging a peer is allowed', () => {
  assert.strictEqual(runGuardPeer({ agent_type: 'code-reviewer', tool_input: { to: 'researcher', message: 'hi' } }), null);
});

function runHomeDeleteGuard(tool_name, command) {
  return runHookOutput(GUARD_HOME_DELETE, { tool_name, tool_input: { command } });
}

test('home-delete guard: subagent calls are untouched', () => {
  assert.strictEqual(runHookOutput(GUARD_HOME_DELETE, {
    agent_id: 'executor-644', agent_type: 'sidequest-exec-dispatch-high',
    tool_name: 'PowerShell', tool_input: { command: 'Remove-Item -Recurse -Force $home' },
  }), null);
});

test('home-delete guard: blocks a recursive delete using $home', () => {
  const out = runHomeDeleteGuard('PowerShell', 'Remove-Item -Recurse -Force $home');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /user profile or \.claude root/);
});

test('home-delete guard: blocks profile and .claude roots', () => {
  for (const command of [
    'Remove-Item -Recurse -Force $env:USERPROFILE',
    'rm -rf %USERPROFILE%',
    `rm -rf ${path.join(os.homedir(), '.claude')}`,
  ]) {
    assert.equal(runHomeDeleteGuard('Bash', command).hookSpecificOutput.permissionDecision, 'deny');
  }
});

test('home-delete guard: blocks a recursive delete of the profile root', () => {
  const out = runHomeDeleteGuard('Bash', `rm -rf ${os.homedir()}`);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('home-delete guard: blocks a parent traversal from .claude', () => {
  const out = runHomeDeleteGuard('Bash', `rm -rf ${path.join(os.homedir(), '.claude', '..')}`);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('home-delete guard: allows forced non-recursive and continued scoped deletes', () => {
  for (const command of [
    'rm -f C:/Users/x/AppData/Local/Temp/observability/file',
    `rm -f "C:\\scratchpad\\observability" \\
  "C:\\scratchpad\\logs"`,
    `rm -rf "C:\\scratchpad\\observability" \\
  "C:\\scratchpad\\logs"`,
  ]) {
    assert.strictEqual(runHomeDeleteGuard('Bash', command), null, command);
  }
});

test('home-delete guard: a lone forward slash is still the drive root', () => {
  for (const command of ['rm -rf /', 'rm -rf C:\\scratchpad\\observability /']) {
    assert.equal(runHomeDeleteGuard('Bash', command).hookSpecificOutput.permissionDecision, 'deny', command);
  }
});

test('home-delete guard: allows scratchpad deletion', () => {
  assert.strictEqual(runHomeDeleteGuard('PowerShell', 'Remove-Item -Recurse -Force C:\\scratchpad\\run-42'), null);
});

test('home-delete guard: allows non-delete PowerShell commands', () => {
  assert.strictEqual(runHomeDeleteGuard('PowerShell', 'Get-ChildItem $HOME'), null);
});

test('home-delete guard: blocks the 2026-07-16 incident command verbatim', () => {
  const out = runHomeDeleteGuard('PowerShell', '$home = Join-Path "C:\\Temp\\x" "sq330-runtime"; if (Test-Path $home) { Remove-Item -Recurse -Force $home -Confirm:$false }');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('home-delete guard: blocks deletes wrapped in blocks, pipelines, and aliases', () => {
  for (const command of [
    'Get-ChildItem ~ | ForEach-Object { Remove-Item -Recurse -Force $home }',
    'if (Test-Path $home) { ri -Recurse -Force $home }',
    'rd /s %USERPROFILE%',
  ]) {
    assert.equal(runHomeDeleteGuard('PowerShell', command).hookSpecificOutput.permissionDecision, 'deny', command);
  }
});

test('session-start sweep is fail-soft and releases only claims past the TTL', () => {
  const stale = addTicket('session-start stale claim');
  const fresh = addTicket('session-start fresh claim');
  assert.equal(store.claimTicket(slug, stale.ref, 'stale-session', { direct: true }).ok, true);
  assert.equal(store.claimTicket(slug, fresh.ref, 'fresh-session', { direct: true }).ok, true);
  const staleTicket = store.getTicket(slug, stale.ref);
  staleTicket.claim.at = new Date(Date.now() - store.claimTtlMs() - 1).toISOString();
  db.putRow(database, 'tickets', {
    id: staleTicket.id, project: slug, ref: staleTicket.ref, status: staleTicket.status,
    archived: staleTicket.archived ? 1 : 0, ord: staleTicket.order, claim_by: staleTicket.claim.by, data: staleTicket,
  });
  assert.doesNotThrow(() => runHook(SESSION, { session_id: 'sweep-test' }));
  assert.equal(store.getTicket(slug, stale.ref).claim, null);
  assert.equal(store.getTicket(slug, fresh.ref).claim.by, 'fresh-session');
});

test('session-start: carries the route-down + tight-loop doctrine', () => {
  const ctx = runHook(SESSION, { session_id: 'test' });
  assert.match(ctx, /sidequest \(active\)/);
  assert.ok(ctx.includes('ATOMIC'), 'must demand atomic tickets (stuck executors come from oversized scope)');
  assert.match(ctx, /independently checkable/, 'must split independently checkable pieces');
  assert.match(ctx, /investigation, spike, or review/, 'a ticket can be investigation, not only a code change');
  assert.match(ctx, /Split for parallelism/, 'must frame splitting as parallel fan-out, not only cheap execution');
  assert.match(ctx, /tightly coupled work together/, 'must keep coupled work in one ticket');
  for (const field of ['exact anchors', 'contract', 'bounds/non-goals', 'dependencies/decisions']) {
    assert.ok(ctx.includes(field), `must require ${field} in the ticket spec`);
  }
  assert.match(ctx, /verify command, or the artifact\/answer/, 'done is a verify command for a change or an artifact/answer for an investigation');
  assert.ok(ctx.includes('DOWN'), 'must say execution routes down to the routed model');
  assert.match(ctx, /substantive investigations and changes are board tickets/, 'must preserve ticket-first substantive work');
  assert.match(ctx, /Every Agent launch uses that executor/, 'must require every Agent launch to use a dispatched executor');
  assert.match(ctx, /Tiny lookup: Read, Glob, Grep, or WebFetch inline/, 'must give tiny lookups direct tools');
  assert.match(ctx, /Any delegated work, including a quick investigation, is a spike ticket/, 'must make every investigation ticketed');
  assert.match(ctx, /usually `codebase-exploration`/, 'must name the usual investigation category');
  assert.ok(ctx.includes('fresh `dispatch`'), 'must require a fresh dispatch result');
  assert.ok(ctx.includes('exact stable executor, spawn, and token'), 'must use the exact instant dispatch result');
  assert.match(ctx, /Dispatch is instant: no registration\/watcher wait/, 'must replace the registration wait flow');
  assert.ok(ctx.includes('do not use `native_agent`'), 'must reject temporary native dispatch for normal execution');
  assert.ok(ctx.includes('bypassPermissions'), 'must require unattended executors to launch in bypass');
  assert.ok(ctx.includes('Native results: never TaskOutput.'), 'must ban invalid native Agent TaskOutput polling');
  assert.ok(ctx.includes('pulse ref / changes --since; TaskStop only after terminal board evidence'), 'must give the board-based liveness and stop rule');
  assert.ok(ctx.includes('Never proxy-wait'), 'must ban proxy waiters (side-channel Bash/Monitor/cron waits + blocking TaskOutput on a proxy)');
  assert.match(ctx, /ONE diagnose-first retry/);
  assert.match(ctx, /never blind respawn/);
  assert.match(ctx, /Two failures: comment evidence \+ surface user/);
  assert.match(ctx, /one background timer, never foreground sleep loop/);
  assert.ok(ctx.includes('SHORT'), 'must demand short, bounded executor runs');
  assert.ok(ctx.includes('bounce back'), 'must tell executors to bounce back, not wander');
  assert.ok(ctx.includes('ONE executor'), 'must carry the batch-small-tickets rule');
  assert.ok(ctx.includes('trivial one-step'), 'inline is only for trivial one-steps');
  assert.ok(
    ctx.includes('mcp__plugin_sidequest_board__') && ctx.includes('FIRST'),
    'must push the MCP tools as the first-choice board interface (models default to the CLI out of habit)'
  );
});

test('session-start: shows the live investigation workforce within its cap', () => {
  for (const source of ['', 'compact', 'resume']) {
    const ctx = runHook(SESSION, { session_id: `workforce-${source || 'startup'}`, source });
    const start = ctx.indexOf('YOUR EXECUTORS — delegate work AND investigation to them:');
    assert.ok(start >= 0, `${source || 'startup'} includes the workforce`);
    const workforce = ctx.slice(start);
    assert.ok(Buffer.byteLength(workforce) <= BUDGET.workforce, `${source || 'startup'} workforce is ${Buffer.byteLength(workforce)} bytes`);
    for (const id of ['codebase-exploration', 'debugging', 'spike-investigation', 'deep-research', 'web-research']) {
      assert.match(workforce, new RegExp(`${id} — .+ \\(.+·.+\\)`), id);
    }
  }
});

test('session-start: teaches ticketed investigation spikes from turn zero', () => {
  const ctx = runHook(SESSION, { session_id: 'test' });
  assert.match(ctx, /Any delegated work, including a quick investigation, is a spike ticket/);
  assert.match(ctx, /usually `codebase-exploration`/);
  const pluginRoot = path.join(__dirname, '..');
  const deny = fs.readFileSync(path.join(HOOKS, 'force-exec-bypass.js'), 'utf8');
  const skill = fs.readFileSync(path.join(pluginRoot, 'skills', 'sidequest', 'SKILL.md'), 'utf8');
  for (const surface of [deny, skill, ctx]) {
    assert.doesNotMatch(surface, new RegExp(RETIRED_SCOUT), 'published guidance must not carry the retired bypass');
  }
});

test('session-start: carries runtime resource and worker reporting coordination', () => {
  const ctx = runHook(SESSION, { session_id: 'test' });
  assert.match(ctx, /Before each wave, assess shared runtime resources/, 'must require pre-wave assessment');
  assert.match(ctx, /fixed ports, domains, shared DBs, servers, and files outside declared scope/, 'must name runtime collisions');
  assert.match(ctx, /Serialize tickets that touch the same resource even across worktrees/, 'worktrees cannot make shared runtime resources parallel-safe');
  assert.match(ctx, /Workers own their ticket and report conflicts, server lifecycle, files changed, blockers, and cleanup/, 'must define worker reporting and ownership');
});

test('session-start: flags enumerated deliverables as a decomposition smell (design→wave)', () => {
  const ctx = runHook(SESSION, { session_id: 'test' });
  assert.match(ctx, /several deliverables .* is a smell/, 'a ticket owning several enumerated deliverables must read as a smell');
  assert.match(ctx, /ticketed planning investigation that pins the shared contract/, 'must use a ticketed investigation to pin the shared contract');
  assert.match(ctx, /wave fanning the pieces out/, 'then a wave that fans the deliverables out to parallel sub-agents');
});

test('session-start: says sidequest coexists with an external tracker (Jira)', () => {
  const ctx = runHook(SESSION, { session_id: 'test' });
  assert.ok(ctx.includes('external tracker'), 'must address the external-tracker case');
  assert.ok(ctx.includes('Jira'), 'must name Jira so the "already tracked" reflex is countered');
});

test('session-start: stays inside its byte budget and off the retired doctrine', () => {
  const ctx = runHook(SESSION, { session_id: 'test' });
  assert.ok(
    ctx.length <= BUDGET.session,
    `session block is ${ctx.length} chars — budget is ${BUDGET.session}; trim the briefing or workforce section`
  );
  assertNoRetiredDoctrine(ctx, 'session-start');
});

test('session-start: reports newly provisioned executors once, then stays quiet', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-agents-'));
  writeCategory(home, {
    id: 'hooks-codex',
    name: 'Hooks Codex',
    route: { model: 'codex-gpt-5-6-terra', effort: 'high' },
    fallback: { model: 'sonnet', effort: 'high' },
    enabled: true,
  });
  const first = JSON.parse(runSessionWithHome(home));
  const firstContext = first.hookSpecificOutput.additionalContext;
  assert.match(firstContext, /Reload plugins before spawning newly created temporary native agents/);

  const second = JSON.parse(runSessionWithHome(home));
  const secondContext = second.hookSpecificOutput.additionalContext;
  assert.doesNotMatch(secondContext, /Executor definitions were just \(re\)provisioned/);
});
test('session-start: provisions the shared dispatch executor and prunes legacy per-combo defs', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-codex-'));
  writeCategory(home, {
    id: 'hooks-codex',
    name: 'Hooks Codex',
    route: { model: 'codex-gpt-5-6-terra', effort: 'high' },
    fallback: { model: 'sonnet', effort: 'high' },
    enabled: true,
  });
  const agents = path.join(home, 'agents');
  fs.mkdirSync(agents, { recursive: true });
  const legacyFile = path.join(agents, 'sidequest-exec-codex-gpt-5-6-terra-high.md');
  fs.writeFileSync(legacyFile, '<!-- generated-by: sidequest-agentsync -->\nold');
  const catalog = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-catalog-'));
  fs.mkdirSync(path.join(catalog, 'codex-gateway'), { recursive: true });
  fs.writeFileSync(path.join(catalog, 'codex-gateway', 'catalog.json'), JSON.stringify({ schemaVersion: 3, source: 'codex-gateway', models: [{ slug: 'codex-gpt-5-6-terra', id: 'claude-codex-gpt-5.6-terra[1m]' }] }));
  runSessionWithHome(home, { SIDEQUEST_AGENTS_DIR: agents, SIDEQUEST_DISCOVERY_DIRS: catalog });
  assert.ok(!fs.existsSync(legacyFile), 'legacy per-combo Codex executor must be pruned by session sync');
  assert.ok(fs.existsSync(path.join(agents, 'sidequest-exec-dispatch-high.md')), 'reachable Codex route must provision the shared dispatch executor');
});

test('session-start: category-route sync ignores retired prefs data', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-unreadable-'));
  const agents = path.join(home, 'agents');
  fs.mkdirSync(agents, { recursive: true });
  const codexFile = path.join(agents, 'sidequest-exec-dispatch-high.md');
  writeCategory(home, {
    id: 'hooks-codex',
    name: 'Hooks Codex',
    route: { model: 'codex-gpt-5-6-terra', effort: 'high' },
    fallback: { model: 'sonnet', effort: 'high' },
    enabled: true,
  });
  db.openDb(home).prepare("INSERT INTO globals (key, data) VALUES ('model-prefs', '{')").run();
  const catalog = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-catalog-'));
  fs.mkdirSync(path.join(catalog, 'codex-gateway'), { recursive: true });
  fs.writeFileSync(path.join(catalog, 'codex-gateway', 'catalog.json'), JSON.stringify({ schemaVersion: 3, source: 'codex-gateway', models: [{ slug: 'codex-gpt-5-6-terra', id: 'claude-codex-gpt-5.6-terra[1m]' }] }));
  runSessionWithHome(home, { SIDEQUEST_AGENTS_DIR: agents, SIDEQUEST_DISCOVERY_DIRS: catalog });
  assert.ok(fs.existsSync(codexFile), 'a category route must provision despite unreadable retired prefs data');
});
test('session-start: compact and resume preserve the minimum ticket and executor policy', () => {
  for (const source of ['compact', 'resume']) {
    const ctx = runHook(SESSION, { session_id: 't', source });
    assert.match(ctx, /sidequest \(active — context restored\)/);
    assert.ok(ctx.includes('Reload Sidequest'), `${source} must reload the skill`);
    assert.match(ctx, /Substantive work needs a board ticket/, `${source} must preserve ticket-first work`);
    assert.match(ctx, /fresh dispatch's exact token-gated executor and spawn/, `${source} must preserve exact dispatch execution`);
    assert.match(ctx, /Every Agent launch must use that executor/, `${source} must require dispatch for every Agent launch`);
    assert.match(ctx, /Read, Glob, Grep, or WebFetch inline/, `${source} must name direct lookup tools`);
    assert.match(ctx, /tracing code across files needs a spike ticket/, `${source} must route multi-file investigation through the board`);
    assert.ok(ctx.includes('mcp__plugin_sidequest_board__list') && ctx.includes('status=doing') && ctx.includes('FIRST'), `${source} must prefer the MCP doing-list read`);
    assert.ok(ctx.includes('pulse ref'), `${source} must point to the compact liveness read`);
    assert.ok(ctx.includes('never TaskOutput'), `${source} must ban native Agent TaskOutput polling`);
    assert.ok(ctx.includes('changes --since; TaskStop only after terminal board evidence'), `${source} must retain the board-based liveness and stop rule`);
    assert.match(ctx, /ONE diagnose-first retry/);
    assert.match(ctx, /never blind respawn/);
    assert.match(ctx, /Two failures: comment evidence \+ surface user/);
    assert.match(ctx, /one background timer, never foreground sleep loop/);
    assert.ok(ctx.includes('list --status doing'), `${source} must retain the CLI fallback`);
    assert.ok(!ctx.includes('external tracker'), `${source} must not inject the full block`);
    assert.ok(Buffer.byteLength(ctx) <= BUDGET.compact, `${source} block is ${Buffer.byteLength(ctx)} bytes — budget is ${BUDGET.compact}`);
  }
});

test('session-start: compact byte budget ignores a long plugin path', () => {
  const ctx = runHook(
    SESSION,
    { session_id: 't', source: 'compact' },
    { CLAUDE_PLUGIN_ROOT: 'C:/sidequest/' + 'deep-install-root/'.repeat(100) }
  );
  assert.ok(ctx.includes('node "${CLAUDE_PLUGIN_ROOT}/bin/sidequest.js"'), 'CLI fallback must use the stable plugin-root variable');
  assert.ok(Buffer.byteLength(ctx) <= BUDGET.compact, `compact block is ${Buffer.byteLength(ctx)} bytes — budget is ${BUDGET.compact}`);
});

test('session-start: source=startup still gets the full block', () => {
  const ctx = runHook(SESSION, { session_id: 't', source: 'startup' });
  assert.ok(ctx.includes('external tracker'), 'startup source must still carry the full nudge');
  assert.ok(ctx.includes('Reload the Sidequest skill'), 'startup must reload the sidequest skill');
});

test('session-start: frames the main agent as orchestrator before mechanics', () => {
  const ctx = runHook(SESSION, { session_id: 't', source: 'startup' });
  assert.match(ctx, /ROLE: you are this project's ORCHESTRATOR/);
  assert.ok(ctx.indexOf('ROLE:') < ctx.indexOf('Reload the Sidequest skill'), 'role framing must open the briefing before mechanics');
  assert.match(ctx, /Executors execute\/investigate/);
  assert.match(ctx, /REQUIRED/);
  assert.match(ctx, /BLOCKED/);
  assert.doesNotMatch(ctx, /looks like|consider/i);
  assert.ok(ctx.length <= BUDGET.session, `session block is ${ctx.length} chars — budget is ${BUDGET.session}`);
});

test('session-start: SIDEQUEST_NUDGE=off silences it', () => {
  const out = execFileSync(process.execPath, [SESSION], {
    input: JSON.stringify({ session_id: 'test' }),
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_NUDGE: 'off' },
  });
  assert.strictEqual(out.trim(), '', 'should emit nothing when nudge is off');
});

test('ticket filing stays explicit while the Agent gate enforces dispatch and docs match it', () => {
  const pluginRoot = path.join(__dirname, '..');
  const repoRoot = path.join(pluginRoot, '..', '..');
  const references = [
    path.join(repoRoot, 'README.md'),
    path.join(pluginRoot, 'README.md'),
    path.join(pluginRoot, 'bin', 'sidequest.js'),
    path.join(HOOKS, 'session-start.js'),
    path.join(pluginRoot, 'skills', 'sidequest', 'SKILL.md'),
  ];

  assert.ok(!fs.existsSync(path.join(pluginRoot, 'agents', 'ticket-filer.md')));
  assert.ok(!fs.existsSync(path.join(HOOKS, 'capture-nudge.js')));
  for (const file of references) {
    assert.ok(!fs.readFileSync(file, 'utf8').includes('ticket-filer'), `${file} must not reference ticket-filer`);
  }

  const config = JSON.parse(fs.readFileSync(path.join(HOOKS, 'hooks.json'), 'utf8'));
  assert.ok(config.hooks.UserPromptSubmit.some((entry) => entry.hooks
    .some((hook) => hook.command.includes('board-first-reminder.js'))), 'the board-first reminder must run for user prompts');
  assert.doesNotMatch(JSON.stringify(config), /capture-nudge|ticket-filer/);
  assert.ok(config.hooks.PreToolUse.some((entry) => entry.matcher === '*'
    && entry.hooks.some((hook) => hook.command.includes('inline-work-nudge.js'))), 'the inline-work reminder must be registered for every tool');
  assert.ok(config.hooks.PreToolUse.some((entry) => entry.matcher === 'Agent'
    && entry.hooks.some((hook) => hook.command.includes('force-exec-bypass.js'))), 'the Agent gate must be registered');
  assert.ok(config.hooks.PreToolUse.some((entry) => entry.matcher === 'TaskOutput'
    && entry.hooks.some((hook) => hook.command.includes('guard-task-output.js'))), 'the TaskOutput guard must be registered');

  const readme = fs.readFileSync(path.join(pluginRoot, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /per-prompt "use sidequest" reminder/);
  assert.doesNotMatch(readme, /marker-triggered capture/);
  assert.doesNotMatch(readme, /native_agent/);
  assert.match(readme, /exact stable executor/);
  assert.match(readme, /no unrouted delegation/);
  assert.match(readme, /codebase-exploration/);
  const skill = fs.readFileSync(path.join(pluginRoot, 'skills', 'sidequest', 'SKILL.md'), 'utf8');
  assert.match(skill, /spike ticket/);
  assert.match(skill, /codebase-exploration/);
  for (const file of [
    path.join(pluginRoot, 'README.md'),
    path.join(HOOKS, 'force-exec-bypass.js'),
    path.join(HOOKS, 'session-start.js'),
    path.join(pluginRoot, 'skills', 'sidequest', 'SKILL.md'),
    path.join(pluginRoot, 'skills', 'sidequest', 'references', 'orchestration.md'),
  ]) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), new RegExp(RETIRED_SCOUT), `${file} must not carry the retired bypass`);
  }
});

/* ------------------------------------------------------------------ *
 *  SubagentStop — flag a runaway (likely non-atomic) executor run post-hoc.
 *
 *  The hook can't stop a running subagent; it turns a long claim into ONE visible
 *  line so the orchestrator notices the ticket wasn't atomic. Elapsed comes from
 *  the claim's OWN start `at` in the worker registry (store already records it),
 *  NOT from the SubagentStop stdin — which we pass BARE here to prove that. We
 *  simulate a 28-min run by backdating the registry claim, then run the hook.
 * ------------------------------------------------------------------ */

let sqSeq = 0;
function addTicket(title) {
  return addStopTicket(title);
}

function addStopTicket(title, fields) {
  const category = `hooks-stop-${++fixtureSeq}`;
  store.setCategory({
    id: category,
    name: category,
    route: { model: 'sonnet', effort: 'high' },
    fallback: null,
    enabled: true,
  });
  return store.createTicket(slug, Object.assign({
    title,
    category,
    source: 'cli',
  }, fields));
}

function addEffortTicket(title, effort) {
  const category = `hooks-effort-${++fixtureSeq}`;
  store.setCategory({
    id: category,
    name: category,
    route: { model: 'sonnet', effort },
    fallback: null,
    enabled: true,
  });
  return store.createTicket(slug, {
    title,
    category,
    source: 'cli',
  });
}

function claimStopTicket(ticket, sessionId, by) {
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const agentId = `stop-agent-${ticket.id}-${++sqSeq}`;
  const agentName = `stop-executor-${ticket.id}-${sqSeq}`;
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    agentName,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, agentId, agentName).ok, true);
  assert.equal(store.claimTicket(slug, ticket.ref, by, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  return { session_id: sessionId, agent_type: prepared.ticket.dispatchExecutor, agent_id: agentId, agent_name: agentName };
}

// Backdate the claim's `at` without waiting real time.
function backdateSessionClaims(sessionId, minutesAgo, effort) {
  const w = db.getRow(database, 'globals', 'workers');
  const at = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  for (const c of w.sessions[sessionId].claims) {
    c.at = at;
    if (effort) c.effort = effort;
  }
  w.sessions[sessionId].updatedAt = at;
  db.putRow(database, 'globals', { key: 'workers', data: w });
}

test('subagent-stop: an over-threshold claim reports a dead-claim verdict', () => {
  const sess = `sess-long-${++sqSeq}`;
  const t = addTicket('runaway 28-min ticket');
  const stop = claimStopTicket(t, sess, 'worker-long');
  backdateSessionClaims(sess, 28);

  const ctx = runHook(SUBAGENT_STOP, stop);
  assert.strictEqual(ctx, `exec stopped HOLDING ${t.ref} claim (age 28m), likely dead: release + respawn, then TaskStop it`);
  assert.ok(ctx.length <= BUDGET.longrun, `stop verdict is ${ctx.length} chars — budget is ${BUDGET.longrun}`);
  assert.ok(ctx.indexOf('\n') === -1, 'the verdict must stay ONE line');
});

test('subagent-stop: a held claim is classified regardless of claimed effort', () => {
  const tiers = ['low', 'medium', 'high', 'xhigh'];

  for (const effort of tiers) {
    const session = `sess-${effort}-${++sqSeq}`;
    const ticket = addEffortTicket(`${effort} stopped claim`, effort);
    const stop = claimStopTicket(ticket, session, `worker-${effort}`);
    const ctx = runHook(SUBAGENT_STOP, stop);
    assert.match(ctx, new RegExp(`^exec stopped HOLDING ${ticket.ref} claim`));
  }
});

test('subagent-stop: stop_hook_active suppresses the note (no self-continuation loop)', () => {
  const sess = `sess-active-${++sqSeq}`;
  const t = addTicket('over-threshold ticket, but re-entrant fire');
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-active', { direct: true, sessionId: sess }).ok, true);
  backdateSessionClaims(sess, 28);
  assert.strictEqual(
    runHook(SUBAGENT_STOP, { session_id: sess, stop_hook_active: true }),
    '',
    'a fire carrying stop_hook_active is our own continuation and must never re-emit'
  );
});

test('subagent-stop: a non-executor child (reviewer) is not nagged about a session claim', () => {
  const sess = `sess-reviewer-${++sqSeq}`;
  const t = addTicket('over-threshold executor claim, unrelated reviewer stops');
  const stop = claimStopTicket(t, sess, 'worker-rev');
  backdateSessionClaims(sess, 28);
  assert.strictEqual(
    runHook(SUBAGENT_STOP, { session_id: sess, agent_type: 'code-reviewer' }),
    '',
    'a reviewer shares the session id but never held the claim — it must stay silent'
  );
  // The same over-threshold claim still surfaces for the actual executor child.
  const ctx = runHook(SUBAGENT_STOP, stop);
  assert.ok(ctx.includes(t.ref), 'a sidequest executor child must still get the note');
});

test('subagent-stop: a repeated stop repeats the held-claim verdict until release', () => {
  const sess = `sess-dedupe-${++sqSeq}`;
  const t = addTicket('over-threshold claim reports every stop');
  const stop = claimStopTicket(t, sess, 'worker-dedupe');
  backdateSessionClaims(sess, 28);
  const expected = `exec stopped HOLDING ${t.ref} claim (age 28m), likely dead: release + respawn, then TaskStop it`;
  assert.strictEqual(runHook(SUBAGENT_STOP, stop), expected);
  assert.strictEqual(runHook(SUBAGENT_STOP, stop), expected);
});

test('subagent-stop: a stopped executor holding a fresh claim gets the dead-claim verdict', () => {
  const sess = `sess-fresh-${++sqSeq}`;
  const t = addTicket('quick ticket, just claimed');
  const stop = claimStopTicket(t, sess, 'worker-fresh');
  const ctx = runHook(SUBAGENT_STOP, stop);
  assert.match(ctx, new RegExp(`^exec stopped HOLDING ${t.ref} claim \\(age 1m\\), likely dead: release \\+ respawn, then TaskStop it$`));
});

test('subagent-stop: a completed executor reports a clean stop from its done comment', () => {
  const sess = `sess-completed-${++sqSeq}`;
  const t = addStopTicket('completed ticket with commit note', { files: ['lib/fixture.js'] });
  const stop = claimStopTicket(t, sess, 'worker-completed');
  assert.strictEqual(store.addComment(slug, t.ref, { by: 'worker-completed', kind: 'comment', body: 'Shipped abc1234.', source: 'cli' }).ok, true);
  assert.strictEqual(store.completeTicket(slug, t.ref, 'worker-completed', {}).ok, true);
  assert.strictEqual(runHook(SUBAGENT_STOP, stop), `exec stopped clean: ${t.ref} done (abc1234); verify, then TaskStop this executor so it doesn't linger idle`);
});

test('subagent-stop: a completed file ticket without a hash is flagged', () => {
  const sess = `sess-no-hash-${++sqSeq}`;
  const t = addStopTicket('completed ticket without commit note', { files: ['lib/fixture.js'] });
  const stop = claimStopTicket(t, sess, 'worker-no-hash');
  assert.strictEqual(store.addComment(slug, t.ref, { by: 'worker-no-hash', kind: 'comment', body: 'Done and verified.', source: 'cli' }).ok, true);
  assert.strictEqual(store.completeTicket(slug, t.ref, 'worker-no-hash', {}).ok, true);
  assert.strictEqual(runHook(SUBAGENT_STOP, stop), `exec stopped clean: ${t.ref} done WITHOUT commit hash; verify, then TaskStop this executor so it doesn't linger idle`);
});

test('subagent-stop: a submitted executor reports READY_FOR_INTEGRATION, not a dead claim', () => {
  const sess = `sess-submitted-${++sqSeq}`;
  const t = addStopTicket('submitted ticket awaiting the publish transaction', { files: ['lib/fixture.js'] });
  const stop = claimStopTicket(t, sess, 'worker-submitted');
  assert.strictEqual(store.submitTicket(slug, t.ref, 'worker-submitted', { commit: 'abc1234def5678abc1234def5678abc1234def56' }).ok, true);
  assert.strictEqual(
    runHook(SUBAGENT_STOP, stop),
    `exec stopped clean: ${t.ref} READY_FOR_INTEGRATION (abc1234def56); run the publish transaction (references/publishing.md), then TaskStop this executor`
  );
});

test('subagent-stop: a prior owner is silent after another worker reclaims the ticket', () => {
  const sess = `sess-prior-owner-${++sqSeq}`;
  const t = addTicket('reclaimed ticket with stale prior owner entry');
  const stop = claimStopTicket(t, sess, 'worker-prior');
  backdateSessionClaims(sess, 28);
  assert.strictEqual(store.releaseTicket(slug, t.ref, 'worker-prior', {}).ok, true);
  assert.strictEqual(store.claimTicket(slug, t.ref, 'worker-current', { direct: true, sessionId: `sess-current-${sqSeq}` }).ok, true);

  assert.strictEqual(runHook(SUBAGENT_STOP, stop), '', 'a prior owner must not be warned about another worker\'s live claim');
});
test('subagent-stop: an unidentifiable executor stays silent', () => {
  assert.strictEqual(runHook(SUBAGENT_STOP, { session_id: 'sess-nobody-here', agent_type: 'sidequest-exec-high' }), '');
  assert.strictEqual(runHook(SUBAGENT_STOP, {}), '', 'a bare payload with no session id stays silent');
});

test('subagent-stop: long-run threshold settings do not suppress a held-claim verdict', () => {
  const sess = `sess-tuned-${++sqSeq}`;
  const t = addEffortTicket('5-min high-effort stopped claim', 'high');
  const stop = claimStopTicket(t, sess, 'worker-tuned');
  backdateSessionClaims(sess, 5);

  const out = execFileSync(process.execPath, [SUBAGENT_STOP], {
    input: JSON.stringify(stop),
    encoding: 'utf8',
    env: { ...process.env, SIDEQUEST_LONG_RUN_MIN: '2' },
  });
  const parsed = out.trim() ? JSON.parse(out) : null;
  const ctx = parsed ? parsed.hookSpecificOutput.additionalContext : '';
  assert.match(ctx, new RegExp(`^exec stopped HOLDING ${t.ref} claim`));
});

// Registered LAST: creates extra fixture categories, which would otherwise grow
// the live workforce section inside earlier byte-budget assertions.
test('pre-tool hook: dispatch executor rejects conflicting route markers and ignores prose sibling refs', () => {
  const catalog = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-dispatch-catalog-'));
  fs.mkdirSync(path.join(catalog, 'codex-gateway'), { recursive: true });
  fs.writeFileSync(path.join(catalog, 'codex-gateway', 'catalog.json'), JSON.stringify({
    schemaVersion: 3,
    source: 'codex-gateway',
    models: [
      { slug: 'codex-gpt-5-6-terra', id: 'claude-codex-gpt-5.6-terra[1m]' },
      { slug: 'codex-gpt-5-6-sol', id: 'claude-codex-gpt-5.6-sol[1m]' },
    ],
  }));
  const a = fixtureTicket('SQ-347 dispatch batch A', 'codex-gpt-5-6-terra', 'high');
  const b = fixtureTicket('SQ-347 dispatch batch B', 'codex-gpt-5-6-sol', 'high');
  const proseSibling = runForceBypassWithEnv(
    { subagent_type: 'sidequest-exec-dispatch-high', name: 'w-dispatch-prose', prompt: `Ref: ${a.ref}\n[sidequest-route model=codex-gpt-5-6-terra effort=high]\nPrior ${b.ref} had a sol route. --project "${slug}"` },
    { SIDEQUEST_DISCOVERY_DIRS: catalog }
  );
  assert.ok(!proseSibling.hookSpecificOutput.permissionDecision, 'a prose sibling ref must not create a mixed batch');
  assert.equal(proseSibling.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');
  const mixed = runForceBypassWithEnv(
    { subagent_type: 'sidequest-exec-dispatch-high', name: 'w-dispatch-mixed', prompt: `Ref: ${a.ref}\n[sidequest-route model=codex-gpt-5-6-terra effort=high]\nRef: ${b.ref}\n[sidequest-route model=codex-gpt-5-6-sol effort=high]\n--project "${slug}"` },
    { SIDEQUEST_DISCOVERY_DIRS: catalog }
  );
  assert.equal(mixed.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(mixed.hookSpecificOutput.permissionDecisionReason, /route marker/);
  assert.match(mixed.hookSpecificOutput.permissionDecisionReason, /mixes tickets stamped with different models/);
  assert.match(mixed.hookSpecificOutput.permissionDecisionReason, /Split the batch/);
  assert.doesNotMatch(mixed.hookSpecificOutput.permissionDecisionReason, /fresh dispatch briefing/);
  const same = runForceBypassWithEnv(
    { subagent_type: 'sidequest-exec-dispatch-high', name: 'w-dispatch-same', prompt: `Ref: ${a.ref}\n[sidequest-route model=codex-gpt-5-6-terra effort=high]\nRef: SQ-999\n[sidequest-route model=codex-gpt-5-6-terra effort=high]\n--project "${slug}"` },
    { SIDEQUEST_DISCOVERY_DIRS: catalog }
  );
  assert.ok(!same.hookSpecificOutput.permissionDecision, 'a same-model batch must not be denied');
  assert.equal(same.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');
});

test('pre-tool hook: dispatch executor rejects a route marker with different effort', () => {
  const out = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'sidequest-exec-dispatch-high', name: 'w-dispatch-mismatch',
      prompt: 'work SQ-377\n[sidequest-route model=codex-gpt-5-6-terra effort=medium]',
    },
  });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /executor effort "high" does not match route marker effort "medium"/);
});

test('pre-tool hook: dispatch spawns require their issued description without touching ordinary executor calls', () => {
  const ticket = addEffortTicket('preserve exact dispatch description', 'high');
  const sessionId = `description-${++sqSeq}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const projectPath = store.readMeta(slug).path;
  const description = prepared.ticket.dispatch.description;
  const prompt = `Ref: ${ticket.ref}\n--project "${projectPath}" --token ${prepared.token}`;
  const base = {
    subagent_type: prepared.ticket.dispatchExecutor,
    name: 'exact-description',
    description,
    prompt,
  };

  const exact = runHookOutput(FORCE_BYPASS, { session_id: sessionId, tool_name: 'Agent', tool_input: base });
  assert.equal(exact.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(exact.hookSpecificOutput.updatedInput.description, description);

  const paraphrased = runHookOutput(FORCE_BYPASS, {
    session_id: sessionId,
    tool_name: 'Agent',
    tool_input: { ...base, description: 'shorter paraphrase' },
  });
  assert.equal(paraphrased.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(paraphrased.hookSpecificOutput.permissionDecisionReason.includes(description));

  const ordinary = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'sidequest-exec-high',
      model: 'sonnet',
      description: 'ordinary executor launch',
      prompt: 'Read one file.',
    },
  });
  assert.equal(ordinary.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(ordinary.hookSpecificOutput.updatedInput.description, 'ordinary executor launch');
});

test('dispatch ledger records an authoritative launch, agent bind, and claim acknowledgement', () => {
  const ticket = addEffortTicket('dispatch launch acknowledgement', 'high');
  const sessionId = `launch-${++sqSeq}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  const projectPath = store.readMeta(slug).path;
  const prompt = `Work ${ticket.ref} --project "${projectPath}" --token ${prepared.token}`;
  const launch = runHookOutput(FORCE_BYPASS, {
    session_id: sessionId,
    tool_name: 'Agent',
    tool_input: {
      subagent_type: prepared.ticket.dispatchExecutor,
      name: 'dispatch-ledger',
      description: prepared.ticket.dispatch.description,
      prompt,
    },
  });
  const agentName = launch.hookSpecificOutput.updatedInput.name;
  assert.equal(store.getTicket(slug, ticket.ref).dispatch.outcome, 'launched');
  runHookOutput(SUBAGENT_START, {
    session_id: sessionId,
    agent_type: prepared.ticket.dispatchExecutor,
    agent_id: 'native-launch-1',
    agent_name: agentName,
  });
  assert.equal(store.getTicket(slug, ticket.ref).dispatch.agentId, 'native-launch-1');
  assert.equal(store.claimTicket(slug, ticket.ref, 'dispatch-worker', {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  const pulse = store.pulsePayload(slug, ticket.ref);
  assert.equal(pulse.dispatch.outcome, 'claimed');
  assert.equal(pulse.dispatch.tokenPrefix, prepared.token.slice(0, 12));
  assert.equal(pulse.dispatch.agentName, agentName);
});

test('concurrent same-type dispatches isolate launch, bind, claim, and stop by token-derived native identity', () => {
  const first = addEffortTicket('first same-type dispatch', 'high');
  const second = addEffortTicket('second same-type dispatch', 'high');
  const sessionId = `concurrent-${++sqSeq}`;
  const projectPath = store.readMeta(slug).path;
  const preparedFirst = store.prepareDispatch(slug, first.ref, { sessionId });
  const preparedSecond = store.prepareDispatch(slug, second.ref, { sessionId });
  const launches = [preparedFirst, preparedSecond].map((prepared) => runHookOutput(FORCE_BYPASS, {
    session_id: sessionId,
    tool_name: 'Agent',
    tool_input: {
      subagent_type: prepared.ticket.dispatchExecutor,
      name: 'sidequest-exec-dispatch-high',
      description: prepared.ticket.dispatch.description,
      prompt: `Work ${prepared.ticket.ref} --project "${projectPath}" --token ${prepared.token}`,
    },
  }));
  const names = launches.map((launch) => launch.hookSpecificOutput.updatedInput.name);
  assert.notEqual(names[0], names[1]);
  assert.match(names[0], new RegExp(`${first.ref.toLowerCase()}-${preparedFirst.token.slice(0, 12)}$`));
  assert.match(names[1], new RegExp(`${second.ref.toLowerCase()}-${preparedSecond.token.slice(0, 12)}$`));

  for (const [index, prepared] of [preparedFirst, preparedSecond].entries()) {
    runHookOutput(SUBAGENT_START, {
      session_id: sessionId,
      agent_type: prepared.ticket.dispatchExecutor,
      agent_id: `native-concurrent-${index + 1}`,
      agent_name: names[index],
    });
    assert.equal(store.getTicket(slug, prepared.ticket.ref).dispatch.agentId, `native-concurrent-${index + 1}`);
    assert.equal(store.claimTicket(slug, prepared.ticket.ref, `concurrent-worker-${index + 1}`, {
      sessionId,
      token: prepared.token,
      executor: prepared.ticket.dispatchExecutor,
    }).ok, true);
  }

  const firstStop = runHook(SUBAGENT_STOP, {
    session_id: sessionId,
    agent_type: preparedFirst.ticket.dispatchExecutor,
    agent_id: 'native-concurrent-1',
    agent_name: names[0],
  });
  assert.match(firstStop, new RegExp(`HOLDING ${first.ref} claim`));
  assert.equal(store.getTicket(slug, first.ref).dispatch.outcome, 'stopped_claimed');
  assert.equal(store.getTicket(slug, second.ref).dispatch.outcome, 'claimed');

  const secondStop = runHook(SUBAGENT_STOP, {
    session_id: sessionId,
    agent_type: preparedSecond.ticket.dispatchExecutor,
    agent_id: 'native-concurrent-2',
  });
  assert.match(secondStop, new RegExp(`HOLDING ${second.ref} claim`));
  assert.doesNotMatch(secondStop, new RegExp(`${first.ref}.*(?:release \\+ respawn|TaskStop)`));
  assert.equal(store.getTicket(slug, second.ref).dispatch.outcome, 'stopped_claimed');
});

test('session start reconciles a reload-lost launch once and leaves it ready to respawn', () => {
  const ticket = addEffortTicket('reload before claim', 'high');
  const sessionId = `reload-${++sqSeq}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
    agentName: 'lost-native-task',
  }).ok, true);
  const first = runHook(SESSION, { session_id: sessionId, source: 'resume' });
  assert.match(first, new RegExp(`${ticket.ref} launched but never claimed`));
  const after = store.getTicket(slug, ticket.ref);
  assert.equal(after.status, 'todo');
  assert.equal(after.dispatch.outcome, 'failed');
  assert.equal(after.dispatchNonce, null);
  assert.deepStrictEqual(store.reconcileLaunchedDispatches(sessionId, { source: 'session-start' }).reconciled, []);
  const second = runHook(SESSION, { session_id: sessionId, source: 'resume' });
  assert.ok(!second.includes('launched but never claimed'));
});

test('subagent stop marks a launch that never claimed as failed', () => {
  const ticket = addEffortTicket('stop before claim', 'high');
  const sessionId = `stop-${++sqSeq}`;
  const prepared = store.prepareDispatch(slug, ticket.ref, { sessionId });
  assert.equal(store.recordDispatchLaunch(slug, ticket.ref, {
    sessionId,
    token: prepared.token,
    executor: prepared.ticket.dispatchExecutor,
  }).ok, true);
  assert.equal(store.bindDispatchAgent(sessionId, prepared.ticket.dispatchExecutor, 'native-stop-1', 'stop-before-claim').ok, true);
  const context = runHook(SUBAGENT_STOP, {
    session_id: sessionId,
    agent_type: prepared.ticket.dispatchExecutor,
    agent_id: 'native-stop-1',
    agent_name: 'stop-before-claim',
  });
  assert.match(context, /without ever claiming/);
  const after = store.getTicket(slug, ticket.ref);
  assert.equal(after.dispatch.outcome, 'failed');
  assert.equal(after.dispatchNonce, null);
});

test('subagent-stop: legacy ticket executors without identity stay silent', () => {
  assert.strictEqual(
    runHook(SUBAGENT_STOP, { session_id: 'sess-legacy-ticket', agent_type: 'sidequest-ticket-sq-584-haiku-b37fffcb' }),
    ''
  );
});

test('pre-tool hook: dispatch executor requires a canonical route marker and legacy executors cannot launch', () => {
  const missingMarker = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-dispatch-high', name: 'w-dispatch-no-marker', prompt: 'work SQ-377' },
  });
  assert.equal(missingMarker.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(
    missingMarker.hookSpecificOutput.permissionDecisionReason,
    "sidequest: dispatch executor is missing the route marker from spawn.prompt. Re-run dispatch and pass the returned spawn unchanged."
  );

  const builtIn = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-exec-high', model: 'opus', name: 'w-builtin-no-marker', prompt: 'work SQ-377' },
  });
  assert.ok(!builtIn.hookSpecificOutput.permissionDecision, 'markerless builtin executors remain valid');
  assert.equal(builtIn.hookSpecificOutput.updatedInput.mode, 'bypassPermissions');

  const legacy = runHookOutput(FORCE_BYPASS, {
    tool_name: 'Agent',
    tool_input: { subagent_type: 'sidequest-ticket-sq-584-haiku-b37fffcb', name: 'w-legacy', prompt: 'work SQ-377' },
  });
  assert.equal(legacy.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(legacy.hookSpecificOutput.permissionDecisionReason, /not a recognized ticket executor/);
});
