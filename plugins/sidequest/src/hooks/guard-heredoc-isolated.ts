#!/usr/bin/env node
import path from 'node:path';
import { readStdin, stringField, isRecord } from './shared/input.js';
import { writeDeny } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';

interface IsolationExpectation {
  sharedTree: boolean;
}

function bashCommand(input: Record<string, unknown>): string {
  const toolInput = input.tool_input;
  if (!isRecord(toolInput)) return '';
  return String(toolInput.command || '');
}

function hasHereDoc(command: string): boolean {
  let quote: 'single' | 'double' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote === 'single') {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === 'double') {
      if (character === '\\') index += 1;
      else if (character === '"') quote = null;
      continue;
    }
    if (character === "'") {
      quote = 'single';
      continue;
    }
    if (character === '"') {
      quote = 'double';
      continue;
    }
    if (character === '#') {
      const previous = command[index - 1];
      if (previous === undefined || /[\s;&|(]/.test(previous)) {
        const lineEnd = command.indexOf('\n', index);
        if (lineEnd < 0) return false;
        index = lineEnd;
      }
      continue;
    }
    if (character === '<' && command[index + 1] === '<' && command[index + 2] !== '<') return true;
  }
  return false;
}

function dispatchedInWorktree(input: Record<string, unknown>): boolean {
  try {
    const store = require(runtimeModule('store')) as {
      dispatchIsolationExpectation: (identity: unknown) => IsolationExpectation | null;
    };
    const found = store.dispatchIsolationExpectation({
      agentId: stringField(input, 'agent_id', 'agentId'),
      executor: stringField(input, 'agent_type', 'agentType', 'subagent_type'),
      sessionId: stringField(input, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || '',
      observedWorktree: stringField(input, 'cwd') || process.cwd(),
    });
    return found?.sharedTree === false;
  } catch (_) {
    return false;
  }
}

function harnessWorktreeCwd(input: Record<string, unknown>): boolean {
  const cwd = stringField(input, 'cwd') || process.cwd();
  const parts = path.resolve(cwd).split(/[\\/]+/).map((part) => part.toLowerCase());
  return parts.some((part, index) => (
    part === 'worktrees'
    && parts.slice(0, index).includes('.claude')
    && (parts[index + 1]?.startsWith('agent-') === true || parts[index + 2]?.startsWith('agent-') === true)
  ));
}

function main(): void {
  const input = readStdin();
  if (!input || stringField(input, 'tool_name') !== 'Bash') return;
  if (!hasHereDoc(bashCommand(input))) return;
  if (!dispatchedInWorktree(input) && !harnessWorktreeCwd(input)) return;
  writeDeny('PreToolUse', 'sidequest: the harness refuses heredocs in isolated worktrees; Write the script to your scratchpad and run it by path.');
}

try {
  main();
} catch (_) {
  process.exit(0);
}
