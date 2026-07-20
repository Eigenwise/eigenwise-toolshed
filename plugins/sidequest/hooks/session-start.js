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

const MAX_WORKFORCE_BYTES = 1800;
const MAX_WORKFORCE_DESCRIPTION = 90;

function truncateText(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

function workforceSection() {
  try {
    const store = require(path.join(pluginRoot(), 'lib', 'store.js'));
    const start = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const found = store.findProject(store.nearestRepoRoot(start));
    const project = found.ok ? found.slug : '';
    const header = 'YOUR EXECUTORS — delegate work AND investigation to them:';
    const entries = store.getCategories({ project, includeDisabled: false }).map((category) => {
      const route = store.resolveCategoryRoute(category);
      return {
        id: String(category.id || '').trim(),
        route: `(${route.model}·${route.effort})`,
        description: truncateText(category.description, MAX_WORKFORCE_DESCRIPTION),
      };
    });
    const bytesFor = (lines) => Buffer.byteLength([header, ...lines].join('\n'));
    const base = entries.map((entry) => `${entry.id} — ${entry.route}`);
    if (bytesFor(base) > MAX_WORKFORCE_BYTES) return [header, ...base].join('\n');
    const priority = new Set(['codebase-exploration', 'debugging', 'spike-investigation', 'deep-research', 'web-research']);
    const preferred = [...entries.filter((entry) => priority.has(entry.id)), ...entries.filter((entry) => !priority.has(entry.id))];
    const descriptions = new Map();
    for (const entry of preferred) {
      if (!entry.description) continue;
      descriptions.set(entry.id, entry.description);
      const lines = entries.map((candidate) => `${candidate.id} — ${descriptions.get(candidate.id) ? descriptions.get(candidate.id) + ' ' : ''}${candidate.route}`);
      if (bytesFor(lines) > MAX_WORKFORCE_BYTES) descriptions.delete(entry.id);
    }
    return [header, ...entries.map((entry) => `${entry.id} — ${descriptions.get(entry.id) ? descriptions.get(entry.id) + ' ' : ''}${entry.route}`)].join('\n');
  } catch (_) {
    return '';
  }
}

function withWorkforce(context) {
  const section = workforceSection();
  return section ? context + '\n' + section : context;
}

// Returns the parsed stdin payload, or null if stdin was empty/unparseable.
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
    const store = require(path.join(pluginRoot(), 'lib', 'store.js'));
    const sync = require(path.join(pluginRoot(), 'lib', 'agentsync.js'));
    store.sweepStaleClaims({ source: 'session-start' });
    sync.cleanupNativeAgents({ staleBefore: Date.now() - 6 * 60 * 60 * 1000 });
    return sync.syncExecAgents();
  } catch (_) {
    /* best effort — never break the session over agent provisioning */
    return null;
  }
}

function reconcileLostLaunches(data) {
  try {
    const sessionId = data && (data.session_id || data.sessionId || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID);
    const store = require(path.join(pluginRoot(), 'lib', 'store.js'));
    const result = store.reconcileLaunchedDispatches(sessionId, { source: 'session-start' });
    return result && Array.isArray(result.reconciled) ? result.reconciled : [];
  } catch (_) {
    return [];
  }
}

function nudgeOff() {
  const v = String(process.env.SIDEQUEST_NUDGE || '').trim().toLowerCase();
  return v === 'off' || v === '0' || v === 'false' || v === 'no';
}

function emit(context, notice) {
  const output = notice ? context + '\n' + notice : context;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: withWorkforce(output) } })
  );
}

function main() {
  const data = readStdin();
  if (!data) process.exit(0); // empty/malformed input - not a real invocation

  // Keep the runtime Codex exec agents in sync on every real session start. This
  // runs regardless of SIDEQUEST_NUDGE (it's provisioning, not a nudge).
  const syncResult = provisionExecAgents();
  const lostLaunches = reconcileLostLaunches(data);
  const restartNotice = [
    syncResult && syncResult.written > 0 ? require(path.join(pluginRoot(), 'lib', 'agentsync.js')).RESTART_NOTICE : '',
    lostLaunches.length ? `sidequest: ${lostLaunches.join(', ')} launched but never claimed before this reload. Their native task is gone; re-dispatch and spawn them, then pulse to confirm the token claim.` : '',
  ].filter(Boolean).join('\n');

  if (nudgeOff()) process.exit(0);

  const cli = 'node "${CLAUDE_PLUGIN_ROOT}/bin/sidequest.js"';

  // This hook intentionally fires on EVERY SessionStart source (startup, resume,
  // clear, compact) rather than filtering any of them out: standing context does
  // not survive compaction, so it has to re-inject each time the session context
  // gets rebuilt. compact/resume just get a terser re-grounding block below.
  const source = typeof data.source === 'string' ? data.source : '';

  if (source === 'compact' || source === 'resume') {
    emit(
      '=== sidequest (active — context restored) ===\n' +
        'ROLE: ORCHESTRATOR. Reload Sidequest. REQUIRED: Substantive work needs a board ticket; fresh dispatch\'s exact token-gated executor and spawn. Every Agent launch must use that executor. Ticket + dispatch BEFORE multi-file exploration: the second file you open to answer one question is the boundary. Tiny lookup: Read, Glob, Grep, or WebFetch inline; tracing code across files needs a spike ticket. Routed direct:true needs `direct-ok` + a reason; invalid: "the context is already loaded in this session", "it\'s a small patch", "a fresh executor would need context transfer / handoff costs more". Direct never retroactively legitimizes inline investigation. Use mcp__plugin_sidequest_board__list with status=doing FIRST; CLI fallback: `' + cli + ' list --status doing`.\n' +
        'Native results: never TaskOutput. pulse ref / changes --since; TaskStop only after terminal board evidence. ONE diagnose-first retry, never blind respawn. Two failures: comment evidence + surface user. one background timer, never foreground sleep loop.\n' ,
      restartNotice
    );
    process.exit(0);
  }

  emit(
    '=== sidequest (active) ===\n' +
      'ROLE: you are this project\'s ORCHESTRATOR, the most expensive model here. Executors execute/investigate and are cheaper: offload them; read only to write tickets.\n' +
      'Reload the Sidequest skill before acting. Plan multi-part: independently checkable ATOMIC tickets. ' +
      'Atomic = one change, investigation, spike, or review one agent checks. Split for parallelism; keep tightly coupled work together. ' +
      'Specs need exact anchors, contract, bounds/non-goals, dependencies/decisions, and a verify command, or the artifact/answer. several deliverables on one ticket is a smell: use a ticketed planning investigation that pins the shared contract, a wave fanning the pieces out. An external tracker such as Jira still uses Sidequest locally.\n' +
      'Execution economy:\n' +
      '• REQUIRED: Route execution DOWN: substantive investigations and changes are board tickets; fresh `dispatch` returns exact stable executor, spawn, and token. Dispatch is instant: no registration/watcher wait. Every Agent launch uses that executor. Tiny lookup: Read, Glob, Grep, or WebFetch inline. Ticket + dispatch MUST come BEFORE multi-file exploration: the second file you open to answer one question is the boundary, never a ten-read retrospective. Any delegated work, including a quick investigation, is a spike ticket (usually `codebase-exploration`): file it, then route and dispatch. Routed direct:true needs user `direct-ok` + a reason; invalid: "the context is already loaded in this session", "it\'s a small patch", "a fresh executor would need context transfer / handoff costs more". Direct never retroactively legitimizes inline investigation. Native results: never TaskOutput. Liveness: pulse ref / changes --since; TaskStop only after terminal board evidence. Never proxy-wait: no Bash/PowerShell/Monitor/cron executor/report poll or blocking TaskOutput. Denied: pulse + deny, ONE diagnose-first retry only, never blind respawn. Two failures: comment evidence + surface user. Registration: one background timer, never foreground sleep loop. Inline: trivial one-step work; beyond allowance, substantive actions are BLOCKED until a claim. Use `bypassPermissions`; do not use `native_agent`.\n' +
      '• SHORT: category description; ticket description is executor brief; bounce back.\n' +
      '• Batch small SAME-model tickets into ONE executor; parallelize only independent tickets.\n' +
      '• Before each wave, assess shared runtime resources: fixed ports, domains, shared DBs, servers, and files outside declared scope. Serialize tickets that touch the same resource even across worktrees.\n' +
      '• Workers own their ticket and report conflicts, server lifecycle, files changed, blockers, and cleanup.\n' +
      '• File side issues with mcp__plugin_sidequest_board__add, then keep working.\n' +
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
