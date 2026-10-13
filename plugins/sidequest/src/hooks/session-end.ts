#!/usr/bin/env node
import { readStdin, stringField, type HookInput } from './shared/input.js';
import { runtimeModule } from './shared/paths.js';
import { detachSessionEndSweep, HANDOFF_FAILED_NOTICE } from './shared/sweep-handoff.js';
import { unregisterSweepSession } from './shared/worktree-sweep.js';

function endedSessionId(data: HookInput | null): string {
  if (!data) return '';
  return stringField(data, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
}

function endReason(data: HookInput): string {
  return data.reason ? `session ended (${String(data.reason)})` : 'session ended';
}

function reconcileEndedSession(sessionId: string, reason: string): string[] {
  try {
    const store = require(runtimeModule('store')) as {
      reconcileSession: (sessionId: string, options: { reason: string; source: string }) => unknown;
    };
    store.reconcileSession(sessionId, { reason, source: 'session-end' });
    const agentsync = require(runtimeModule('agentsync')) as {
      cleanupNativeAgents: (options: { sessionId: string }) => unknown;
    };
    agentsync.cleanupNativeAgents({ sessionId });
    return [];
  } catch (error: any) {
    return [`sidequest: session-end reconciliation failed: ${(error && error.message) || error}`];
  }
}

// Claude Code gives SessionEnd about 1.5 s however long the hook's timeout says, and a sweep over
// dozens of worktrees ran past it and was cancelled on every exit (SQ-51, GH-400, GH-439). The hook
// now only reconciles and starts a detached worker; the worker owns the sweep and this session's
// unregistration, so the session's own tree stays protected while that sweep runs.
async function main(): Promise<void> {
  const data = readStdin();
  const sessionId = endedSessionId(data);
  if (!data || !sessionId) return;
  const notices = reconcileEndedSession(sessionId, endReason(data));
  if (!detachSessionEndSweep(data)) {
    unregisterSweepSession(data);
    notices.push(HANDOFF_FAILED_NOTICE);
  }
  if (notices.length) console.error(notices.join('\n'));
}

main().catch((error) => {
  console.error(`sidequest: session-end failed: ${(error && error.message) || error}`);
});
