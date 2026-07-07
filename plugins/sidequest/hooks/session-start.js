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

  // This hook intentionally fires on EVERY SessionStart source (startup, resume,
  // clear, compact) rather than filtering any of them out: standing context does
  // not survive compaction, so it has to re-inject each time the session context
  // gets rebuilt. compact/resume just get a terser re-grounding block below
  // instead of the full nudge, since the fuller guidance already ran once this
  // session and the per-prompt reminder will fire again on the very next prompt.
  const source = typeof data.source === 'string' ? data.source : '';

  if (source === 'compact' || source === 'resume') {
    emit(
      '=== sidequest (active — context restored) ===\n' +
        'sidequest is still active for this project — context was just compacted/resumed, so ' +
        'RE-CHECK in-flight claims: `' + cli + ' list --status doing`.\n' +
        'The discipline still applies: plan as tickets, run tasks as subagent workflows (teams of ' +
        'sub-agents) (~95% of real work), fan out independent work.\n' +
        'The full per-prompt reminder returns on your next prompt.\n'
    );
    process.exit(0);
  }

  emit(
    '=== sidequest (active) ===\n' +
      'This project tracks work in sidequest — use the board, do not keep the plan only in your head.\n' +
      'Even if this repo uses an external tracker (Jira/Linear/GitHub Issues), that tracks the deliverable — ' +
      'sidequest is still your LOCAL execution layer here (decompose, fan out, run subagents). Use it anyway; ' +
      'don\'t skip it because the work is "already tracked". See the sidequest skill for why/how they coexist.\n' +
      'Unless this request is trivial, plan it as tickets on the board (complexity-scored per the sidequest ' +
      'skill) before implementing, then route execution as subagent workflows — teams of sub-agents, not ' +
      'the main thread: each ticket is scored and routed to the best model×effort, so spawn a routed ' +
      'subagent (claim → do → done) instead of running it inline. ~95% of real work should run in a routed ' +
      'subagent; the main thread orchestrates the team.\n' +
      'FAN OUT: about to read ~4+ files or grep a subsystem to understand it? Spawn a parallel ' +
      'Explore / code-explorer scout FIRST. Run independent ready tickets as parallel executors (claim ' +
      'first, distinct `--by`); keep dependent/same-file work serial.\n' +
      'Board: `' + cli + ' dashboard`.'
  );
  process.exit(0);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
