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
