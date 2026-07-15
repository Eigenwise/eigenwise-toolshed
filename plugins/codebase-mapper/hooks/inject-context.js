#!/usr/bin/env node
/**
 * codebase-mapper - SessionStart context hook
 *
 * Injects the project's codebase map once at the start of a session, when a map
 * exists. SessionStart also fires on resume, clear, and compact, so the map is
 * re-injected after a compaction wipes it from context rather than only on the
 * very first startup.
 *
 * It injects a MANDATORY_INSTRUCTION block plus INDEX.md (the compact hub). The
 * block sets standing rules for the session: state which docs you will consult and
 * read them before exploring, then run a documentation check after code changes.
 * The detailed atomic docs are read on demand. It does not touch CLAUDE.md.
 *
 * A companion UserPromptSubmit hook (remind.js) re-surfaces a short reminder every
 * few prompts so the rules stay salient without repeating this block each turn.
 *
 * Design constraints:
 *   - No external dependencies (Node stdlib only).
 *   - Cross-platform (Windows / macOS / Linux).
 *   - Stays silent when there is no map for the project.
 *   - Never breaks a prompt: any error -> exit 0 with no output.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MAP_DIR_PARTS = ['.claude', '.codebase-info'];
const INDEX_REL = '.claude/.codebase-info/INDEX.md';

function readStdinCwd() {
  // Hook input arrives as JSON on stdin; cwd is a fallback for project dir.
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw) return '';
    const data = JSON.parse(raw);
    return data && typeof data.cwd === 'string' ? data.cwd : '';
  } catch (_) {
    return '';
  }
}

function main() {
  const projectDir =
    process.env.CLAUDE_PROJECT_DIR || readStdinCwd() || process.cwd();

  const indexPath = path.join(projectDir, ...MAP_DIR_PARTS, 'INDEX.md');

  let indexContent;
  try {
    indexContent = fs.readFileSync(indexPath, 'utf8');
  } catch (_) {
    // No map for this project - stay completely silent.
    process.exit(0);
  }

  const context =
    '<MANDATORY_INSTRUCTION>\n' +
    'This repository has a maintained codebase map in .claude/.codebase-info/.\n\n' +
    'BEFORE starting any task, you MUST state which doc file(s) from ' +
    '.claude/.codebase-info/ you are going to consult (e.g. "Consulting the ' +
    'codebase map: reading <file(s)> for this work."), then read them BEFORE ' +
    'exploring the codebase.\n\n' +
    'AFTER completing any task that modifies code, you MUST:\n' +
    '1. List which files you modified\n' +
    '2. Assess whether the changes affect the codebase documentation ' +
    '(architecture, directory structure, dependencies, the data model, entry ' +
    'points, APIs/events, or conventions)\n' +
    '3. End with: "Documentation check complete." followed by either:\n' +
    '   - "Running /codebase-mapper:update-codebase-map to update ' +
    'documentation." and then INVOKE the skill, OR\n' +
    '   - "No documentation updates needed because [reason]"\n\n' +
    'If no code was modified, end with: "No code changes were made, so ' +
    'documentation review is not applicable."\n' +
    '</MANDATORY_INSTRUCTION>\n\n' +
    '=== CODEBASE DOCUMENTATION ===\n\n' +
    '--- ' + INDEX_REL + ' ---\n' + indexContent.trim() + '\n';

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: context,
      },
    })
  );
  process.exit(0);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
