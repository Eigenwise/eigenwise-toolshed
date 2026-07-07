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

let lib;
try {
  lib = require('./lib/rules');
} catch (_) {
  process.exit(0);
}

function main() {
  // Deliberately does not filter on data.source (startup | resume | clear |
  // compact): always-on rules must re-inject after compaction too, or the
  // README's promise that they survive compaction would silently break.
  const data = lib.readStdin();
  const projectDir = lib.getProjectDir(data);

  const rules = lib.loadRules(projectDir);
  if (!rules.length) process.exit(0);

  const selected = lib.attachIncludes(lib.selectAlways(rules), projectDir);
  if (!selected.length) process.exit(0);

  const header =
    '=== LIVE RULES (live-rules, session start) ===\n' +
    'Always-on project rules, injected once here so they reach you even if the per-prompt hook ' +
    "is not wired this session. They repeat on every prompt from here on; if this block doesn't " +
    'come back on your very next prompt, the UserPromptSubmit hook is not registered (a common ' +
    'cause: live-rules was enabled or updated mid-session and needs a restart to pick up). ' +
    'Source: ' + lib.displayPath(projectDir, lib.getRulesFile(projectDir));

  lib.emit('SessionStart', lib.renderRules(selected, header));
  process.exit(0);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
