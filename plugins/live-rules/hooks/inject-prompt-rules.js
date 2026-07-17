#!/usr/bin/env node
/**
 * live-rules - UserPromptSubmit hook
 *
 * On every user prompt, injects the project's "live" rules that apply right now:
 *   - always-on rules (no scope declared),
 *   - prompt-keyword rules whose pattern matches the submitted prompt,
 *   - directory rules whose directory contains the session's working dir.
 *
 * It runs on UserPromptSubmit (not SessionStart) on purpose: a once-per-session
 * injection gets buried as the conversation grows. Re-injecting on every prompt
 * keeps the rules salient and current, and because the hook reads the rule files
 * fresh each time, editing a rule takes effect on the very next prompt with no
 * restart. That is the "live" part.
 *
 * Design constraints (shared with the rest of live-rules):
 *   - No external dependencies (Node stdlib only).
 *   - Cross-platform (Windows / macOS / Linux).
 *   - Silent when there is no live-rules file for the project.
 *   - Never breaks a prompt: any error -> exit 0 with no output.
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
  const projectDir = lib.getProjectDir(data);

  const ruleSet = lib.loadRuleSet(projectDir);
  if (!ruleSet.rules.length) process.exit(0);

  const cwd = (data && typeof data.cwd === 'string' && data.cwd) || projectDir;
  let cwdRel = '';
  try {
    cwdRel = path.relative(projectDir, cwd).replace(/\\/g, '/');
  } catch (_) {
    cwdRel = '';
  }

  const promptText = data && typeof data.prompt === 'string' ? data.prompt : '';

  const selected = lib.attachIncludes(lib.selectForPrompt(ruleSet.rules, { promptText, cwdRel }), projectDir);
  const changed = ledger.changed(projectDir, data.session_id, selected, false);
  if (!changed.length) process.exit(0);

  const header =
    '=== LIVE RULES (live-rules) ===\n' +
    'Project rules re-grounded because they are new or changed for this session. Follow them for the work in this session. ' +
    (ruleSet.stale ? 'The live-rules manifest is stale, so these files were read directly. ' : '') +
    'Source: ' + lib.displayPath(projectDir, lib.getRulesFile(projectDir));

  lib.emit('UserPromptSubmit', lib.renderRules(changed, header));
  process.exit(0);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
