import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const outputModule = path.join(__dirname, '..', 'src', 'hooks', 'shared', 'output.ts');

function emittedOutput(expression: string): Record<string, unknown> {
  const script = `const output = require(${JSON.stringify(outputModule)}); ${expression};`;
  return JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '-e', script], { encoding: 'utf8' }));
}

function outputContext(output: Record<string, unknown>): string {
  const hookOutput = output.hookSpecificOutput as { additionalContext?: string };
  return String(hookOutput.additionalContext || '');
}

test('hook context projections stay UTF-8 safe at every model-facing budget', () => {
  const cases = [
    ['SessionStart', 2 * 1024],
    ['UserPromptSubmit', 1024],
    ['PreToolUse', 768],
    ['Stop', 512],
    ['SubagentStart', 512],
    ['SubagentStop', 512],
    ['PostToolUseFailure', 512],
  ] as const;
  for (const [event, budget] of cases) {
    const output = emittedOutput(`output.writeContext(${JSON.stringify(event)}, 'ACT: recover with the typed board call. ' + '🙂'.repeat(4000))`);
    const context = outputContext(output);
    assert.ok(Buffer.byteLength(context, 'utf8') <= budget, `${event} exceeded ${budget} bytes`);
    assert.match(context, /content omitted/);
    assert.match(context, /revision=/);
    assert.match(context, /ACT: recover with the typed board call/);
  }
});

test('denial projections keep the recovery action inside the PreToolUse budget', () => {
  const output = emittedOutput("output.writeDeny('PreToolUse', 'Re-run dispatch and pass its returned spawn unchanged. ' + '界'.repeat(4000))");
  const hookOutput = output.hookSpecificOutput as { permissionDecisionReason?: string };
  const reason = String(hookOutput.permissionDecisionReason || '');
  assert.ok(Buffer.byteLength(reason, 'utf8') <= 768);
  assert.match(reason, /^Re-run dispatch and pass its returned spawn unchanged\./);
  assert.match(reason, /content omitted/);
});

test('routine system and teammate notifications use their bounded projections', () => {
  const system = emittedOutput("output.writeSystemMessage('PostToolUseFailure', 'Recover now. ' + '🙂'.repeat(4000))");
  assert.ok(Buffer.byteLength(outputContext(system), 'utf8') <= 512);
  const teammate = emittedOutput("output.writeTeammateStop('End this idle executor. ' + '🙂'.repeat(4000))");
  assert.ok(Buffer.byteLength(String(teammate.stopReason || ''), 'utf8') <= 512);
});
