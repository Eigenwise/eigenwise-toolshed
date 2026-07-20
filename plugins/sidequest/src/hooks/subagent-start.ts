#!/usr/bin/env node
import { readStdin, stringField } from './shared/input.js';
import { runtimeModule } from './shared/paths.js';

type ExecutorKind = 'codex_dispatch' | 'claude_builtin' | 'legacy_ticket' | 'ticket' | 'unknown';
interface ExecutorClassification {
  kind: ExecutorKind;
  effort: string | null;
}

function fallbackClassify(type: string): ExecutorClassification {
  const dispatch = /^sidequest-exec-dispatch-(low|medium|high|xhigh|max)$/.exec(type);
  if (dispatch) return { kind: 'codex_dispatch', effort: dispatch[1] || null };
  const builtin = /^sidequest-exec-(low|medium|high|xhigh|max)$/.exec(type);
  if (builtin) return { kind: 'claude_builtin', effort: builtin[1] || null };
  if (/^sidequest-ticket-/.test(type)) return { kind: 'legacy_ticket', effort: null };
  if (/^sidequest-(?:sq-|exec-)/.test(type)) return { kind: 'ticket', effort: null };
  return { kind: 'unknown', effort: null };
}

function classifyExecutor(type: string): ExecutorClassification {
  try {
    return require(runtimeModule('exec-names')).classify(type) as ExecutorClassification;
  } catch (_) {
    return fallbackClassify(type);
  }
}

function main(): void {
  const data = readStdin();
  if (!data) return;
  const sessionId = stringField(data, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
  const executor = stringField(data, 'agent_type', 'agentType', 'subagent_type');
  const agentId = stringField(data, 'agent_id', 'agentId');
  const agentName = stringField(data, 'agent_name', 'agentName', 'name');
  if (!sessionId || !executor || !agentId || classifyExecutor(executor).kind === 'unknown') return;
  const store = require(runtimeModule('store')) as {
    bindDispatchAgent: (sessionId: string, executor: string, agentId: string, agentName: string | null) => unknown;
  };
  store.bindDispatchAgent(sessionId, executor, agentId, agentName || null);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
