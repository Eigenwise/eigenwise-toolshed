#!/usr/bin/env node
import { readStdin, stringField, type HookInput } from './shared/input.js';
import { runtimeModule } from './shared/paths.js';
import { recordSessionEndHandoff } from './shared/sweep-handoff.js';
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

// Claude Code gives SessionEnd about 1.5 s however long the hook's timeout says, so no sweep starts
// here: one that ran past it was cancelled mid-write and left this session registered as live (SQ-51,
// GH-400). Unregistering and recording the handoff are single small writes and go first.
function main(): void {
  const data = readStdin();
  const sessionId = endedSessionId(data);
  if (!data || !sessionId) return;
  unregisterSweepSession(data);
  recordSessionEndHandoff(data);
  const notices = reconcileEndedSession(sessionId, endReason(data));
  if (notices.length) console.error(notices.join('\n'));
}

try {
  main();
} catch (error: any) {
  console.error(`sidequest: session-end failed: ${(error && error.message) || error}`);
}
