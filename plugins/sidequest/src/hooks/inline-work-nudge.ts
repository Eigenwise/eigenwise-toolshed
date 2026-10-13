import { canonicalExecutorName } from '../lib/exec-names.js';
import { isRecord, isSubagent, readStdin, stringField, type HookInput } from './shared/input.js';
import { writeSystemMessage } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';
import { readSessionState, sessionStateFile, writeSessionState } from './shared/session-state.js';

const AUTOMATION_TAG = /^<(?:agent-message|local-command(?:-caveat)?|task-notification|task-progress|task-result)\b/i;
const SUBSTANTIVE_ADVISORY_THRESHOLD = 25;
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

interface Store {
  nearestRepoRoot: (start: string) => string;
  findProject: (start: string) => { ok: boolean; slug?: string };
  projectDispatchAdmission: (slug: string) => { status: string };
}

function boardFor(input: HookInput): string | null {
  const store = require(runtimeModule('store')) as Store;
  const start = stringField(input, 'cwd') || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const found = store.findProject(store.nearestRepoRoot(start));
  if (!found.ok || !found.slug || store.projectDispatchAdmission(found.slug).status !== 'routed') return null;
  return found.slug;
}

function shellCommand(input: HookInput): string {
  const toolInput = input.tool_input;
  return isRecord(toolInput) && typeof toolInput.command === 'string' ? toolInput.command.trim() : '';
}

function isBoardInteraction(toolName: string, command: string): boolean {
  if (toolName.startsWith('mcp__plugin_sidequest_board__')) return true;
  if (!SHELL_TOOLS.has(toolName) || !command) return false;
  return /(?:^|[\s"'\\/])sidequest(?:\.js)?(?=\s|["']|$)/i.test(command);
}

function isPureRead(command: string): boolean {
  const parts = command.split(/(?:&&|\|\||;)/).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return true;
  return parts.every((part) => /^(?:cd\s+\S+|(?:git\s+)?(?:status|diff|log|show|branch\s+--show-current|rev-parse|ls-files)|(?:ls|dir|pwd|cat|head|tail|rg|grep|find|which|where|get-(?:childitem|content|item|location)|select-string|test-path)\b)/i.test(part));
}

// Test and build runs check work already done; counting them as edits fired the nudge on verification loops.
function isVerificationRun(command: string): boolean {
  const parts = command.split(/(?:&&|\|\||;)/).map((part) => part.trim()).filter(Boolean);
  return parts.every((part) => /^(?:cd\s+\S+$|npm\s+(?:--prefix\s+\S+\s+)?(?:test|t|run\s+(?:test|build|typecheck)\S*)\b|node\s+(?:--import\s+\S+\s+)*(?:-e|--eval|--test)\b|(?:npx\s+)?tsc\b)/i.test(part));
}

function isBoundedTranscriptLookup(command: string, prompt: string): boolean {
  if (!/\b(?:find|search|locate|look\s+up)\b[\s\S]*\b(?:session|transcript)\b/i.test(prompt)) return false;
  if (!/\b(?:node|python(?:3)?)\b/i.test(command)) return false;
  if (!/\b(?:limit|head|slice|take|max(?:[-_ ]?results)?|break|first)\b|\[\s*:\s*\d+/i.test(command)) return false;
  return !/\b(?:write(?:File|_text|_bytes|FileSync)?|appendFile(?:Sync)?|unlink(?:Sync)?|remove|rename|replace|mkdir|rmdir|chmod|chown|copy(?:File)?|shutil\.|subprocess\.|os\.system|exec(?:File)?(?:Sync)?|spawn(?:Sync)?|open\([^)]*,\s*['"][wa+]|rm|del|mv|cp|git\s+(?:commit|reset|checkout|clean|merge|rebase)|npm\s+(?:install|publish))\b|(?<!\d)>\s*(?!&)/i.test(command);
}

function isSubstantive(toolName: string, command: string, prompt: string): boolean {
  if (EDIT_TOOLS.has(toolName)) return true;
  return SHELL_TOOLS.has(toolName) && !isPureRead(command) && !isVerificationRun(command) && !isBoundedTranscriptLookup(command, prompt);
}

function nudgeMessage(substantiveActions: number): string {
  return `sidequest: ${substantiveActions} substantive actions without a board call. Consider one owner and a focused check for a bounded fix. Small fixes at known locations may stay inline; use a story or wave only for 3+ independently checkable pieces with a stated reason.`;
}

function main(): void {
  const input = readStdin();
  if (!input || isSubagent(input)) return;

  const sessionId = stringField(input, 'session_id', 'sessionId').trim();
  const toolName = stringField(input, 'tool_name', 'toolName');
  const command = shellCommand(input);
  const prompt = stringField(input, 'prompt').trim();
  if (!sessionId || !toolName || AUTOMATION_TAG.test(prompt) || !boardFor(input)) return;

  const file = sessionStateFile('inline-work', sessionId);
  const state = readSessionState(file);
  if (isBoardInteraction(toolName, command)) {
    state.boardInteraction = true;
  } else if (toolName === 'Agent') {
    const subagentType = isRecord(input.tool_input) && typeof input.tool_input.subagent_type === 'string'
      ? canonicalExecutorName(input.tool_input.subagent_type)
      : '';
    if (/^sidequest-exec/.test(subagentType)) {
      state.boardInteraction = true;
    }
  } else if (isSubstantive(toolName, command, prompt)) {
    const substantiveActions = (Number(state.substantiveActions) || 0) + 1;
    state.substantiveActions = substantiveActions;
    if (!state.boardInteraction && !state.advisorySurfaced && substantiveActions >= SUBSTANTIVE_ADVISORY_THRESHOLD) {
      state.advisorySurfaced = true;
      writeSessionState(file, state);
      writeSystemMessage('PreToolUse', nudgeMessage(substantiveActions));
      return;
    }
  }
  writeSessionState(file, state);
}

try {
  main();
} catch (_) {
  process.exit(0);
}
