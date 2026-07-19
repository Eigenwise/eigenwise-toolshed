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

function fallbackClassify(type) {
  const dispatch = /^sidequest-exec-dispatch-(low|medium|high|xhigh|max)$/.exec(type);
  if (dispatch) return { kind: 'codex_dispatch', effort: dispatch[1] };
  const builtin = /^sidequest-exec-(low|medium|high|xhigh|max)$/.exec(type);
  if (builtin) return { kind: 'claude_builtin', effort: builtin[1] };
  if (/^sidequest-ticket-/.test(type)) return { kind: 'legacy_ticket', effort: null };
  if (/^sidequest-(?:sq-|exec-)/.test(type)) return { kind: 'ticket', effort: null };
  return { kind: 'unknown', effort: null };
}

function classifyExecutor(type) {
  try {
    return require(path.join(pluginRoot(), 'lib', 'exec-names.js')).classify(type);
  } catch (_) {
    return fallbackClassify(type);
  }
}

function isKnownExecutor(classification) {
  return classification.kind !== 'unknown';
}

function main() {
  const data = readStdin();
  if (!data) return;
  const sessionId = data.session_id || data.sessionId || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID;
  const executor = data.agent_type || data.agentType || data.subagent_type;
  const agentId = data.agent_id || data.agentId;
  const agentName = data.agent_name || data.agentName || data.name;
  if (!sessionId || !executor || !agentId || !isKnownExecutor(classifyExecutor(String(executor)))) return;
  const store = require(path.join(pluginRoot(), 'lib', 'store.js'));
  store.bindDispatchAgent(String(sessionId), String(executor), String(agentId), agentName ? String(agentName) : null);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
