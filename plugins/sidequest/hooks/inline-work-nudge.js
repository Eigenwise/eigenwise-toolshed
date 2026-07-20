'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const THRESHOLD = 5;
const READ_THRESHOLD = 12;
const AUTOMATION_TAG = /^<(?:agent-message|local-command(?:-caveat)?|task-notification|task-progress|task-result)\b/i;

function pluginRoot() {
  return process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
}

function sessionId(input) {
  return String(input.session_id || input.sessionId || '').trim();
}

function stateFile(id) {
  const home = process.env.SIDEQUEST_HOME || path.join(os.homedir(), '.claude', 'sidequest');
  return path.join(home, 'tmp', 'state', `inline-work-${encodeURIComponent(id)}.json`);
}

function boardFor(input) {
  const store = require(path.join(pluginRoot(), 'lib', 'store.js'));
  const start = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const found = store.findProject(store.nearestRepoRoot(start));
  if (!found.ok || !store.projectRoutingEnabled(found.slug)) return null;
  return found.slug;
}

function shellCommand(input) {
  const toolInput = input.tool_input;
  return toolInput && typeof toolInput.command === 'string' ? toolInput.command.trim() : '';
}

function isBoardInteraction(toolName, command) {
  if (toolName.startsWith('mcp__plugin_sidequest_board__')) return true;
  if (toolName !== 'Bash' || !command) return false;
  return /(?:^|[\s"'\\/])sidequest(?:\.js)?(?=\s|["']|$)/i.test(command);
}

function isPureRead(command) {
  const parts = command.split(/(?:&&|\|\||;)/).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return true;
  return parts.every((part) => /^(?:cd\s+\S+|(?:git\s+)?(?:status|diff|log|show|branch\s+--show-current|rev-parse|ls-files)|(?:ls|dir|pwd|cat|head|tail|rg|grep|find|which|where)\b)/i.test(part));
}

function isSubstantive(input, toolName, command) {
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') return true;
  return toolName === 'Bash' && Boolean(command) && !isPureRead(command);
}

function isReadClass(toolName, command) {
  return toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob' ||
    (toolName === 'Bash' && Boolean(command) && isPureRead(command));
}

function loadState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return state && typeof state === 'object' ? state : {};
  } catch (_) {
    return {};
  }
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
}

function main() {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw) return;
  const input = JSON.parse(raw);
  if (!input || typeof input !== 'object' || input.agent_id || input.agentId) return;

  const id = sessionId(input);
  const toolName = String(input.tool_name || input.toolName || '');
  const command = shellCommand(input);
  const prompt = String(input.prompt || '').trim();
  if (!id || !toolName || AUTOMATION_TAG.test(prompt) || !boardFor(input)) return;

  const file = stateFile(id);
  const state = loadState(file);
  if (isBoardInteraction(toolName, command)) {
    state.boardInteraction = true;
    saveState(file, state);
    return;
  }

  let additionalContext = '';
  if (isSubstantive(input, toolName, command)) {
    state.substantiveActions = Number(state.substantiveActions) || 0;
    state.substantiveActions += 1;
    if (!state.nudged && !state.boardInteraction && state.substantiveActions >= THRESHOLD) {
      state.nudged = true;
      additionalContext = 'sidequest: this session looks like it is doing substantive work inline. File it as a ticket and either dispatch it or claim it --direct if inline is deliberate; trivial one-liners are fine without.';
    }
  }
  if (isReadClass(toolName, command)) {
    state.readActions = Number(state.readActions) || 0;
    state.readActions += 1;
    if (!state.readSpiralNudged && !state.boardInteraction && state.readActions >= READ_THRESHOLD) {
      state.readSpiralNudged = true;
      additionalContext = 'sidequest: this session is tracing across files. A multi-file investigation is a spike ticket (usually codebase-exploration): file and dispatch it, or claim --direct if inline is deliberate.';
    }
  }
  saveState(file, state);
  if (!additionalContext) return;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext,
    },
  }));
}

try {
  main();
} catch (_) {
  process.exit(0);
}
