#!/usr/bin/env node
'use strict';
/**
 * sidequest - SessionStart hook: nudge routing-through-the-board at chat start
 *
 * A fresh chat has no memory of the board, so it's easy to just start typing
 * code instead of planning as tickets. This hook fires once when a session
 * begins and drops a short standing reminder in front of Claude: unless the
 * request is trivial, plan it as sidequest tickets (category-routed from the
 * live taxonomy) and route execution proportionally. It is a nudge, not a gate — Claude
 * is free to ignore it for small asks.
 *
 * Token diet (2026-07): this block is the ONE place the execution doctrine gets
 * injected (the per-prompt hook only emits a one-liner), so it carries the
 * delegation rules — but tightly. The economy is expensive-orchestrator /
 * cheap-executors: real execution routes DOWN to each ticket's stamped model
 * (inline only a trivial one-step change), and the cost control is the SHAPE of
 * the runs, not pulling work onto the pricey main thread — short bounded
 * executor runs that bounce back fast, batching small same-model tickets into
 * one spawn, --brief board reads. hooks.test.js enforces a byte budget on this
 * block — don't grow it back.
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

// Keep generated executor files aligned with the current category routes. Errors
// remain fail-soft because provisioning never blocks a session.
function provisionExecAgents() {
  try {
    const sync = require(path.join(pluginRoot(), 'lib', 'agentsync.js'));
    sync.cleanupNativeAgents({ staleBefore: Date.now() - 6 * 60 * 60 * 1000 });
    return sync.syncExecAgents();
  } catch (_) {
    /* best effort — never break the session over agent provisioning */
    return null;
  }
}

// Turned off with SIDEQUEST_NUDGE=off for anyone who finds this too chatty.
function nudgeOff() {
  const v = String(process.env.SIDEQUEST_NUDGE || '').trim().toLowerCase();
  return v === 'off' || v === '0' || v === 'false' || v === 'no';
}

function emit(context, notice) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: notice ? context + '\n' + notice : context } })
  );
}

function main() {
  const data = readStdin();
  if (!data) process.exit(0); // empty/malformed input - not a real invocation

  // Keep the runtime Codex exec agents in sync on every real session start. This
  // runs regardless of SIDEQUEST_NUDGE (it's provisioning, not a nudge).
  const syncResult = provisionExecAgents();
  const restartNotice = syncResult && syncResult.written > 0
    ? require(path.join(pluginRoot(), 'lib', 'agentsync.js')).RESTART_NOTICE
    : '';

  if (nudgeOff()) process.exit(0);

  const cli = `node "${path.join(pluginRoot(), 'bin', 'sidequest.js')}"`;

  // This hook intentionally fires on EVERY SessionStart source (startup, resume,
  // clear, compact) rather than filtering any of them out: standing context does
  // not survive compaction, so it has to re-inject each time the session context
  // gets rebuilt. compact/resume just get a terser re-grounding block below.
  const source = typeof data.source === 'string' ? data.source : '';

  if (source === 'compact' || source === 'resume') {
    emit(
      '=== sidequest (active — context restored) ===\n' +
        'Context was just compacted/resumed — RE-CHECK in-flight claims: `' + cli + ' list --status doing`.\n' +
        'Discipline: taxonomy, stamp, render executor, wait for `New agent types are now available: <name>`, spawn `exec.agent`, claim its token. `reason:token` means premature generic: TaskStop, wait, respawn. If no announcement, stable executor. Verify `transcript/meta.json` + token claim, never self-report. Codex omits model; Claude passes it.\n' ,
      restartNotice
    );
    process.exit(0);
  }

  emit(
    '=== sidequest (active) ===\n' +
      'This project tracks work on the sidequest board — plan multi-part requests as independently checkable ATOMIC ' +
      'tickets (stamp a live-taxonomy category; complexity + why are legacy fallback). ' +
      'Atomic = one piece a single agent finishes and checks: a change, or an investigation, spike, or review. ' +
      'Split for parallelism: independent tickets fan out; keep tightly coupled work together. ' +
      'One ticket owning several deliverables (CLI + wiring + tests) is a smell: use a cheap scout that pins the shared contract, then a wave fanning the pieces out. ' +
      'The spec carries exact anchors, contract or question, bounds/non-goals, dependencies/decisions, and a verify command, or the artifact/answer. Even with an external tracker (Jira), use sidequest as the local execution layer.\n' +
      'Execution economy — expensive orchestrator, cheap executors, tight loop:\n' +
      '• Route execution DOWN: stamp, render the per-ticket definition, wait for `New agent types are now available: <name>`, then spawn the already-registered `exec.agent`; pass its token and `model: exec.model` (Codex omits model). `reason:token`: TaskStop, wait, respawn; no announcement: stable executor. Verify `transcript/meta.json` + token claim, never self-report. Use `bypassPermissions`; Do not use `native_agent`. Inline only trivial one-step.\n' +
      '• Keep runs SHORT and bounded; the ticket is the spec; bounce back fast and verify artifacts.\n' +
      '• Batch small SAME-model tickets into ONE executor; parallelize only independent tickets.\n' +
      '• Before each wave, assess shared runtime resources: fixed ports, domains, shared DBs, servers, and files outside declared scope. Serialize tickets that touch the same resource even across worktrees.\n' +
      '• Workers own their ticket and report conflicts, server lifecycle, files changed, blockers, and cleanup.\n' +
      'Capture side issues as tickets (background `ticket-filer`) without derailing the current task.\n' +
      'Board actions go through the mcp__plugin_sidequest_board__* MCP tools whenever available — reach for them FIRST; Bash+CLI is the fallback. Open the board: `' +
      cli + ' dashboard`.',
    restartNotice
  );
  process.exit(0);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
