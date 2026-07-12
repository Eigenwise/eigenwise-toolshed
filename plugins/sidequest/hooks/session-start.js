#!/usr/bin/env node
'use strict';
/**
 * sidequest - SessionStart hook: nudge routing-through-the-board at chat start
 *
 * A fresh chat has no memory of the board, so it's easy to just start typing
 * code instead of planning as tickets. This hook fires once when a session
 * begins and drops a short standing reminder in front of Claude: unless the
 * request is trivial, plan it as sidequest tickets (complexity-scored per the
 * skill) and route execution proportionally. It is a nudge, not a gate — Claude
 * is free to ignore it for small asks.
 *
 * Token diet (2026-07): this block is the ONE place the execution doctrine gets
 * injected (the per-prompt hook only emits a one-liner), so it carries the
 * delegation rules — but tightly. The economy is expensive-orchestrator /
 * cheap-executors: real execution routes DOWN to each ticket's stamped tier
 * (inline only a trivial one-step change), and the cost control is the SHAPE of
 * the runs, not pulling work onto the pricey main thread — short bounded
 * executor runs that bounce back fast, batching small same-tier tickets into
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

// Auto-provision the runtime Codex exec agents (sidequest-exec-<slug>-<effort>.md)
// so a ladder tier pointed at a discovered Codex model spawns without any manual
// `models sync-agents` step. syncExecAgents writes one file per discovered model x
// non-max effort into the live ~/.claude/agents dir; because those files are
// persistent, once a model has been discovered in any prior session its agents are
// already registered and mapping a tier to it needs no restart. Fail-soft and
// silent: any error (no catalog, unwritable dir, partial install) is swallowed so
// a sync problem can NEVER break session start. Empty catalog -> no-op.
function provisionExecAgents() {
  try {
    const sync = require(path.join(pluginRoot(), 'lib', 'agentsync.js'));
    sync.cleanupNativeAgents({ staleBefore: Date.now() - 6 * 60 * 60 * 1000 });
    sync.syncExecAgents();
  } catch (_) {
    /* best effort — never break the session over agent provisioning */
  }
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

  // Keep the runtime Codex exec agents in sync on every real session start. This
  // runs regardless of SIDEQUEST_NUDGE (it's provisioning, not a nudge).
  provisionExecAgents();

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
        'Discipline: plan multi-part work as tickets; route execution to the ticket\'s already-registered `exec.agent` as short, bounded executor runs — batch small same-tier tickets; inline only trivial one-steps.'
    );
    process.exit(0);
  }

  emit(
    '=== sidequest (active) ===\n' +
      'This project tracks work on the sidequest board — plan any multi-part request as small ATOMIC ' +
      'tickets BEFORE implementing (each needs --complexity 1-10 + --why; model×effort routing is ' +
      'derived from the score). Atomic = one concrete change the executor can finish without ' +
      'discovering anything; the spec carries the context. Even if the repo uses an external tracker ' +
      '(Jira/Linear/GitHub Issues), that owns the deliverable — sidequest is the local execution layer; ' +
      'use both.\n' +
      'Execution economy — expensive orchestrator, cheap executors, tight loop:\n' +
      '• Route real execution DOWN: pass the ticket\'s `exec.agent` to Agent as `subagent_type`, with a unique name + `bypassPermissions`. It is already-registered. Do not use `native_agent` for ticket execution. This thread orchestrates; inline only trivial one-steps.\n' +
      '• Keep executor runs SHORT and bounded — the ticket is the spec (exact anchors + verify command); ' +
      'scope the spawn prompt; executors bounce back fast (release + report) instead of wandering. Many ' +
      'short orchestrator↔executor round-trips beat one long autonomous run. Verify reports by artifact ' +
      '(test output/diff), not by claim.\n' +
      '• Batch several small SAME-tier tickets into ONE executor (sequential inside); independent tickets ' +
      'big enough for a spawn each run as a PARALLEL wave (`ready --json --brief`, one executor per ' +
      'ticket, one message).\n' +
      'Capture side issues the user mentions as tickets (background `ticket-filer`) without derailing ' +
      'the current task.\n' +
      'Board actions (add/list/ready/claim/done/comment/...) go through the ' +
      'mcp__plugin_sidequest_board__* MCP tools whenever they are in your toolset — reach for them ' +
      'FIRST; Bash+CLI is the fallback and the only route to dashboard/serve/work. Open the board: `' +
      cli + ' dashboard`.'
  );
  process.exit(0);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
