#!/usr/bin/env node
/**
 * live-rules - PreToolUse hook (Edit | Write | MultiEdit | NotebookEdit)
 *
 * Right before Claude edits a file, injects the project's rules scoped to that
 * file: path/glob rules whose pattern matches the file, and directory rules
 * whose directory contains it. This is the "just-in-time, file-scoped" half of
 * live-rules; always-on and prompt-keyword rules are handled by the
 * UserPromptSubmit hook instead.
 *
 * It emits ONLY hookSpecificOutput.additionalContext. It deliberately does NOT
 * return a permissionDecision: setting "allow" would skip the user's normal
 * edit-permission prompt, and this hook's job is to inform Claude, not to change
 * what gets approved. The edit proceeds through the usual permission flow.
 *
 * Design constraints:
 *   - No external dependencies (Node stdlib only).
 *   - Cross-platform (Windows / macOS / Linux).
 *   - Silent when there is no live-rules file / no matching rule.
 *   - Never blocks or breaks an edit: any error -> exit 0 with no output.
 *     (Exit 2 would block the tool; we never do that.)
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
  const data = lib.readStdin();
  const ti = (data && data.tool_input) || {};
  const filePath = ti.file_path || ti.notebook_path;
  if (!filePath || typeof filePath !== 'string') process.exit(0);

  const projectDir = lib.getProjectDir(data);

  const ruleSet = lib.loadRuleSet(projectDir);
  if (!ruleSet.rules.length) process.exit(0);

  // Resolve to a repo-relative POSIX path. path.resolve handles both absolute
  // (Windows "C:\repo\..." or POSIX "/repo/...") and already-relative inputs.
  let relPath;
  try {
    const abs = path.resolve(projectDir, filePath);
    relPath = path.relative(projectDir, abs).replace(/\\/g, '/');
  } catch (_) {
    relPath = filePath.replace(/\\/g, '/');
  }

  // The file is outside this project: rule globs/dirs are repo-relative, so a
  // catch-all pattern should not match it. Stay silent.
  if (relPath === '..' || relPath.startsWith('../') || path.isAbsolute(relPath)) {
    process.exit(0);
  }

  const selected = lib.attachIncludes(lib.selectForEdit(ruleSet.rules, relPath), projectDir);
  const changed = ledger.changed(projectDir, data.session_id, selected, false);
  if (!changed.length) process.exit(0);

  const header =
    '=== LIVE RULES for ' + relPath + ' (live-rules) ===\n' +
    'Project rules that apply to the file you are about to edit. Follow them in this change.';

  lib.emit('PreToolUse', lib.renderRules(changed, header));
  process.exit(0);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
