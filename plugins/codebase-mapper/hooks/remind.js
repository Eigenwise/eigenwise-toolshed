#!/usr/bin/env node
/**
 * codebase-mapper - UserPromptSubmit periodic reminder
 *
 * The full map and its rules are injected once at SessionStart. That injection
 * fades as the conversation grows, so this hook re-surfaces a SHORT reminder,
 * but only every Nth prompt rather than on every message. A per-session counter
 * in the temp dir tracks how many prompts have passed; the hook stays silent on
 * all the others.
 *
 * Design constraints:
 *   - No external dependencies (Node stdlib only).
 *   - Cross-platform (Windows / macOS / Linux).
 *   - Stays silent when there is no map for the project.
 *   - Never breaks a prompt: any error -> exit 0 with no output.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAP_DIR_PARTS = ['.claude', '.codebase-info'];
const REMINDER_INTERVAL = 6; // fire once every N prompts

function readStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch (_) {
    return {};
  }
}

function counterPath(sessionId) {
  const id = String(sessionId || 'default').replace(/[^A-Za-z0-9_-]/g, '');
  return path.join(os.tmpdir(), `codebase-mapper-${id}.count`);
}

function nextCount(file) {
  let n = 0;
  try {
    n = parseInt(fs.readFileSync(file, 'utf8'), 10) || 0;
  } catch (_) {
    n = 0;
  }
  n += 1;
  try {
    fs.writeFileSync(file, String(n));
  } catch (_) {
    // Can't persist -> skip reminding rather than risk firing every prompt.
    return null;
  }
  return n;
}

function main() {
  const data = readStdin();

  const projectDir =
    process.env.CLAUDE_PROJECT_DIR ||
    (typeof data.cwd === 'string' ? data.cwd : '') ||
    process.cwd();

  const indexPath = path.join(projectDir, ...MAP_DIR_PARTS, 'INDEX.md');
  try {
    fs.accessSync(indexPath);
  } catch (_) {
    // No map for this project - stay completely silent.
    process.exit(0);
  }

  const count = nextCount(counterPath(data.session_id));
  if (count === null || count % REMINDER_INTERVAL !== 0) {
    process.exit(0);
  }

  const context =
    '[codebase-mapper] Reminder: this repo has a maintained map in ' +
    '.claude/.codebase-info/. Consult the relevant doc(s) before exploring the ' +
    'code, and after any change that touches architecture, structure, ' +
    'dependencies, the data model, entry points, APIs/events, or conventions, ' +
    'run a documentation check and update the map if needed.';

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
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
