import './hooks.test.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('correction host hook denies subagents including malformed correct and permits trusted main', () => {
  const hook = path.join(__dirname, '../hooks/force-exec-bypass.js');
  const cases = [
    { agent_id: 'synthetic-subagent', tool_name: 'verdict', tool_input: { correct: {} }, denied: true, message: 'subagents cannot finalize or correct completed review verdicts' },
    { agent_id: 'synthetic-subagent', tool_name: 'verdict', tool_input: { correct: null }, denied: true, message: 'subagents cannot finalize or correct completed review verdicts' },
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

test('native route markers require dispatch even for Explore', () => {
  for (const subagent_type of ['general-purpose', 'Explore', 'Plan']) {
    assert.match(nativeAgentDecision({ subagent_type, prompt: '[sidequest-route model=sonnet effort=medium ticket=SQ-1] Read files.' }),
      /requests write or ticket work without a prepared dispatch/);
  }
});

test('read-only native agents may cite ticket refs as lookup context but not to write them', () => {
  const triage = 'Triage open GitHub issues. Flag duplicates of SQ-3502 and SQ-3043 and report links.';
  for (const subagent_type of ['Explore', 'Plan', 'claude-code-guide']) {
    assert.equal(nativeAgentDecision({ subagent_type, prompt: triage }), '', subagent_type);
    assert.equal(nativeAgentDecision({ subagent_type, description: 'Inspect SQ-1', prompt: 'Read files.' }), '', subagent_type);
    assert.match(nativeAgentDecision({ subagent_type, prompt: 'Edit SQ-1234 to fix the hook.' }),
      /requests write or ticket work without a prepared dispatch/, subagent_type);
  }
});

test('write-capable native agents citing only a ticket ref are refused with the read-only alternative', () => {
  for (const subagent_type of ['general-purpose', 'custom-reader']) {
    const decision = nativeAgentDecision({ subagent_type, prompt: 'Inspect SQ-3643.' });
    assert.match(decision, /cites a ticket ref without a prepared dispatch/, subagent_type);
    assert.match(decision, /spawn Explore, Plan, claude-code-guide instead/, subagent_type);
  }
  assert.match(nativeAgentDecision({ subagent_type: 'general-purpose', prompt: 'Edit SQ-1234.' }),
    /requests write or ticket work without a prepared dispatch/);
});

test('native write intent and undispatched Sidequest executor remain refused', () => {
  for (const prompt of ['Edit the source.', 'Commit the patch.', 'Push the branch.', 'Install dependencies.']) {
    assert.match(nativeAgentDecision({ subagent_type: 'general-purpose', prompt }), /permissionDecision.*deny/);
  }
  assert.match(nativeAgentDecision({ subagent_type: 'custom-reader', description: 'Edit source', prompt: 'Read files.' }), /permissionDecision.*deny/);
  assert.match(nativeAgentDecision({ subagent_type: 'sidequest:sidequest-exec-dispatch', prompt: 'Read files.' }), /exact prepared FIRST action briefing command/);
});

const RESEARCH_LINE = 'Read-only research run, no ticket: deliver your findings as your final message; do not claim, comment or write.';

function researchDecision(project: string, toolInput: Record<string, unknown>): { denied: boolean; reason: string; updatedInput: Record<string, unknown> | undefined } {
  const result = spawnSync(process.execPath, [path.join(__dirname, '../hooks/force-exec-bypass.js')], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', cwd: project, tool_input: toolInput }),
    encoding: 'utf8', windowsHide: true, timeout: 30_000,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '', CLAUDE_CODE_SUBAGENT_MODEL: '', CLAUDE_PROJECT_DIR: project },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput : {};
  return { denied: output.permissionDecision === 'deny', reason: String(output.permissionDecisionReason || ''), updatedInput: output.updatedInput };
}

test('SQ-3739: a read-only executor with a live category research prefix runs without a ticket', () => {
  const store = require('../lib/store.js');
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-3739-research-'));
  const { slug } = store.ensureProject(project);
  store.setCategory({ id: 'sq3739-codex-research', name: 'sq3739-codex-research', route: { model: 'codex-gpt-6-1-sol', effort: 'medium' }, fallback: null, readonly: true, enabled: true });
  store.setCategory({ id: 'sq3739-claude-research', name: 'sq3739-claude-research', route: { model: 'haiku', effort: 'max' }, fallback: null, readonly: true, enabled: true });
  // Other suites share this profile, so their categories are switched off for this project; a stale marker must not stay live through one of them.
  for (const category of store.getCategories({ project: slug })) {
    if (category.enabled && category.id !== 'general' && !category.id.startsWith('sq3739-')) store.setProjectCategory(slug, category.id, 'DISABLE', {});
  }
  assert.notDeepEqual(store.getCategory('general', { project: slug }).route, { model: 'haiku', effort: 'max' }, 'general, which cannot be disabled, must not share the stale route');
  const codexPrompt = `[sidequest-route model=gpt-6.1-sol effort=medium]\n${RESEARCH_LINE}\n\nHow does the UX of the board page read? Edit nothing.`;
  const claudePrompt = `[sidequest-route model=haiku effort=max]\n${RESEARCH_LINE}\n\nFind every caller of routeMarker.`;

  const codex = researchDecision(project, { subagent_type: 'sidequest:sidequest-exec-dispatch-readonly', model: 'opus', isolation: 'worktree', mode: 'bypassPermissions', description: 'UX research', prompt: codexPrompt });
  assert.equal(codex.denied, false, codex.reason);
  assert.equal(codex.updatedInput?.prompt, codexPrompt);
  assert.equal(Object.hasOwn(codex.updatedInput || {}, 'model'), false, 'the Codex definition pin selects the model');
  assert.equal(Object.hasOwn(codex.updatedInput || {}, 'isolation'), false, 'research runs in the parent tree');
  assert.equal(Object.hasOwn(codex.updatedInput || {}, 'mode'), false, 'a read-only executor never gets bypassPermissions');

  const claude = researchDecision(project, { subagent_type: 'sidequest:sidequest-exec-readonly-max', model: 'opus', description: 'Code research', prompt: claudePrompt });
  assert.equal(claude.denied, false, claude.reason);
  assert.equal(claude.updatedInput?.model, 'haiku', 'the Claude route model replaces the caller model');

  store.setCategory({ id: 'sq3739-claude-research', name: 'sq3739-claude-research', route: { model: 'haiku', effort: 'low' }, fallback: null, readonly: true, enabled: true });
  const stale = researchDecision(project, { subagent_type: 'sidequest:sidequest-exec-readonly-max', prompt: claudePrompt });
  assert.equal(stale.denied, true, 'a marker for a route the category no longer has is refused');
  assert.match(stale.reason, /live research prefix of an enabled category route/);
  const unknown = researchDecision(project, { subagent_type: 'sidequest:sidequest-exec-dispatch-readonly', prompt: `[sidequest-route model=gpt-9-ghost effort=medium]\n${RESEARCH_LINE}\n\nLook around.` });
  assert.equal(unknown.denied, true, 'an unknown marker is refused');
  assert.match(unknown.reason, /live research prefix/);
  const wrongExecutor = researchDecision(project, { subagent_type: 'sidequest:sidequest-exec-readonly-high', prompt: codexPrompt });
  assert.equal(wrongExecutor.denied, true, 'the marker must belong to the spawned executor type');

  assert.equal(researchDecision(project, { subagent_type: 'sidequest:sidequest-exec-dispatch', prompt: codexPrompt }).denied, true, 'a writable Codex executor still needs a dispatch');
  assert.equal(researchDecision(project, { subagent_type: 'sidequest:sidequest-exec-low', model: 'sonnet', prompt: `[sidequest-route model=sonnet effort=low]\n${RESEARCH_LINE}\n\nRead.` }).denied, true, 'a writable Claude executor still needs a dispatch');
  assert.match(researchDecision(project, { subagent_type: 'sidequest:sidequest-exec-dispatch-readonly', prompt: 'Read files.' }).reason, /exact prepared FIRST action briefing command/);
  assert.match(researchDecision(project, { subagent_type: 'sidequest:sidequest-exec-readonly-low', model: 'sonnet', prompt: 'Read files.' }).reason, /missing its dispatched ticket/);
});
