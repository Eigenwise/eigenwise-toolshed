#!/usr/bin/env node
import { readStdin, stringField } from './shared/input.js';
import { runtimeModule } from './shared/paths.js';

function main(): void {
  const data = readStdin();
  if (!data) return;
  const sessionId = stringField(data, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
  if (!sessionId) return;
  const reasonValue = data.reason;
  const reason = reasonValue ? `session ended (${String(reasonValue)})` : 'session ended';
  try {
    const store = require(runtimeModule('store')) as {
      reconcileSession: (sessionId: string, options: { reason: string; source: string }) => unknown;
    };
    store.reconcileSession(sessionId, { reason, source: 'session-end' });
    const agentsync = require(runtimeModule('agentsync')) as {
      cleanupNativeAgents: (options: { sessionId: string }) => unknown;
    };
    agentsync.cleanupNativeAgents({ sessionId });
  } catch (_) {}
}

try {
  main();
} catch (_) {
  process.exit(0);
}
