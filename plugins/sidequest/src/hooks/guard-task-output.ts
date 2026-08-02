#!/usr/bin/env node
import { isRecord, isSubagent, readStdin, stringField } from './shared/input.js';
import { writeDeny } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';

interface Dispatch {
  sessionId?: string;
  agentName?: string;
  agentId?: string;
}

function sessionDispatchIds(sessionId: string): Set<string> {
  if (!sessionId) return new Set();
  try {
    const store = require(runtimeModule('store')) as {
      listProjects: (options: { all: boolean }) => Array<{ slug: string }>;
      listTickets: (slug: string) => Array<{ dispatch?: Dispatch }>;
    };
    const ids = new Set<string>();
    for (const project of store.listProjects({ all: true })) {
      for (const ticket of store.listTickets(project.slug)) {
        const dispatch = ticket.dispatch;
        if (!dispatch || dispatch.sessionId !== sessionId) continue;
        for (const value of [dispatch.agentName, dispatch.agentId]) {
          if (typeof value === 'string' && value) ids.add(value);
        }
      }
    }
    return ids;
  } catch (_) {
    return new Set();
  }
}

function sidequestTaskId(value: unknown, dispatchedIds: Set<string>): boolean {
  if (typeof value !== 'string' || !value) return false;
  const lowered = value.toLowerCase();
  if (lowered.startsWith('sidequest-')) return true;
  if (dispatchedIds.has(value)) return true;
  return lowered.includes('sidequest') && /@session-[^\s]+/i.test(value);
}

function main(): void {
  const data = readStdin();
  if (!data || isSubagent(data) || data.tool_name !== 'TaskOutput' || !isRecord(data.tool_input)) return;
  const sessionId = stringField(data, 'session_id', 'sessionId') || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
  const dispatchedIds = sessionDispatchIds(sessionId);
  if (sidequestTaskId(data.tool_input.task_id, dispatchedIds) || sidequestTaskId(data.tool_input.id, dispatchedIds)) {
    writeDeny('PreToolUse', 'sidequest: native Agent results arrive automatically. Use pulse <ref> / changes --since for liveness. Use TaskStop only after terminal board evidence.');
  }
}

try {
  main();
} catch (_) {
  process.exit(0);
}
