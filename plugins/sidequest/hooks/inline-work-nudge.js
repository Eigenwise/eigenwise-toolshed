'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const THRESHOLD = 5;
const READ_THRESHOLD = 6;
const GRACE_ACTIONS = 3;
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

function readSource(input, toolName, command) {
  if (toolName === 'Bash') return command;
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  return `${toolName}\n${String(toolInput.file_path || toolInput.path || '')}\n${String(toolInput.pattern || '')}`;
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

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
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
  let denial = '';
  if (isSubstantive(input, toolName, command) && !state.boardInteraction) {
    state.substantiveActions = Number(state.substantiveActions) || 0;
    state.substantiveActions += 1;
    if (!state.nudged && state.substantiveActions >= THRESHOLD) {
      state.nudged = true;
      additionalContext = 'sidequest: REQUIRED: substantive work MUST use a ticket and dispatch. Investigation is a spike ticket. Inline is a justified exception: claim --direct with a reason why no executor can do it. 3 more substantive actions and Edit/Write/Bash will be BLOCKED until this session claims a ticket.';
    } else if (state.nudged) {
      state.graceActions = (Number(state.graceActions) || 0) + 1;
      if (state.graceActions > GRACE_ACTIONS) {
        denial = 'sidequest: BLOCKED: substantive inline work requires a board record. File + dispatch now (`add` → `dispatch <ref>`), including a spike for investigation. Inline is a justified exception: `claim <ref> --direct --reason "why no executor can do this"` (MCP: `direct:true` + `reason`).';
      }
    }
  }
  if (isReadClass(toolName, command) && !state.boardInteraction) {
    const source = readSource(input, toolName, command);
    state.readSources = Array.isArray(state.readSources) ? state.readSources : [];
    if (!state.readSources.includes(source)) {
      if (state.readNudged && (Number(state.readGraceActions) || 0) >= GRACE_ACTIONS) {
        // Denied sources stay unrecorded, or a verbatim retry would pass as a re-read.
        denial = 'sidequest: BLOCKED: cross-file investigation is a spike ticket. File + dispatch now (`add` → `dispatch <ref>`).';
      } else if (state.readNudged) {
        state.readGraceActions = (Number(state.readGraceActions) || 0) + 1;
        state.readSources.push(source);
      } else {
        state.readSources.push(source);
        if (state.readSources.length >= READ_THRESHOLD) {
          state.readNudged = true;
          additionalContext = 'sidequest: REQUIRED: cross-file investigation needs a spike ticket and dispatch. 3 more distinct source reads/searches will be BLOCKED until this session has board contact.';
        }
      }
    }
  }
  saveState(file, state);
  if (denial) return deny(denial);
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
