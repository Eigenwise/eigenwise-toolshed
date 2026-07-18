#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function readStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    const data = raw ? JSON.parse(raw) : null;
    return data && typeof data === 'object' ? data : null;
  } catch (_) {
    return null;
  }
}

function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
}

function sessionDispatchIds(sessionId) {
  if (!sessionId) return new Set();
  try {
    const store = require(path.join(pluginRoot(), 'lib', 'store.js'));
    const ids = new Set();
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

function sidequestTaskId(value, dispatchedIds) {
  if (typeof value !== 'string' || !value) return false;
  const lowered = value.toLowerCase();
  if (lowered.startsWith('sidequest-')) return true;
  if (dispatchedIds.has(value)) return true;
  return lowered.includes('sidequest') && /@session-[^\s]+/i.test(value);
}

function deny() {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'sidequest: native Agent results arrive automatically. Use pulse <ref> / changes --since for liveness. Use TaskStop only after terminal board evidence.',
    },
  }));
}

function main() {
  const data = readStdin();
  if (!data || data.tool_name !== 'TaskOutput' || !data.tool_input || typeof data.tool_input !== 'object') return;
  const sessionId = String(data.session_id || data.sessionId || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '');
  const dispatchedIds = sessionDispatchIds(sessionId);
  if (sidequestTaskId(data.tool_input.task_id, dispatchedIds) || sidequestTaskId(data.tool_input.id, dispatchedIds)) deny();
}

try {
  main();
} catch (_) {
  process.exit(0);
}
