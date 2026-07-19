'use strict';

// The single source of truth for Sidequest executor agent names. Store and
// generator build names through these helpers instead of hand-written strings, so
// the naming contract lives in exactly one place. Dependency-free by design.

const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

const CLAUDE_PREFIX = 'sidequest-exec-';
const DISPATCH_PREFIX = 'sidequest-exec-dispatch-';
const TICKET_PREFIX = 'sidequest-sq-';

function isEffort(value) {
  return typeof value === 'string' && EFFORTS.includes(value);
}

// Stable Claude built-in executor, e.g. sidequest-exec-high.
function stableClaudeName(effort) {
  return `${CLAUDE_PREFIX}${effort}`;
}

// Stable Codex dispatch executor pinned to the virtual claude-codex-auto model,
// e.g. sidequest-exec-dispatch-high.
function stableDispatchName(effort) {
  return `${DISPATCH_PREFIX}${effort}`;
}

// Classify any agent name into a known kind. Kinds:
//   'codex_dispatch' — a stable dispatch executor (carries effort)
//   'claude_builtin' — a stable Claude executor (carries effort)
//   'ticket'         — a per-ticket dispatch/temp name Sidequest tolerates on claims
//   'unknown'        — anything else (fail-soft; never throws)
function classify(name) {
  if (typeof name !== 'string' || !name) return { kind: 'unknown', effort: null };

  // Dispatch prefix is a superset of the Claude prefix, so test it first.
  if (name.startsWith(DISPATCH_PREFIX)) {
    const effort = name.slice(DISPATCH_PREFIX.length);
    if (isEffort(effort)) return { kind: 'codex_dispatch', effort };
    return { kind: 'ticket', effort: null };
  }
  if (name.startsWith(CLAUDE_PREFIX)) {
    const rest = name.slice(CLAUDE_PREFIX.length);
    if (isEffort(rest)) return { kind: 'claude_builtin', effort: rest };
    // e.g. an ephemeral per-ticket executor definition name.
    return { kind: 'ticket', effort: null };
  }
  if (name.startsWith(TICKET_PREFIX)) return { kind: 'ticket', effort: null };
  return { kind: 'unknown', effort: null };
}

module.exports = {
  CLAUDE_PREFIX,
  DISPATCH_PREFIX,
  EFFORTS,
  TICKET_PREFIX,
  classify,
  isEffort,
  stableClaudeName,
  stableDispatchName,
};
