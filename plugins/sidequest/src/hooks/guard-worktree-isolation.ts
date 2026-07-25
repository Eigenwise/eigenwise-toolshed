#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { readStdin, stringField, isRecord } from './shared/input.js';
import { writeDeny } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const AGENT_WORKTREE = `${path.sep}.claude${path.sep}worktrees${path.sep}agent-`;

interface IsolationExpectation {
  ref: string;
  projectPath: string | null;
  expectedWorktree: string | null;
  matchedBy: string;
}

function targetPath(input: Record<string, unknown>): string {
  const toolInput = input.tool_input;
  if (!isRecord(toolInput)) return '';
  const value = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path;
  const target = value == null ? '' : String(value);
  return target && path.isAbsolute(target) ? path.resolve(target) : '';
}

function insideAgentWorktree(target: string): boolean {
  return `${target}${path.sep}`.includes(AGENT_WORKTREE);
}

function canonicalPath(value: string): string {
  let candidate = path.resolve(value);
  const missing: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(candidate);
      return path.join(real, ...missing.reverse());
    } catch (_) {
      const parent = path.dirname(candidate);
      if (parent === candidate) return path.resolve(value);
      missing.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

function repoRootFor(target: string): { root: string; linked: boolean } | null {
  let directory = path.dirname(canonicalPath(target));
  for (;;) {
    const gitEntry = path.join(directory, '.git');
    let stats: fs.Stats | null = null;
    try {
      stats = fs.statSync(gitEntry);
    } catch (_) {
      stats = null;
    }
    if (stats) return { root: directory, linked: stats.isFile() };
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function samePath(a: string, b: string): boolean {
  const normalize = (value: string) => {
    const resolved = canonicalPath(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
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

// The refusal has to be usable by an agent that believes it is isolated: name
// the ticket, the tree it was promised, the tree it is actually writing to, and
// the one move that saves the work. Losing the worktree is a platform failure,
// not executor misbehaviour, so the message must not read like an accusation.
function refusal(found: IsolationExpectation, target: string, repoRoot: string, agentId: string, cwd: string): string {
  const expected = found.expectedWorktree || path.join(repoRoot, '.claude', 'worktrees', `agent-${agentId || '<agent id>'}`);
  return [
    `sidequest: refusing this write. ${found.ref} was dispatched with worktree isolation, but this write lands in the SHARED checkout.`,
    `  expected worktree: ${expected}`,
    `  writing to:        ${target}`,
    `  shared checkout:   ${repoRoot}${cwd && !samePath(cwd, repoRoot) ? ` (cwd ${cwd})` : ''}`,
    'You did nothing wrong: the worktree you were given is gone. The harness deletes an isolated worktree when an agent stops with it unchanged, so a pause-and-resume before your first edit lands you here silently.',
    `Do not work around this. Stop writing, tell the orchestrator "${found.ref} lost its worktree, re-dispatch it", and leave the shared tree untouched. If you already have staged work here, say so: the orchestrator commits it out of the shared tree, releases the claim, then closes with the shipped commit as evidence.`,
  ].join('\n');
}

function main(): void {
  const input = readStdin();
  if (!input || !WRITE_TOOLS.has(stringField(input, 'tool_name'))) return;
  const agentId = stringField(input, 'agent_id', 'agentId');
  const executor = stringField(input, 'agent_type', 'agentType', 'subagent_type');
  if (!agentId || !executorAgent(executor)) return;

  const target = targetPath(input);
  if (!target || insideAgentWorktree(target)) return;
  const repo = repoRootFor(target);
  if (!repo || repo.linked) return;

  const found = expectation(input, agentId, executor);
  if (!found) return;
  if (found.projectPath && !samePath(found.projectPath, repo.root)) return;
  writeDeny('PreToolUse', refusal(found, target, repo.root, agentId, stringField(input, 'cwd')));
}

try {
  main();
} catch (_) {
  process.exit(0);
}
