#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readStdin, stringField, isRecord } from './shared/input.js';
import { writeDeny } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';
import { executorAgent, isolationExpectation, type IsolationExpectation } from './shared/runtime-identity.js';

const MUTATING_SUBCOMMANDS = new Set([
  'add', 'am', 'apply', 'branch', 'checkout', 'cherry-pick', 'clean', 'commit', 'merge', 'mv',
  'rebase', 'reset', 'restore', 'revert', 'rm', 'sparse-checkout', 'stash', 'switch', 'tag',
  'update-ref', 'worktree',
]);

function commandText(input: Record<string, unknown>): string {
  const toolInput = input.tool_input;
  return isRecord(toolInput) ? String(toolInput.command || '') : '';
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

function otherExecutorWorktree(root: string, found: IsolationExpectation): boolean {
  if (!found.expectedWorktree || samePath(root, found.expectedWorktree)) return false;
  try {
    const worktrees = require(runtimeModule('worktrees')) as { isAgentWorktree: (repo: string, worktree: string) => boolean };
    return worktrees.isAgentWorktree(found.projectPath!, root);
  } catch (_) {
    return false;
  }
}

// The protected set is every checkout the board hands out: the registered root and the agent worktrees
// under its worktree roots. A clone the executor made itself (under the ticket's verification directory,
// the scratchpad, anywhere) belongs to nobody else and stays writable (SQ-3436).
function protectedCheckout(root: string, found: IsolationExpectation): boolean {
  return samePath(root, found.projectPath!) || otherExecutorWorktree(root, found);
}

function refusal(root: string): string {
  return `sidequest: refusing a mutating git command against the shared checkout (${root}) from an isolated worktree. The shared checkout means the project's registered root and every other executor's worktree; a clone you created under your ticket's verification directory or scratchpad is not it and stays writable. Read-only git commands such as log, diff, show, rev-parse, and ls-files are allowed for review; make repository changes only in the assigned worktree.`;
}

function main(): void {
  const input = readStdin();
  if (!input || !['Bash', 'PowerShell'].includes(stringField(input, 'tool_name'))) return;
  const agentId = stringField(input, 'agent_id', 'agentId');
  const executor = stringField(input, 'agent_type', 'agentType', 'subagent_type');
  if (!agentId || !executorAgent(executor)) return;
  const found = isolationExpectation(input, agentId, executor, false);
  if (!found || found.sharedTree || found.terminal || !found.projectPath) return;
  const invocation = gitInvocation(commandText(input));
  if (!invocation || !MUTATING_SUBCOMMANDS.has(invocation.subcommand)) return;
  const root = targetRoot(invocation.target, stringField(input, 'cwd'));
  if (protectedCheckout(root, found)) writeDeny('PreToolUse', refusal(root));
}

try {
  main();
} catch (_) {
  process.exit(0);
}
