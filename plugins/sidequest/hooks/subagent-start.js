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

function main() {
  const data = readStdin();
  if (!data) return;
  const sessionId = data.session_id || data.sessionId || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID;
  const executor = data.agent_type || data.agentType || data.subagent_type;
  const agentId = data.agent_id || data.agentId;
  const agentName = data.agent_name || data.agentName || data.name;
  if (!sessionId || !executor || !agentId || !String(executor).startsWith('sidequest-')) return;
  const store = require(path.join(pluginRoot(), 'lib', 'store.js'));
  store.bindDispatchAgent(String(sessionId), String(executor), String(agentId), agentName ? String(agentName) : null);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
