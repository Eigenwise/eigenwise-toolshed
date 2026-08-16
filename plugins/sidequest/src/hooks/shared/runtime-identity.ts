import fs from 'node:fs';
import path from 'node:path';
import { stringField, type HookInput } from './input.js';
import { runtimeModule } from './paths.js';

export type DispatchPhase = 'prepared' | 'created' | 'bound' | 'claimed' | 'working' | 'submitted' | 'integrated' | 'terminal';

export interface IsolationExpectation {
  ref: string;
  projectPath: string | null;
  expectedWorktree: string | null;
  expectedGitDirectory: string | null;
  expectedCommonGitDirectory: string | null;
  expectedCheckoutInstance: string | null;
  expectedRevision: string | null;
  matchedBy: string;
  identityBound: boolean;
  dispatchBaseline: string | null;
  phase: DispatchPhase;
  sharedTree: boolean;
  terminal: boolean;
}

export interface CheckoutLocation {
  root: string;
  linked: boolean;
}

export function canonicalPath(value: string): string {
  const kernel = require(runtimeModule('kernel/worktree')) as { canonicalPath: (value: string) => string };
  return kernel.canonicalPath(value);
}

export function executorAgent(type: string): boolean {
  if (!type) return false;
  try {
    return require(runtimeModule('exec-names')).classify(type).kind !== 'unknown';
  } catch (_) {
    return /^sidequest-exec-/.test(type);
  }
}

export function hookSessionId(input: HookInput): string {
  return stringField(input, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || '';
}

// A linked worktree's `.git` is a file pointing back at the shared object
// store; a primary checkout's is a directory. That difference is what tells an
// agent's own isolated checkout apart from the shared one it must never claim.
export function enclosingCheckout(start: string): CheckoutLocation | null {
  let directory = canonicalPath(start);
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

export function isolationExpectation(input: HookInput, agentId: string, executor: string): IsolationExpectation | null {
  try {
    const store = require(runtimeModule('store')) as {
      dispatchIsolationExpectation: (identity: unknown) => IsolationExpectation | null;
    };
    return store.dispatchIsolationExpectation({ agentId, executor, sessionId: hookSessionId(input) });
  } catch (_) {
    return null;
  }
}

// SQ-2153, SQ-2159. SubagentStart can reach the store before the worktree it
// names finished being created, and the dispatch is then left with no runtime
// identity at all. Re-offering the checkout the harness actually put this agent
// in lets the store re-check it against the completed creation facts: only the
// exact reserved target binds, and every other observed checkout stays unbound.
export function bindObservedRuntimeIdentity(input: HookInput, agentId: string, executor: string, worktree: string): void {
  try {
    const store = require(runtimeModule('store')) as {
      bindDispatchAgent: (sessionId: string, executor: string, agentId: string | null, agentName: string | null, worktree: string) => unknown;
    };
    const sessionId = hookSessionId(input);
    if (!sessionId) return;
    store.bindDispatchAgent(
      sessionId,
      executor,
      agentId,
      stringField(input, 'agent_name', 'agentName', 'name') || null,
      worktree,
    );
  } catch (_) {
  }
}
