#!/usr/bin/env node
'use strict';
/**
 * sidequest - SubagentStop hook: flag a runaway (likely non-atomic) executor run
 *
 * Sidequest can't STOP a running subagent, but when one ends it can turn a long
 * run into a visible post-hoc signal. A GenO-revisited executor once ran 28+ min
 * on a single non-atomic ticket, invisibly — the orchestrator only learned it was
 * oversized after the fact, if at all. This hook fires on SubagentStop, looks up
 * any sidequest claim attributed to the ending session, and if the claim's OWN
 * start timestamp is older than a threshold (default 15 min, SIDEQUEST_LONG_RUN_MIN)
 * it emits ONE short line back to the parent naming the ticket + elapsed and asking
 * whether it was really atomic.
 *
 * Attribution is shared-session, and every child of a session shares the parent's
 * session id, so three stdin-driven guards keep this from nagging the wrong child
 * (the Contractify loop: a reviewer scoped to one file got re-woken ~6x by an
 * unrelated executor's SQ-70 note):
 *   - stop_hook_active -> exit. This fire is our OWN additionalContext continuation;
 *     driving it again is the loop. Bail before doing anything.
 *   - agent_type not a `sidequest-` executor -> exit. Only an executor/native child
 *     ever held the claim; a reviewer/explorer/teammate shares the id, not the run.
 *   - already flagged this exact claim -> exit. store.markLongRunFlagged surfaces a
 *     given long run ONCE; a repeat SubagentStop won't re-inject it.
 *
 * The elapsed is computed from the claim `at` the store already records (the worker
 * registry ties a claim to its session) — NOT from the SubagentStop stdin, which
 * carries no token counts or duration. Under threshold, no attributable claim, or
 * any error -> silent, exit 0.
 *
 * Design constraints (shared with the rest of the toolshed):
 *   - Node stdlib only, cross-platform.
 *   - Fail-soft: any error -> exit 0 with no output. It must never break teardown.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

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

// Minutes over which a single claimed run is worth flagging. Env-overridable;
// a missing/garbage/non-positive value falls back to the effort-scaled default.
function thresholdMs(effort) {
  const raw = process.env.SIDEQUEST_LONG_RUN_MIN;
  const n = raw != null && String(raw).trim() !== '' ? Number(raw) : NaN;
  const min = Number.isFinite(n) && n > 0
    ? n
    : ({ low: 10, medium: 15, high: 25, xhigh: 40 }[String(effort || '').trim().toLowerCase()] || 15);
  return min * 60 * 1000;
}

function emit(context) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStop', additionalContext: context } })
  );
}

function doneComment(ticket, by) {
  const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
  return comments.slice().reverse().find((comment) =>
    comment && comment.kind === 'comment' &&
    (!by || comment.by === by) &&
    /\b(done|shipped|commit)\b/i.test(String(comment.body || ''))
  ) || null;
}

function commitHash(comment) {
  const match = comment && String(comment.body || '').match(/\b[0-9a-f]{7,40}\b/i);
  return match ? match[0] : null;
}

function stopVerdict(store, claims, classification) {
  const now = Date.now();
  for (const claim of claims) {
    if (!claim || claim.status !== 'done') continue;
    const ticket = store.getTicket(claim.slug, claim.ticketId);
    const comment = ticket && doneComment(ticket, claim.by);
    if (!ticket || !comment) continue;
    const hash = commitHash(comment);
    const suffix = Array.isArray(ticket.files) && ticket.files.length && !hash
      ? ' done WITHOUT commit hash'
      : ` done${hash ? ` (${hash})` : ''}`;
    return `exec stopped clean: ${ticket.ref}${suffix}; verify, then TaskStop this executor so it doesn't linger idle`;
  }

  // A submitted run ended exactly right: verified commit parked, claim released,
  // no publish. Point the orchestrator at the publish transaction, not a respawn.
  for (const claim of claims) {
    if (!claim || claim.held) continue;
    let ticket = null;
    try {
      ticket = store.getTicket(claim.slug, claim.ticketId);
    } catch (_) {
      continue;
    }
    const sub = ticket && ticket.submission;
    if (!sub || !sub.commit || sub.integratedAt) continue;
    return `exec stopped clean: ${ticket.ref} READY_FOR_INTEGRATION (${sub.commit.slice(0, 12)}); run the publish transaction (references/publishing.md), then TaskStop this executor`;
  }

  const held = claims.find((claim) => claim && claim.held && claim.status === 'doing');
  if (held) {
    const started = Date.parse(held.at);
    const mins = Number.isFinite(started) ? Math.max(1, Math.round((now - started) / 60000)) : 0;
    const label = held.ref || held.ticketId || 'a ticket';
    return `exec stopped HOLDING ${label} claim (age ${mins}m), likely dead: release + respawn, then TaskStop it`;
  }

  if (isKnownExecutor(classification)) return 'exec stopped without ever claiming, TaskStop it first, then redispatch and spawn the returned spec';
  return null;
}

function clearNearTurnCapCounter(agentId) {
  if (!agentId) return;
  const counter = path.join(os.tmpdir(), 'sidequest-near-turn-cap', encodeURIComponent(agentId));
  try {
    fs.unlinkSync(counter);
  } catch (_) {
    // A missing counter is expected for runs that never reached PreToolUse.
  }
}

function main() {
  const data = readStdin();
  if (!data) process.exit(0);
  const agentId = String(data.agent_id || data.agentId || '');
  const agentName = String(data.agent_name || data.agentName || data.name || '');
  clearNearTurnCapCounter(agentId);

  // Our own additionalContext re-fires SubagentStop with this set. Never drive our
  // continuation — that recursion is the nag loop. Bail before touching the store.
  if (data.stop_hook_active) process.exit(0);

  // The runaway note is about an EXECUTOR's claim. A non-executor child (reviewer,
  // explorer, plain teammate) shares the parent session id but never held it, so
  // attributing a session claim to it is noise. An absent type stays permissive so
  // older Claude Code payloads (session id only) behave as before.
  const agentType = String(data.agent_type || data.agentType || '');
  const classification = classifyExecutor(agentType);
  if (agentType && !isKnownExecutor(classification)) process.exit(0);

  const sessionId = data.session_id || data.sessionId || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
  if (!sessionId) process.exit(0); // nothing to attribute a claim to

  let store;
  try {
    store = require(path.join(pluginRoot(), 'lib', 'store.js'));
  } catch (_) {
    process.exit(0); // can't load the store -> nothing to check
  }

  try {
    store.markDispatchStopped(String(sessionId), agentType, agentId || null, agentName || null);
  } catch (_) {
    // The stop verdict below still tells the parent what to do.
  }

  let claims;
  try {
    claims = store.sessionClaims(String(sessionId), {
      agentId: agentId || null,
      agentName: agentName || null,
      executor: agentType || null,
    });
  } catch (_) {
    process.exit(0);
  }
  if (!Array.isArray(claims)) process.exit(0);

  let verdict;
  try {
    verdict = stopVerdict(store, claims, classification);
  } catch (_) {
    process.exit(0);
  }
  if (verdict) {
    emit(verdict);
    process.exit(0);
  }
  if (!claims.length) process.exit(0);

  const now = Date.now();
  let worst = null; // the longest-running over-threshold claim
  for (const c of claims) {
    if (!c || !c.held || c.status === 'done') continue;
    const started = c.at ? Date.parse(c.at) : NaN;
    if (!Number.isFinite(started)) continue;
    let ticket = null;
    if (!c.effort) {
      try {
        ticket = store.getTicket(c.slug, c.ticketId);
      } catch (_) {
        // A missing ticket leaves the default threshold in place.
      }
    }
    const cutoff = thresholdMs(c.effort || (ticket && ticket.effort));
    const elapsed = now - started;
    if (elapsed <= cutoff) continue;
    if (!worst || elapsed > worst.elapsed) worst = { elapsed, cutoff, ref: c.ref, ticketId: c.ticketId, slug: c.slug, at: c.at };
  }
  if (!worst) process.exit(0); // every claim is within budget

  // Surface this exact long run at most once for the session. A repeat SubagentStop
  // (another child ending, or a resume replaying the same registry) stays silent.
  if (!store.markLongRunFlagged(String(sessionId), worst.slug, worst.ticketId, worst.at)) {
    process.exit(0);
  }

  const mins = Math.max(1, Math.round(worst.elapsed / 60000));
  const label = worst.ref || worst.ticketId || 'a claimed ticket';
  const budgetMin = Math.round(worst.cutoff / 60000);
  emit(
    `⚠️ sidequest: the executor for ${label} held its claim ~${mins}m (over the ${budgetMin}m long-run mark). ` +
      `Was that ticket really atomic, or should it have been split? Check its diff/report before trusting the result.`
  );
  process.exit(0);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
