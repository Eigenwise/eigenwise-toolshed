'use strict';
/**
 * Force Sidequest ticket executors into bypass mode at the Agent-tool boundary.
 * Plugin agent frontmatter is not authoritative when the parent runs in auto
 * mode, so this hook updates the actual launch input before Claude Code creates
 * the subagent/worktree.
 */

const fs = require('fs');

function main() {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw) return;
  const input = JSON.parse(raw);
  const toolInput = input && input.tool_input;
  if (!toolInput || typeof toolInput !== 'object') return;
  const type = String(toolInput.subagent_type || '');
  if (!type.includes('sidequest-exec-')) return;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { ...toolInput, mode: 'bypassPermissions' },
    },
  }));
}

try {
  main();
} catch (_) {
  // Fail soft. A hook bug must never block unrelated Agent launches.
  process.exit(0);
}
