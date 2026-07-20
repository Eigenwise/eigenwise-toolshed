import { readStdin, stringField, isRecord, type HookInput } from './shared/input.js';
import { writeContext } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';
import { readSessionState, sessionStateFile, writeSessionState } from './shared/session-state.js';

const THRESHOLD = 5;
const READ_THRESHOLD = 12;
const AUTOMATION_TAG = /^<(?:agent-message|local-command(?:-caveat)?|task-notification|task-progress|task-result)\b/i;

interface Store {
  nearestRepoRoot: (start: string) => string;
  findProject: (start: string) => { ok: boolean; slug?: string };
  projectRoutingEnabled: (slug: string) => boolean;
}

function boardFor(input: HookInput): string | null {
  const store = require(runtimeModule('store')) as Store;
  const start = stringField(input, 'cwd') || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const found = store.findProject(store.nearestRepoRoot(start));
  if (!found.ok || !found.slug || !store.projectRoutingEnabled(found.slug)) return null;
  return found.slug;
}

function shellCommand(input: HookInput): string {
  const toolInput = input.tool_input;
  return isRecord(toolInput) && typeof toolInput.command === 'string' ? toolInput.command.trim() : '';
}

function isBoardInteraction(toolName: string, command: string): boolean {
  if (toolName.startsWith('mcp__plugin_sidequest_board__')) return true;
  if (toolName !== 'Bash' || !command) return false;
  return /(?:^|[\s"'\\/])sidequest(?:\.js)?(?=\s|["']|$)/i.test(command);
}

function isPureRead(command: string): boolean {
  const parts = command.split(/(?:&&|\|\||;)/).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return true;
  return parts.every((part) => /^(?:cd\s+\S+|(?:git\s+)?(?:status|diff|log|show|branch\s+--show-current|rev-parse|ls-files)|(?:ls|dir|pwd|cat|head|tail|rg|grep|find|which|where)\b)/i.test(part));
}

function isSubstantive(toolName: string, command: string): boolean {
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') return true;
  return toolName === 'Bash' && Boolean(command) && !isPureRead(command);
}

function isReadClass(toolName: string, command: string): boolean {
  return toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob' ||
    (toolName === 'Bash' && Boolean(command) && isPureRead(command));
}

function main(): void {
  const input = readStdin();
  if (!input || input.agent_id || input.agentId) return;

  const id = stringField(input, 'session_id', 'sessionId').trim();
  const toolName = stringField(input, 'tool_name', 'toolName');
  const command = shellCommand(input);
  const prompt = stringField(input, 'prompt').trim();
  if (!id || !toolName || AUTOMATION_TAG.test(prompt)) return;

  const file = sessionStateFile('inline-work', id);
  const state = readSessionState(file);
  if (state.boardInteraction) return;
  if (!boardFor(input)) return;
  if (isBoardInteraction(toolName, command)) {
    state.boardInteraction = true;
    writeSessionState(file, state);
    return;
  }

  let additionalContext = '';
  if (isSubstantive(toolName, command)) {
    const substantiveActions = (Number(state.substantiveActions) || 0) + 1;
    state.substantiveActions = substantiveActions;
    if (!state.nudged && substantiveActions >= THRESHOLD) {
      state.nudged = true;
      additionalContext = 'sidequest: this session looks like it is doing substantive work inline. File it as a ticket and either dispatch it or claim it --direct if inline is deliberate; trivial one-liners are fine without.';
    }
  }
  if (isReadClass(toolName, command)) {
    const readActions = (Number(state.readActions) || 0) + 1;
    state.readActions = readActions;
    if (!state.readSpiralNudged && readActions >= READ_THRESHOLD) {
      state.readSpiralNudged = true;
      additionalContext = 'sidequest: this session is tracing across files. A multi-file investigation is a spike ticket (usually codebase-exploration): file and dispatch it, or claim --direct if inline is deliberate.';
    }
  }
  writeSessionState(file, state);
  if (additionalContext) writeContext('PreToolUse', additionalContext);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
