'use strict';
/**
 * Force Sidequest ticket executors into bypass mode at the Agent-tool boundary.
 * Plugin agent frontmatter is not authoritative when the parent runs in auto
 * mode, so this hook updates the actual launch input before Claude Code creates
 * the subagent/worktree. Codex-backed and temporary native executors also pin
 * their real model in frontmatter. An Agent `model` field overrides that pin,
 * so remove it here before a caller can accidentally spend Claude usage.
 */

const fs = require('fs');

const BUILTIN_EXECUTORS = new Set([
  'sidequest-exec-low', 'sidequest-exec-medium', 'sidequest-exec-high',
  'sidequest-exec-xhigh', 'sidequest-exec-max',
]);

function isPinnedSidequestExecutor(type) {
  return type.startsWith('sidequest-native-')
    || (type.startsWith('sidequest-exec-') && !BUILTIN_EXECUTORS.has(type));
}

function main() {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw) return;
  const input = JSON.parse(raw);
  const toolInput = input && input.tool_input;
  if (!toolInput || typeof toolInput !== 'object') return;
  const type = String(toolInput.subagent_type || '');
  const isExec = type.startsWith('sidequest-exec-') || type.startsWith('sidequest-native-');
  if (!isExec) return;

  const updatedInput = { ...toolInput, mode: 'bypassPermissions' };
  const pinned = isPinnedSidequestExecutor(type);
  if (pinned) delete updatedInput.model;
  process.stdout.write(JSON.stringify({
    ...(pinned && Object.prototype.hasOwnProperty.call(toolInput, 'model')
      ? { systemMessage: `sidequest: removed the Agent model override for ${type}; its frontmatter pin selects the routed backend.` }
      : {}),
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput,
    },
  }));
}

try {
  main();
} catch (_) {
  // Fail soft. A hook bug must never block unrelated Agent launches.
  process.exit(0);
}
