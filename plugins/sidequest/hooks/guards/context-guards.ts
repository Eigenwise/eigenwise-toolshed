import { deniedToolMatch } from '../../src/lib/denied-tools.js';
import type { InlineWork, RepeatedCommand } from '../../types/index.js';

// Pure decisions for the guards that need to know who is calling. The caller is resolved from the
// store's dispatch snapshot (src/lib/store/dispatch-snapshot.ts); these functions only read rows.
export type SnapshotRow = {
  ref: string;
  sessionId: string | null;
  claimSessionId: string | null;
  agentId: string | null;
  agentName: string | null;
  executor: string | null;
  worktree: string | null;
  sharedTree: boolean;
  readonly: boolean;
  state: string;
  deniedTools: string[];
};

export type Snapshot = { at: string; routed: boolean; dispatches: SnapshotRow[] };

const LIVE_STATES = new Set(['prepared', 'launched', 'bound', 'claimed']);

// A subagent is known by its agent id; a teammate in its own pane is the main loop of its own session,
// so it is known by the session that claimed the ticket. The orchestrator's own session id sits on the
// rows it dispatched as sessionId, never claimSessionId, so it is not mistaken for its executors.
export function callerRow(rows: readonly SnapshotRow[], agentId: string | undefined, sessionId: string): SnapshotRow | null {
  const live = rows.filter((row) => LIVE_STATES.has(row.state));
  if (agentId) return live.find((row) => row.agentId === agentId) ?? null;
  return live.find((row) => row.state === 'claimed' && row.claimSessionId === sessionId) ?? null;
}

export function deniedToolsDenial(toolName: string, row: SnapshotRow | null): string | null {
  if (!row) return null;
  const pattern = deniedToolMatch(toolName, row.deniedTools);
  if (!pattern) return null;
  return `sidequest: ${toolName} is denied to executors on ${row.ref} by the board deniedTools setting (${pattern}). Finish the ticket with the remaining tools; when it needs ${toolName}, comment why on the ticket and release it.`;
}

export const HEREDOC_DENIAL = 'sidequest: the harness refuses heredocs in isolated worktrees; Write the script to your scratchpad and run it by path.';

function skipQuoted(command: string, index: number): number {
  const quote = command[index];
  for (let cursor = index + 1; cursor < command.length; cursor += 1) {
    if (quote === '"' && command[cursor] === '\\') cursor += 1;
    else if (command[cursor] === quote) return cursor;
  }
  return command.length;
}

function startsComment(command: string, index: number): boolean {
  const previous = command[index - 1];
  return previous === undefined || /[\s;&|(]/.test(previous);
}

export function hasHereDoc(command: string): boolean {
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === "'" || character === '"') index = skipQuoted(command, index);
    else if (character === '#' && startsComment(command, index)) {
      const lineEnd = command.indexOf('\n', index);
      if (lineEnd < 0) return false;
      index = lineEnd;
    } else if (character === '<' && command[index + 1] === '<' && command[index + 2] !== '<') return true;
  }
  return false;
}

export function harnessWorktreeCwd(cwd: string): boolean {
  const parts = cwd.split(/[\\/]+/).map((part) => part.toLowerCase());
  return parts.some((part, index) => (
    part === 'worktrees'
    && parts.slice(0, index).includes('.claude')
    && (parts[index + 1]?.startsWith('agent-') === true || parts[index + 2]?.startsWith('agent-') === true)
  ));
}

export function heredocDenial(command: string, row: SnapshotRow | null, cwd: string): string | null {
  if (!hasHereDoc(command)) return null;
  return row?.sharedTree === false || harnessWorktreeCwd(cwd) ? HEREDOC_DENIAL : null;
}

export const REPEATED_COMMAND_WARNING = 'sidequest: you have run this exact command 3 times; if you are waiting on something, run it with run_in_background and let the completion notification wake you — polling burns ~14s and ~60k tokens per call';

function warnsAt(count: number, lastWarning: number): boolean {
  return count >= 3 && (lastWarning === 0 || count - lastWarning >= 5);
}

export function repeatedCommandStep(previous: RepeatedCommand | undefined, rawCommand: string): { next: RepeatedCommand; warn: boolean } | null {
  const command = rawCommand.trim().replace(/\s+/g, ' ');
  if (!command) return null;
  const { count, lastWarning } = previous?.command === command ? { count: previous.count + 1, lastWarning: previous.lastWarning } : { count: 1, lastWarning: 0 };
  const warn = warnsAt(count, lastWarning);
  return { next: { command, count, lastWarning: warn ? count : lastWarning }, warn };
}

export const TASK_OUTPUT_DENIAL = 'sidequest: native Agent results arrive automatically. Use pulse <ref> / changes --since for liveness. Use TaskStop only after terminal board evidence.';

function sidequestTaskId(value: unknown, dispatchedIds: ReadonlySet<string>): boolean {
  if (typeof value !== 'string' || !value) return false;
  const lowered = value.toLowerCase();
  if (lowered.startsWith('sidequest-') || dispatchedIds.has(value)) return true;
  return lowered.includes('sidequest') && /@session-[^\s]+/i.test(value);
}

export function taskOutputDenial(toolInput: { task_id?: unknown; id?: unknown }, rows: readonly SnapshotRow[], sessionId: string): string | null {
  const dispatchedIds = new Set(rows
    .filter((row) => sessionId && row.sessionId === sessionId)
    .flatMap((row) => [row.agentName, row.agentId])
    .filter((value): value is string => Boolean(value)));
  return sidequestTaskId(toolInput.task_id, dispatchedIds) || sidequestTaskId(toolInput.id, dispatchedIds) ? TASK_OUTPUT_DENIAL : null;
}

// A closed row's state is its terminal outcome (the snapshot writer's dispatchRowState).
export function terminalPeerRow(rows: readonly SnapshotRow[], to: string): SnapshotRow | null {
  return rows.filter((row) => to && row.agentName === to && !LIVE_STATES.has(row.state)).at(-1) ?? null;
}

export function terminalPeerDenial(row: SnapshotRow, to: string): string {
  return `sidequest: ${row.ref} is terminal (${row.state}) and executor "${to}" is closed. `
    + 'File a follow-up ticket for changes, or redispatch the existing ticket when it was released without a pending submission.';
}

export function isolatedPeerRow(rows: readonly SnapshotRow[], to: string): SnapshotRow | null {
  return rows.find((row) => to && row.agentName === to && row.sharedTree === false && row.worktree) ?? null;
}

export function missingWorktreeDenial(row: SnapshotRow): string {
  return `sidequest: ${row.ref} is worktree-isolated but its recorded worktree is gone. `
    + 'Do not resume this executor because it could write to the shared checkout. Redispatch the ticket instead.';
}

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
export const SUBSTANTIVE_ADVISORY_THRESHOLD = 25;

function isBoardInteraction(toolName: string, command: string, subagentType: string): boolean {
  if (toolName.startsWith('mcp__plugin_sidequest_board__')) return true;
  if (toolName === 'Agent') return /^(?:sidequest:)?sidequest-exec/.test(subagentType);
  return SHELL_TOOLS.has(toolName) && /(?:^|[\s"'\\/])sidequest(?:\.js)?(?=\s|["']|$)/i.test(command);
}

function isPureRead(command: string): boolean {
  const parts = command.split(/(?:&&|\|\||;)/).map((part) => part.trim()).filter(Boolean);
  return parts.every((part) => /^(?:cd\s+\S+|(?:git\s+)?(?:status|diff|log|show|branch\s+--show-current|rev-parse|ls-files)|(?:ls|dir|pwd|cat|head|tail|rg|grep|find|which|where|get-(?:childitem|content|item|location)|select-string|test-path)\b)/i.test(part));
}

// Test and build runs check work already done; counting them as edits fired the nudge on verification loops.
function isVerificationRun(command: string): boolean {
  const parts = command.split(/(?:&&|\|\||;)/).map((part) => part.trim()).filter(Boolean);
  return parts.every((part) => /^(?:cd\s+\S+$|npm\s+(?:--prefix\s+\S+\s+)?(?:test|t|run\s+(?:test|build|typecheck)\S*)\b|node\s+(?:--import\s+\S+\s+)*(?:-e|--eval|--test)\b|(?:npx\s+)?tsc\b)/i.test(part));
}

function isSubstantive(toolName: string, command: string): boolean {
  if (EDIT_TOOLS.has(toolName)) return true;
  return SHELL_TOOLS.has(toolName) && !isPureRead(command) && !isVerificationRun(command);
}

export function inlineWorkNudge(substantiveActions: number): string {
  return `sidequest: ${substantiveActions} substantive actions without a board call. Consider one owner and a focused check for a bounded fix. Small fixes at known locations may stay inline; use a story or wave only for 3+ independently checkable pieces with a stated reason.`;
}

// Returns the new state, and whether this call crossed the threshold; the caller checks the board only then.
export function inlineWorkStep(state: InlineWork, toolName: string, command: string, subagentType: string): { next: InlineWork; crossed: boolean } {
  if (isBoardInteraction(toolName, command.trim(), subagentType)) return { next: { ...state, boardInteraction: true }, crossed: false };
  return isSubstantive(toolName, command.trim()) ? countSubstantiveAction(state) : { next: state, crossed: false };
}

function countSubstantiveAction(state: InlineWork): { next: InlineWork; crossed: boolean } {
  const substantiveActions = (state.substantiveActions ?? 0) + 1;
  const crossed = !state.boardInteraction && !state.advisorySurfaced && substantiveActions >= SUBSTANTIVE_ADVISORY_THRESHOLD;
  return { next: { ...state, substantiveActions, advisorySurfaced: state.advisorySurfaced || crossed }, crossed };
}
