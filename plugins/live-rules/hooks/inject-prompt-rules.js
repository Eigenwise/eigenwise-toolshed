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
try {
  lib = require('./lib/rules');
} catch (_) {
  process.exit(0);
}

function main() {
  const data = lib.readStdin();
  const projectDir = lib.getProjectDir(data);

  const rules = lib.loadRules(projectDir);
  if (!rules.length) process.exit(0);

  const cwd = (data && typeof data.cwd === 'string' && data.cwd) || projectDir;
  let cwdRel = '';
  try {
    cwdRel = path.relative(projectDir, cwd).replace(/\\/g, '/');
  } catch (_) {
    cwdRel = '';
  }

  const promptText = data && typeof data.prompt === 'string' ? data.prompt : '';

  const selected = lib.selectForPrompt(rules, { promptText, cwdRel });
  if (!selected.length) process.exit(0);

  const header =
    '=== LIVE RULES (live-rules) ===\n' +
    'Project rules currently in effect. Follow them for the work in this session. ' +
    'Source: ' + lib.displayPath(projectDir, lib.getRulesFile(projectDir));

  lib.emit('UserPromptSubmit', lib.renderRules(selected, header));
  process.exit(0);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
