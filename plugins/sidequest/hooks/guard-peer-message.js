#!/usr/bin/env node
'use strict';
/**
 * sidequest - PreToolUse hook: keep executors reporting UP, not sideways.
 *
 * A sidequest executor's only channels are its final message (to whoever spawned
 * it) and comments on its OWN ticket. When an executor instead SendMessage's a
 * peer, that peer gets a nudge it never asked for — and if the peer re-nudges
 * back, or a SubagentStop re-injects the same context, you get the Contractify
 * loop: a reviewer scoped to one file re-woken ~6x by an unrelated executor's
 * SQ-70 message. This hook denies that at the tool boundary.
 *
 * A terminal dispatch is a hard lifecycle boundary too. The board keeps the mapped
 * executor name after completion so this hook can deny a delayed main-thread or
 * peer message before Claude Code delivers it and wakes a finished worker. Later
 * work must use a fresh dispatch, which gets a fresh briefing and route marker.
 *
 * PreToolUse stdin carries `agent_type` ONLY when the caller is a subagent (it's
 * absent on main-thread calls — docs: agent-sdk/hooks). The terminal-target check
 * applies to every caller. Otherwise only `sidequest-` executors are denied when
 * messaging a target other than `main`.
 *
 * Fail-soft by construction: a missing/garbage payload, an unknown target, or a
 * failed store lookup yields NO output (allow).
 *
 * Design constraints (shared with the rest of the toolshed):
 *   - Node stdlib only, cross-platform.
 *   - Fail-soft: any error -> exit 0 with no output.
 */

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
  if (!input || typeof input !== 'object') return;
  if (String(input.tool_name || '') !== 'SendMessage') return;

  const agentType = String(input.agent_type || input.agentType || '');

  const toRaw = input.tool_input && input.tool_input.to;
  const to = String(toRaw == null ? '' : toRaw).trim();
  const terminal = terminalDispatchTarget(to);
  if (terminal) {
    deny(
      `sidequest: ${terminal.ref} is terminal (${terminal.outcome}) and executor "${to}" is closed. ` +
      'Drop this queued steering message so it cannot wake a finished executor. Redispatch the ticket for later work; TaskStop the mapped executor if it is still listed.'
    );
    return;
  }
  if (!agentType.startsWith('sidequest-')) return; // main thread / non-executor -> allow
  if (to.toLowerCase() === 'main') return; // reporting up to the main conversation is allowed

  deny(
    `sidequest: an executor (${agentType}) may not message another agent` +
    (to ? ` ("${to}")` : '') +
    '. Executors report UP — put it in your final message to the orchestrator, or a comment on your own ticket, and let the orchestrator route anything another ticket\'s owner needs. Do not nudge peers.'
  );
}

try {
  main();
} catch (_) {
  // Fail soft. A hook bug must never block unrelated SendMessage calls.
  process.exit(0);
}
