#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readStdin, stringField, isRecord } from './shared/input.js';
import { writeDeny } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';

interface IsolationExpectation {
  projectPath: string | null;
  sharedTree: boolean;
  terminal: boolean;
}

const MUTATING_SUBCOMMANDS = new Set([
  'add', 'am', 'apply', 'branch', 'checkout', 'cherry-pick', 'clean', 'commit', 'merge', 'mv',
  'rebase', 'reset', 'restore', 'revert', 'rm', 'sparse-checkout', 'stash', 'switch', 'tag',
  'update-ref', 'worktree',
]);

function commandText(input: Record<string, unknown>): string {
  const toolInput = input.tool_input;
  return isRecord(toolInput) ? String(toolInput.command || '') : '';
}

function executorAgent(type: string): boolean {
  if (!type) return false;
  try {
    return require(runtimeModule('exec-names')).classify(type).kind !== 'unknown';
  } catch (_) {
    return /^sidequest-exec-/.test(type);
  }
}

function expectation(input: Record<string, unknown>, agentId: string, executor: string): IsolationExpectation | null {
  try {
    const store = require(runtimeModule('store')) as {
      dispatchIsolationExpectation: (identity: unknown) => IsolationExpectation | null;
    };
    return store.dispatchIsolationExpectation({
      agentId,
      executor,
      sessionId: stringField(input, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || '',
    });
  } catch (_) {
    return null;
  }
}

function canonicalPath(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch (_) {
    return path.resolve(value);
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = canonicalPath(left);
  const normalizedRight = canonicalPath(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function gitInvocation(command: string): { target: string; subcommand: string } | null {
  const match = /(?:^|[;&|\n]\s*)git\s+(?:-C\s+("[^"]+"|'[^']+'|\S+)\s+)?([a-z-]+)/i.exec(command);
  if (!match?.[2]) return null;
  const target = match[1] ? match[1].replace(/^["']|["']$/g, '') : '.';
  return { target, subcommand: match[2].toLowerCase() };
}

function targetRoot(target: string, cwd: string): string {
  const directory = path.resolve(cwd || '.', target);
  try {
    return canonicalPath(execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: directory,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
  } catch (_) {
    return canonicalPath(directory);
  }
}

function refusal(): string {
  return 'sidequest: refusing a mutating git command against the shared checkout from an isolated worktree. Read-only git commands such as log, diff, show, rev-parse, and ls-files are allowed for review; make repository changes only in the assigned worktree.';
}

function main(): void {
  const input = readStdin();
  if (!input || !['Bash', 'PowerShell'].includes(stringField(input, 'tool_name'))) return;
  const agentId = stringField(input, 'agent_id', 'agentId');
  const executor = stringField(input, 'agent_type', 'agentType', 'subagent_type');
  if (!agentId || !executorAgent(executor)) return;
  const found = expectation(input, agentId, executor);
  if (!found || found.sharedTree || found.terminal || !found.projectPath) return;
  const invocation = gitInvocation(commandText(input));
  if (!invocation || !MUTATING_SUBCOMMANDS.has(invocation.subcommand)) return;
  if (samePath(targetRoot(invocation.target, stringField(input, 'cwd')), found.projectPath)) {
    writeDeny('PreToolUse', refusal());
  }
}

try {
  main();
} catch (_) {
  process.exit(0);
}
