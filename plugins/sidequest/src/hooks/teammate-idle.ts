#!/usr/bin/env node
import { readStdin, stringField } from './shared/input.js';
import { writeJson } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';

interface TerminalDispatch {
  ref: string;
  outcome: string;
}

function terminalDispatchForIdle(identity: Record<string, string>): TerminalDispatch | null {
  try {
    const store = require(runtimeModule('store')) as {
      terminalDispatchForIdle: (identity: Record<string, string>) => TerminalDispatch | null;
    };
    return store.terminalDispatchForIdle(identity);
  } catch (_) {
    return null;
  }
}

function main(): void {
  const input = readStdin();
  if (!input || input.stop_hook_active) return;
  const identity = {
    sessionId: stringField(input, 'session_id', 'sessionId'),
    agentId: stringField(input, 'agent_id', 'agentId', 'teammate_id', 'teammateId'),
    agentName: stringField(input, 'agent_name', 'agentName', 'teammate_name', 'teammateName', 'name'),
    executor: stringField(input, 'agent_type', 'agentType'),
  };
  if (!identity.agentId && !identity.agentName) return;

  const terminal = terminalDispatchForIdle(identity);
  if (!terminal) return;
  writeJson({
    continue: false,
    stopReason: `sidequest: ${terminal.ref} is terminal (${terminal.outcome}); end this idle executor.`,
  });
}

try {
  main();
} catch (_) {
  process.exit(0);
}
