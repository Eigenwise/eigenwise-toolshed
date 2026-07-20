#!/usr/bin/env node
import { isRecord, readStdin, stringField } from './shared/input.js';
import { writeDeny } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';

interface TerminalDispatch {
  ref: string;
  outcome: string;
}

function terminalDispatchTarget(agentName: string): TerminalDispatch | null {
  try {
    const store = require(runtimeModule('store')) as {
      terminalDispatchTarget: (agentName: string) => TerminalDispatch | null;
    };
    return store.terminalDispatchTarget(agentName);
  } catch (_) {
    return null;
  }
}

function main(): void {
  const input = readStdin();
  if (!input || stringField(input, 'tool_name') !== 'SendMessage' || !isRecord(input.tool_input)) return;
  const agentType = stringField(input, 'agent_type', 'agentType');
  const toRaw = input.tool_input.to;
  const to = String(toRaw == null ? '' : toRaw).trim();
  const terminal = terminalDispatchTarget(to);
  if (terminal) {
    writeDeny(
      'PreToolUse',
      `sidequest: ${terminal.ref} is terminal (${terminal.outcome}) and executor "${to}" is closed. ` +
        'Drop this queued steering message so it cannot wake a finished executor. Redispatch the ticket for later work; TaskStop the mapped executor if it is still listed.',
    );
    return;
  }
  if (!agentType.startsWith('sidequest-') || to.toLowerCase() === 'main') return;
  writeDeny(
    'PreToolUse',
    `sidequest: an executor (${agentType}) may not message another agent` +
      (to ? ` ("${to}")` : '') +
      '. Executors report UP — put it in your final message to the orchestrator, or a comment on your own ticket, and let the orchestrator route anything another ticket\'s owner needs. Do not nudge peers.',
  );
}

try {
  main();
} catch (_) {
  process.exit(0);
}
