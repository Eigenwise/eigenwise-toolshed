#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { readStdin, stringField, type HookInput } from './shared/input.js';
import { runtimeModule } from './shared/paths.js';

// Executors run inside the orchestrator's Claude process, so anything an executor starts in its worktree (a dev
// stack, a watcher) records the orchestrator's pid as its owner, and a reaper keyed on that pid keeps it alive until
// the whole session exits (GH-150). The executor's own stop is the event that ends its ownership, so it is written
// into the worktree's private git directory, where a project reaper can read it without the board and git never
// sees it as a change: `git rev-parse --git-path sidequest-dispatch.json`.
const DISPATCH_STATE_FILE = 'sidequest-dispatch.json';

interface AgentDispatch {
  ref: string;
  worktree: string;
  outcome: string | null;
  terminalAt: string | null;
}

function linkedGitDirectory(worktree: string): string | null {
  const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(worktree, '.git'), 'utf8'))?.[1];
  return pointer ? path.resolve(worktree, pointer.trim()) : null;
}

function writeDispatchState(dispatch: AgentDispatch, sessionId: string, agentId: string, stoppedAt: string): void {
  try {
    const gitDirectory = linkedGitDirectory(dispatch.worktree);
    if (!gitDirectory) return;
    const { ref, outcome, terminalAt } = dispatch;
    fs.writeFileSync(path.join(gitDirectory, DISPATCH_STATE_FILE), `${JSON.stringify({ schemaVersion: 1, ref, sessionId, agentId, outcome, terminalAt, stoppedAt })}\n`);
  } catch (_) {
    // A swept or unreadable worktree has no stack left to reap.
  }
}

function recordAgentDispatchState(input: HookInput): void {
  const sessionId = stringField(input, 'session_id', 'sessionId');
  const agentId = stringField(input, 'agent_id', 'agentId');
  const stoppedAt = new Date().toISOString();
  const store = require(runtimeModule('store')) as { agentDispatchWorktrees: (sessionId: string, agentId: string) => AgentDispatch[] };
  for (const dispatch of store.agentDispatchWorktrees(sessionId, agentId)) {
    writeDispatchState(dispatch, sessionId, agentId, stoppedAt);
  }
}

try {
  const input = readStdin();
  if (input) recordAgentDispatchState(input);
} catch (_) {
  process.exit(0);
}
