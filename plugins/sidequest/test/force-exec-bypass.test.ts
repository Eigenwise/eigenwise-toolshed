import './hooks.test.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

test('correction host hook denies subagents including malformed correct and permits trusted main', () => {
  const hook = path.join(__dirname, '../hooks/force-exec-bypass.js');
  const cases = [
    { agent_id: 'synthetic-subagent', tool_name: 'verdict', tool_input: { correct: {} }, denied: true, message: 'subagents cannot correct finalized review verdicts' },
    { agent_id: 'synthetic-subagent', tool_name: 'verdict', tool_input: { correct: null }, denied: true, message: 'subagents cannot correct finalized review verdicts' },
    { agent_id: '', tool_name: 'verdict', tool_input: { correct: {} }, denied: false, message: '' },
    { agent_id: 'synthetic-subagent', tool_name: 'verdict', tool_input: { outcome: 'accepted' }, denied: false, message: '' },
    { agent_id: 'synthetic-subagent', tool_name: 'update', tool_input: { files: ['synthetic.js'] }, denied: true, message: 'subagents cannot update closeout fields' },
    { agent_id: 'synthetic-subagent', tool_name: 'remove', tool_input: { force: true }, denied: true, message: 'subagents cannot force-remove a ticket' },
  ];
  for (const entry of cases) {
    const result = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', ...entry, tool_name: `mcp__plugin_sidequest_board__${entry.tool_name}` }),
      encoding: 'utf8', windowsHide: true, timeout: 30_000,
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes('"permissionDecision":"deny"'), entry.denied);
    if (entry.denied) assert.equal(result.stdout.includes(entry.message), true);
  }
});

function preToolUseDecision(agentId: string, sessionId: string, toolInput: Record<string, unknown>): string {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../hooks/force-exec-bypass.js')], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', agent_id: agentId, session_id: sessionId,
      tool_name: 'mcp__plugin_sidequest_board__update', tool_input: toolInput }),
    encoding: 'utf8', windowsHide: true, timeout: 30_000,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'composition-main-session', CLAUDE_SESSION_ID: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('composition admission host hook denies subagent probes and grants, even with the main session id, and permits trusted main', () => {
  const probe = { ref: 'SQ-1', admitComposition: { authority: 'main-attestation', historicalCheckout: false } };
  const grant = { ref: 'SQ-1', admitComposition: { ...probe.admitComposition, expected: { attemptCount: 1 } } };
  for (const [sessionId, toolInput] of [['subagent-session', probe], ['composition-main-session', grant]] as const) {
    const denied = preToolUseDecision('synthetic-subagent', sessionId, toolInput);
    assert.equal(denied.includes('"permissionDecision":"deny"'), true);
    assert.equal(denied.includes('admit a composition'), true);
  }
  assert.equal(preToolUseDecision('', 'composition-main-session', grant).includes('"permissionDecision":"deny"'), false);
});


test('work provenance host hook rejects a worker declaration under the main session and permits the main thread', () => {
  const hook = path.join(__dirname, '../hooks/force-exec-bypass.js');
  const declaration = { ref: 'SQ-1', workProvenance: { kind: 'inherited-read-only', sources: [] } };
  const worker = spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: 'PreToolUse', agent_id: 'synthetic-worker',
    session_id: 'synthetic-main', tool_name: 'mcp__plugin_sidequest_board__dispatch', tool_input: declaration }),
    encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.equal(worker.status, 0, worker.stderr);
  assert.match(worker.stdout, /subagents cannot declare work provenance/);
  const main = spawnSync(process.execPath, [hook], { input: JSON.stringify({ hook_event_name: 'PreToolUse', agent_id: '',
    session_id: 'synthetic-main', tool_name: 'mcp__plugin_sidequest_board__dispatch', tool_input: declaration }),
    encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.equal(main.status, 0, main.stderr);
  assert.equal(main.stdout.includes('"permissionDecision":"deny"'), false);
});

function nativeAgentDecision(toolInput: Record<string, unknown>): string {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../hooks/force-exec-bypass.js')], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: toolInput }),
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('native read-only agents need no ticket or board dispatch', () => {
  for (const subagent_type of ['general-purpose', 'Explore', 'Plan', 'claude-code-guide', 'fork', 'custom-reader']) {
    assert.equal(nativeAgentDecision({ subagent_type, description: 'Locate call sites', prompt: 'Find callers and report source paths.' }), '', subagent_type);
  }
  assert.equal(nativeAgentDecision({ subagent_type: 'general-purpose', prompt: 'Read the file. Do not edit it.' }), '');
  assert.equal(nativeAgentDecision({ subagent_type: 'general-purpose', prompt: 'Find the commit that changed the hook and report its hash.' }), '');
});

test('native ticket refs and route markers require dispatch even for Explore', () => {
  for (const subagent_type of ['general-purpose', 'Explore', 'Plan']) {
    for (const prompt of ['Inspect SQ-3643.', '[sidequest-route model=sonnet effort=medium ticket=SQ-1] Read files.']) {
      assert.match(nativeAgentDecision({ subagent_type, prompt }), /requests write or ticket work without a prepared dispatch/);
    }
    assert.match(nativeAgentDecision({ subagent_type, description: 'Inspect SQ-1', prompt: 'Read files.' }), /permissionDecision.*deny/);
  }
});

test('native write intent and undispatched Sidequest executor remain refused', () => {
  for (const prompt of ['Edit the source.', 'Commit the patch.', 'Push the branch.', 'Install dependencies.']) {
    assert.match(nativeAgentDecision({ subagent_type: 'general-purpose', prompt }), /permissionDecision.*deny/);
  }
  assert.match(nativeAgentDecision({ subagent_type: 'custom-reader', description: 'Edit source', prompt: 'Read files.' }), /permissionDecision.*deny/);
  assert.match(nativeAgentDecision({ subagent_type: 'sidequest:sidequest-exec-dispatch', prompt: 'Read files.' }), /exact prepared FIRST action briefing command/);
});
