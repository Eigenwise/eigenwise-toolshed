import { isRecord, isSubagent, readStdin, stringField, type HookInput } from './shared/input.js';
import { writeSystemMessage } from './shared/output.js';
import { runtimeModule } from './shared/paths.js';
import { readSessionState, sessionStateFile, writeSessionState } from './shared/session-state.js';

const AUTOMATION_TAG = /^<(?:agent-message|local-command(?:-caveat)?|task-notification|task-progress|task-result)\b/i;
// The incident reached 35+ reads; a single-file lookup rarely needs more than a handful.
const INVESTIGATION_READ_THRESHOLD = 8;
const SUBSTANTIVE_ESCALATION_START = 4;
const NATIVE_AGENT_ESCALATION_START = 2;

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
  if (toolName !== 'Bash' || !command) return false;
  return /(?:^|[\s"'\\/])sidequest(?:\.js)?(?=\s|["']|$)/i.test(command);
}

function isPureRead(command: string): boolean {
  const parts = command.split(/(?:&&|\|\||;)/).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return true;
  return parts.every((part) => /^(?:cd\s+\S+|(?:git\s+)?(?:status|diff|log|show|branch\s+--show-current|rev-parse|ls-files)|(?:ls|dir|pwd|cat|head|tail|rg|grep|find|which|where)\b)/i.test(part));
}

function isBoundedTranscriptLookup(command: string, prompt: string): boolean {
  if (!/\b(?:find|search|locate|look\s+up)\b[\s\S]*\b(?:session|transcript)\b/i.test(prompt)) return false;
  if (!/\b(?:node|python(?:3)?)\b/i.test(command)) return false;
  if (!/\b(?:limit|head|slice|take|max(?:[-_ ]?results)?|break|first)\b|\[\s*:\s*\d+/i.test(command)) return false;
  return !/\b(?:write(?:File|_text|_bytes|FileSync)?|appendFile(?:Sync)?|unlink(?:Sync)?|remove|rename|replace|mkdir|rmdir|chmod|chown|copy(?:File)?|shutil\.|subprocess\.|os\.system|exec(?:File)?(?:Sync)?|spawn(?:Sync)?|open\([^)]*,\s*['"][wa+]|rm|del|mv|cp|git\s+(?:commit|reset|checkout|clean|merge|rebase)|npm\s+(?:install|publish))\b|(?<!\d)>\s*(?!&)/i.test(command);
}

function isSubstantive(toolName: string, command: string, prompt: string): boolean {
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit') return true;
  return toolName === 'Bash' && Boolean(command) && !isPureRead(command) && !isBoundedTranscriptLookup(command, prompt);
}

function isReadClass(toolName: string, command: string): boolean {
  return toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob' ||
    (toolName === 'Bash' && Boolean(command) && isPureRead(command));
}

function isEscalationPoint(activityCount: number, firstEscalation: number): boolean {
  let escalation = firstEscalation;
  while (escalation < activityCount) escalation *= 3;
  return activityCount === escalation;
}

function nudgeMessage(readActions: number, substantiveActions: number, repeated: boolean): string {
  const earlierReminder = repeated ? ' You have continued after an earlier reminder.' : '';
  return `sidequest: ${readActions} reads / ${substantiveActions} commands this session, no board interaction.${earlierReminder} Multi-file work defaults to board dispatch. In your next reply offer dispatch, or name why inline serves the user better than an executor.`;
}

function nativeAgentNudgeMessage(nativeAgentSpawns: number, repeated: boolean): string {
  const earlierReminder = repeated ? ' You have continued after an earlier reminder.' : '';
  return `sidequest: ${nativeAgentSpawns} native subagents this session; native Explore/general-purpose inherits the session model.${earlierReminder} Fan-out or deep investigation belongs in spike tickets on routed executors (codebase-exploration, research, spike-investigation). In your next reply offer dispatch, or name why native agents serve the user better.`;
}

function main(): void {
  const input = readStdin();
  if (!input || isSubagent(input)) return;

  const id = stringField(input, 'session_id', 'sessionId').trim();
  const toolName = stringField(input, 'tool_name', 'toolName');
  const command = shellCommand(input);
  const prompt = stringField(input, 'prompt').trim();
  if (!id || !toolName || AUTOMATION_TAG.test(prompt) || !boardFor(input)) return;

  const file = sessionStateFile('inline-work', id);
  const state = readSessionState(file);
  if (isBoardInteraction(toolName, command)) {
    state.boardInteraction = true;
  } else if (toolName === 'Agent') {
    const subagentType = isRecord(input.tool_input) && typeof input.tool_input.subagent_type === 'string'
      ? input.tool_input.subagent_type
      : '';
    if (/^sidequest-exec/.test(subagentType)) {
      state.boardInteraction = true;
    } else {
      const nativeAgentSpawns = (Number(state.nativeAgentSpawns) || 0) + 1;
      state.nativeAgentSpawns = nativeAgentSpawns;
      if (!state.nativeAgentChoiceSurfaced
        ? nativeAgentSpawns >= NATIVE_AGENT_ESCALATION_START
        : isEscalationPoint(nativeAgentSpawns, NATIVE_AGENT_ESCALATION_START)) {
        const repeated = Boolean(state.nativeAgentChoiceSurfaced);
        state.nativeAgentChoiceSurfaced = true;
        writeSessionState(file, state);
        writeSystemMessage('PreToolUse', nativeAgentNudgeMessage(nativeAgentSpawns, repeated));
        return;
      }
    }
  } else if (isSubstantive(toolName, command, prompt)) {
    const substantiveActions = (Number(state.substantiveActions) || 0) + 1;
    state.substantiveActions = substantiveActions;
    if (!state.boardInteraction && (!state.soloChoiceSurfaced || isEscalationPoint(substantiveActions, SUBSTANTIVE_ESCALATION_START))) {
      const repeated = Boolean(state.soloChoiceSurfaced);
      state.soloChoiceSurfaced = true;
      writeSessionState(file, state);
      writeSystemMessage('PreToolUse', nudgeMessage(Number(state.readActions) || 0, substantiveActions, repeated));
      return;
    }
  } else if (isReadClass(toolName, command)) {
    const readActions = (Number(state.readActions) || 0) + 1;
    state.readActions = readActions;
    if (!state.boardInteraction && (!state.investigationChoiceSurfaced
      ? readActions >= INVESTIGATION_READ_THRESHOLD
      : isEscalationPoint(readActions, INVESTIGATION_READ_THRESHOLD * 3))) {
      const repeated = Boolean(state.investigationChoiceSurfaced);
      state.investigationChoiceSurfaced = true;
      writeSessionState(file, state);
      writeSystemMessage('PreToolUse', nudgeMessage(readActions, Number(state.substantiveActions) || 0, repeated));
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
