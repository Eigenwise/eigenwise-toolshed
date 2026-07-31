#!/usr/bin/env node
/**
 * live-rules - SessionStart hook
 *
 * Injects the project's always-on rules once, at session start, as a fallback
 * delivery path alongside the UserPromptSubmit hook.
 *
 * Why this exists: Claude Code snapshots a session's hook registrations at
 * session start. If live-rules is installed or updated mid-session, the new
 * UserPromptSubmit wiring does not take effect until the session restarts, but
 * nothing tells you that: the hook just never fires, silently, for the rest of
 * the session. This hook cannot fix that same-session gap (it also only fires
 * at session start), but it does two useful things for every session going
 * forward:
 *   - guarantees always-on rules reach the model at least once, even if
 *     UserPromptSubmit's wiring is somehow stale or broken that session, and
 *   - gives a concrete, checkable signal: if this block does not reappear on
 *     your very next prompt, the per-prompt hook is not wired. See the README
 *     "Restart after enabling or updating" section.
 *
 * Design constraints (shared with the rest of live-rules):
 *   - No external dependencies (Node stdlib only).
 *   - Cross-platform (Windows / macOS / Linux).
 *   - Silent when there is no live-rules file, or no always-on rule in it.
 *   - Never breaks a session: any error -> exit 0 with no output.
 */

'use strict';

const path = require('path');

let lib;
let ledger;
try {
  lib = require('./lib/rules');
  ledger = require('./lib/session-ledger');
} catch (_) {
  process.exit(0);
}

function main() {
  // Deliberately does not filter on data.source (startup | resume | clear |
  // compact): always-on rules must re-inject after compaction too, or the
  // README's promise that they survive compaction would silently break.
  const data = lib.readStdin();
  const projectDir = lib.getProjectDir(data);
  const migration = lib.migrateLegacyRules(projectDir, { detailed: true });
  if (lib.atomicSchema(projectDir) === 'future') {
    lib.emit('SessionStart', 'Live Rules uses a newer schema. Preserve its files and update the plugin before changing its metadata.');
    process.exit(0);
  }

  const ruleSet = lib.loadRuleSet(projectDir);
  if (!ruleSet.rules.length) {
    if (migration.notice) lib.emit('SessionStart', migration.notice);
    process.exit(0);
  }

  const cwd = (data && typeof data.cwd === 'string' && data.cwd) || projectDir;
  const cwdRel = path.relative(projectDir, cwd).replace(/\\/g, '/');
  const selected = lib.attachIncludes(lib.selectForPrompt(ruleSet.rules, { promptText: '', cwdRel }), projectDir);
  const changed = ledger.changed(projectDir, data.session_id, selected, true);
  if (!changed.length) {
    if (migration.notice) lib.emit('SessionStart', migration.notice);
    process.exit(0);
  }

  const header =
    (migration.notice ? migration.notice + '\n\n' : '') +
    '=== LIVE RULES (live-rules, session start) ===\n' +
    'Rules re-grounded after SessionStart (' + (data.source || 'startup') + '). ' +
    lib.formatRuleSetStatus(ruleSet) +
    'Source: ' + lib.displayPath(projectDir, ruleSet.source);

  lib.emit('SessionStart', lib.renderRules(changed, header));
  process.exit(0);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
