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
 * The elapsed is computed from the claim `at` the store already records (the worker
 * registry ties a claim to its session) — NOT from the SubagentStop stdin, which we
 * treat as possibly bare (no token counts, no duration). Under threshold, no
 * attributable claim, or any error -> silent, exit 0.
 *
 * Design constraints (shared with the rest of the toolshed):
 *   - Node stdlib only, cross-platform.
 *   - Fail-soft: any error -> exit 0 with no output. It must never break teardown.
 */

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

// Minutes over which a single claimed run is worth flagging. Env-overridable;
// a missing/garbage/non-positive value falls back to the 15-minute default.
function thresholdMs() {
  const raw = process.env.SIDEQUEST_LONG_RUN_MIN;
  const n = raw != null && String(raw).trim() !== '' ? Number(raw) : NaN;
  const min = Number.isFinite(n) && n > 0 ? n : 15;
  return min * 60 * 1000;
}

function emit(context) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStop', additionalContext: context } })
  );
}

function main() {
  const data = readStdin();
  if (!data) process.exit(0);
  const sessionId = data.session_id || data.sessionId || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '';
  if (!sessionId) process.exit(0); // nothing to attribute a claim to

  let store;
  try {
    store = require(path.join(pluginRoot(), 'lib', 'store.js'));
  } catch (_) {
    process.exit(0); // can't load the store -> nothing to check
  }

  let claims;
  try {
    claims = store.sessionClaims(String(sessionId));
  } catch (_) {
    process.exit(0);
  }
  if (!Array.isArray(claims) || !claims.length) process.exit(0);

  const cutoff = thresholdMs();
  const now = Date.now();
  let worst = null; // the longest-running over-threshold claim
  for (const c of claims) {
    const started = c && c.at ? Date.parse(c.at) : NaN;
    if (!Number.isFinite(started)) continue;
    const elapsed = now - started;
    if (elapsed <= cutoff) continue;
    if (!worst || elapsed > worst.elapsed) worst = { elapsed, ref: c.ref, ticketId: c.ticketId };
  }
  if (!worst) process.exit(0); // every claim is within budget

  const mins = Math.max(1, Math.round(worst.elapsed / 60000));
  const label = worst.ref || worst.ticketId || 'a claimed ticket';
  const budgetMin = Math.round(cutoff / 60000);
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
