#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

function terminalDispatchTarget(agentName) {
  try {
    const root = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
    return require(path.join(root, 'lib', 'store.js')).terminalDispatchTarget(agentName);
  } catch (_) {
    return null;
  }
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
}

function main() {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw) return;
  const input = JSON.parse(raw);
  // Executors may message peers now (subagents can do anything), but the
  // terminal-target check binds every caller: a queued message must never
  // wake a finished executor.
  if (!input || typeof input !== 'object') return;
  if (String(input.tool_name || '') !== 'SendMessage') return;

  const toRaw = input.tool_input && input.tool_input.to;
  const to = String(toRaw == null ? '' : toRaw).trim();
  const terminal = terminalDispatchTarget(to);
  if (terminal) {
    deny(
      `sidequest: ${terminal.ref} is terminal (${terminal.outcome}) and executor "${to}" is closed. ` +
      'Drop this queued steering message so it cannot wake a finished executor. Redispatch the ticket for later work; TaskStop the mapped executor if it is still listed.'
    );
  }
}

try {
  main();
} catch (_) {
  // Fail soft. A hook bug must never block unrelated SendMessage calls.
  process.exit(0);
}
