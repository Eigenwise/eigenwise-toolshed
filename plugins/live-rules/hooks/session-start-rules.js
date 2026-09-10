#!/usr/bin/env node
/**
 * live-rules - SessionStart and SubagentStart hook
 *
 * Injects the project's always-on rules once, at session start, as a fallback
 * delivery path alongside the UserPromptSubmit hook. The same script runs at
 * SubagentStart because native subagents (Explore, general-purpose, custom
 * agents) never submit a prompt, so UserPromptSubmit cannot reach them. Each
 * subagent keeps its own ledger under the parent session so it is grounded
 * once and the parent's ledger is left alone.
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
let projectRelative;
let ledger;
try {
  lib = require('./lib/rules');
  ledger = require('./lib/session-ledger');
  ({ projectRelative } = require('./lib/canonical-path'));
} catch (_) {
  process.exit(0);
}

function subagentLedgerKey(data) {
  const agentId = data.agent_id || data.agentId;
  return data.session_id && agentId ? data.session_id + '/agent/' + agentId : null;
}

function main() {
  // Deliberately does not filter on data.source (startup | resume | clear |
  // compact): always-on rules must re-inject after compaction too, or the
  // README's promise that they survive compaction would silently break.
  const data = lib.readStdin();
  const eventName = data.hook_event_name === 'SubagentStart' ? 'SubagentStart' : 'SessionStart';
  const projectDir = lib.getProjectDir(data);
  const migration = lib.migrateLegacyRules(projectDir, { detailed: true });
  if (lib.atomicSchema(projectDir) === 'future') {
    lib.emit(eventName, 'Live Rules uses a newer schema. Preserve its files and update the plugin before changing its metadata.');
    process.exit(0);
  }

  const ruleSet = lib.loadRuleSet(projectDir);
  if (!ruleSet.rules.length) {
    if (migration.notice) lib.emit(eventName, migration.notice);
    process.exit(0);
  }

  const cwd = (data && typeof data.cwd === 'string' && data.cwd) || projectDir;
  const cwdRel = projectRelative(projectDir, cwd);
  const selected = lib.attachIncludes(lib.selectForPrompt(ruleSet.rules, { promptText: '', cwdRel }), projectDir);
  // A session start resets the ledger so rules survive compaction. A subagent
  // has its own ledger keyed under the parent session, grounded once: a second
  // SubagentStart for the same agent id must not paste the rules again.
  const isSubagent = eventName === 'SubagentStart';
  const ledgerKey = isSubagent ? subagentLedgerKey(data) : data.session_id;
  const changed = ledger.changed(projectDir, ledgerKey, selected, !isSubagent);
  if (!changed.length) {
    if (migration.notice) lib.emit(eventName, migration.notice);
    process.exit(0);
  }

  const header =
    (migration.notice ? migration.notice + '\n\n' : '') +
    '=== LIVE RULES (live-rules, ' + (isSubagent ? 'subagent start' : 'session start') + ') ===\n' +
    (isSubagent
      ? 'Rules grounded for this subagent at SubagentStart' + (data.agent_type ? ' (' + data.agent_type + ')' : '') + '. '
      : 'Rules re-grounded after SessionStart (' + (data.source || 'startup') + '). ') +
    lib.formatRuleSetStatus(ruleSet) +
    'Source: ' + lib.displayPath(projectDir, ruleSet.source);

  lib.emit(eventName, lib.renderRules(changed, header));
  process.exit(0);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
