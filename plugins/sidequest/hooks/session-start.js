#!/usr/bin/env node
'use strict';
/**
 * sidequest - SessionStart hook: nudge routing-through-the-board at chat start
 *
 * A fresh chat has no memory of the board, so it's easy to just start typing
 * code instead of planning as tickets. This hook fires once when a session
 * begins and drops a short standing reminder in front of Claude: unless the
 * request is trivial, plan it as sidequest tickets (complexity-scored per the
 * skill) and route execution through executor subagents, rather than working
 * ad hoc. It is a nudge, not a gate — Claude is free to ignore it for small asks.
 *
 * Design constraints (shared with the rest of the toolshed):
 *   - Node stdlib only, cross-platform.
 *   - Fail-soft: any error -> exit 0 with no output. It must never break a session.
 */

const path = require('path');

// Returns the parsed stdin payload, or null if stdin was empty/unparseable.
// Unlike capture-nudge.js (which only reads one field and can shrug off a
// parse failure), this hook has no per-field logic to fall back on, so an
// unreadable payload is treated as "not a real hook invocation" and stays
// silent rather than firing on every malformed call.
function readStdin() {
  try {
    const fs = require('fs');
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
}

// Turned off with SIDEQUEST_NUDGE=off for anyone who finds this too chatty.
function nudgeOff() {
  const v = String(process.env.SIDEQUEST_NUDGE || '').trim().toLowerCase();
  return v === 'off' || v === '0' || v === 'false' || v === 'no';
}

function emit(context) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } })
  );
}

function main() {
  const data = readStdin();
  if (!data) process.exit(0); // empty/malformed input - not a real invocation
  if (nudgeOff()) process.exit(0);

  const cli = `node "${path.join(pluginRoot(), 'bin', 'sidequest.js')}"`;

  emit(
    '=== sidequest (active) ===\n' +
      'This project tracks work in sidequest — use the board, do not keep the plan only in your head.\n' +
      'Unless this request is trivial, plan it as tickets on the board (complexity-scored per the sidequest ' +
      'skill) before implementing, then route execution through executor subagents (claim → do → done) ' +
      'rather than working ad hoc.\n' +
      'Board: `' + cli + ' dashboard`.'
  );
  process.exit(0);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
