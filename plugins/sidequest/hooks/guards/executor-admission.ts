import type { EngineInterface, On, ToolCallResult } from 'claude-code'

import { classify, isReadOnlyExecutor } from '../../src/lib/exec-names.js'
import { mainThreadMutationDenial } from '../../src/hooks/shared/main-thread-mutations.js'
import { namesShellWrite } from '../../src/hooks/shared/shell-writes.js'
import { callerRow } from './context-guards.js'
import type { Snapshot, SnapshotRow } from './context-guards.js'
import { projectDirectory, readSnapshot } from './snapshot.js'

// The executor admission decisions (hooks/force-exec-bypass.js) need the store, agentsync and git, which a
// module cannot load. So the module answers every call the snapshot proves that code would pass, and runs it
// as one process only for an Agent spawn or a call it could refuse. The snapshot holds one project's rows
// while the decision reads every project's live store, so a missing row proves nothing.

export const ADMISSION_FAILED = 'sidequest: executor admission guard could not run; spawn refused'

export const GUARDED_TOOLS = /^(Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit|SendMessage|mcp__plugin_sidequest_board__(dispatch|update|scopeRequest|remove|verdict))$/
const SHELL_TOOLS = /^(Bash|PowerShell)$/
const WRITE_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/
const CLI_DISPATCH = /\bsidequest(?:\.js)?["']?\s+dispatch\s+SQ-\d+\b/i
const CURRENT_EXECUTOR_KINDS = new Set([
  'claude_builtin', 'codex_dispatch', 'discovered_model', 'read_only_claude_builtin', 'read_only_codex_dispatch', 'read_only_discovered_model',
])
const RESERVED_KEYS = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent'])
const SNAPSHOT_TTL_MS = 2000
// The store rewrites the snapshot on every dispatch change, but a failed side write leaves an old one in place.
const SNAPSHOT_STALE_MS = 60_000

// row is the caller's own live dispatch: a subagent's by agent id, a teammate's by the session that claimed it.
export type Caller = { agentId: string; type: string; sessionId: string; row: SnapshotRow | null; fresh: boolean }
export type Decision = { deny?: string; updatedInput?: Record<string, unknown>; context?: string }

function isCurrentExecutor(type: string): boolean {
  return CURRENT_EXECUTOR_KINDS.has(classify(type).kind)
}

// Only a fresh row binding this agent to a live dispatch proves the decision would not call it finished.
export function finishedExecutorUnproven(caller: Caller): boolean {
  if (!caller.agentId || !isCurrentExecutor(caller.type)) return false
  return !(caller.fresh && caller.row?.sessionId === caller.sessionId)
}

// The decision's dispatch and finished-executor checks need an agent id; its read-only check needs only the type.
export function shellNeedsDecision(caller: Caller, command: string): boolean {
  if (isReadOnlyExecutor(caller.type) && namesShellWrite(command)) return true
  return Boolean(caller.agentId) && (CLI_DISPATCH.test(command) || finishedExecutorUnproven(caller))
}

// A helper's write is checked against its owner's scope, which can sit in any project's live store.
export function writeNeedsDecision(caller: Caller): boolean {
  if (!caller.agentId) return false
  return isCurrentExecutor(caller.type) ? finishedExecutorUnproven(caller) : true
}

function textField(e: object, name: string): string {
  const value: unknown = Reflect.get(e, name)
  return typeof value === 'string' ? value : ''
}

// A message always runs the decision: its late-steer check finds a terminal recipient in any project's store.
export function needsDecision(tool: string, e: object, caller: Caller): boolean {
  if (SHELL_TOOLS.test(tool)) return shellNeedsDecision(caller, textField(e, 'command'))
  if (WRITE_TOOLS.test(tool)) return writeNeedsDecision(caller)
  return tool === 'SendMessage' || Boolean(caller.agentId)
}

type OutputFields = { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: Record<string, unknown>; additionalContext?: string }

// The decision process prints the PreToolUse command-hook output it always printed, or nothing to pass.
export function parseDecision(stdout: string): Decision {
  if (!stdout.trim()) return {}
  const output: OutputFields = (JSON.parse(stdout) as { hookSpecificOutput?: OutputFields }).hookSpecificOutput ?? {}
  if (output.permissionDecision === 'deny') return { deny: String(output.permissionDecisionReason ?? '') }
  return { updatedInput: output.updatedInput, context: output.additionalContext }
}

// The rewrite replaces the arguments whole: the decision removes fields (isolation, model, mode) as well as setting them.
export function rewrittenCall<E extends object>(e: E, updatedInput: Record<string, unknown>): E {
  const rewritten = { ...e }
  for (const key of Object.keys(rewritten)) {
    if (!RESERVED_KEYS.has(key)) Reflect.deleteProperty(rewritten, key)
  }
  return Object.assign(rewritten, updatedInput)
}

const snapshots = new Map<string, { readAt: number; snapshot: Snapshot | null }>()

async function cachedSnapshot($: EngineInterface, directory: string): Promise<Snapshot | null> {
  const cached = snapshots.get(directory)
  if (cached && Date.now() - cached.readAt < SNAPSHOT_TTL_MS) return cached.snapshot
  const snapshot = await readSnapshot($, directory).catch(() => null)
  snapshots.set(directory, { readAt: Date.now(), snapshot })
  return snapshot
}

function isFresh(snapshot: Snapshot | null): boolean {
  return snapshot !== null && Date.now() - Date.parse(snapshot.at) < SNAPSHOT_STALE_MS
}

async function agentType($: EngineInterface, agentId: string): Promise<string> {
  return (await $.agent.list()).find((agent) => agent.id === agentId)?.type ?? ''
}

// A subagent's type is the runtime's; a teammate runs as its session's main loop, so its claimed row names it.
async function callerOf($: EngineInterface, agentId: string): Promise<Caller> {
  const sessionId = await $.session.id()
  const snapshot = await cachedSnapshot($, await projectDirectory($, await $.session.cwd()))
  const row = callerRow(snapshot?.dispatches ?? [], agentId || undefined, sessionId)
  const type = agentId ? await agentType($, agentId) : row?.executor ?? ''
  return { agentId, sessionId, row, fresh: isFresh(snapshot), type }
}

function toolArguments(e: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(e).filter(([key]) => !RESERVED_KEYS.has(key)))
}

let transcriptPath = ''

async function runDecision($: EngineInterface, tool: string, e: object, caller: Caller): Promise<Decision> {
  const input = {
    hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolArguments(e), session_id: caller.sessionId,
    cwd: await $.session.cwd(), transcript_path: transcriptPath || undefined, agent_id: caller.agentId || undefined, agent_type: caller.type || undefined,
  }
  const ran = await $.process.run(['node', `${$.plugin.root}/hooks/force-exec-bypass.js`], { stdin: JSON.stringify(input), timeoutMs: 10_000 })
  if (ran.exitCode !== 0) throw new Error(`force-exec-bypass exited ${ran.exitCode}: ${ran.stderr.slice(0, 200)}`)
  return parseDecision(ran.stdout)
}

function withContext(ran: ToolCallResult, context: string | undefined): ToolCallResult {
  if (!context || ran.deny !== undefined) return ran
  return { ...ran, context: [...(ran.context ?? []), context] }
}

async function applied<E extends object>(e: E, next: (input: E) => Promise<ToolCallResult>, decision: Decision): Promise<ToolCallResult> {
  if (decision.deny !== undefined) return { deny: decision.deny }
  return withContext(await next(decision.updatedInput ? rewrittenCall(e, decision.updatedInput) : e), decision.context)
}

// A claimed teammate is no main thread either, though it calls without an agent id.
async function callerDecision($: EngineInterface, e: { tool: string }, caller: Caller): Promise<Decision> {
  const denial = caller.row ? mainThreadMutationDenial(e.tool, toolArguments(e)) : null
  if (denial) return { deny: denial }
  return needsDecision(e.tool, e, caller) ? runDecision($, e.tool, e, caller) : {}
}

// The main-thread-only fields are refused from the call alone, so no engine failure can admit them.
async function guardedDecision($: EngineInterface, e: { tool: string; agentId?: string }): Promise<Decision> {
  const denial = e.agentId ? mainThreadMutationDenial(e.tool, toolArguments(e)) : null
  if (denial) return { deny: denial }
  try {
    return await callerDecision($, e, await callerOf($, e.agentId ?? ''))
  } catch {
    $.ui.status('sidequest: executor guard skipped')
    return {}
  }
}

// A spawn admitted by accident skips routing and bypass-mode stamping, so this one fails closed.
async function admissionDecision($: EngineInterface, e: { tool: string; agentId?: string }): Promise<Decision> {
  try {
    return await runDecision($, e.tool, e, await callerOf($, e.agentId ?? ''))
  } catch {
    return { deny: ADMISSION_FAILED }
  }
}

export function registerExecutorAdmission(on: On): void {
  // tool.call carries no transcript_path; the helper evidence rule names the session transcript from here.
  on('classic.UserPromptSubmit', ($, e, next) => {
    transcriptPath = e.transcript_path
    return next(e)
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => applied(e, next, await admissionDecision($, e)))

  on('tool.call', { tool: GUARDED_TOOLS }, async ($, e, next) => applied(e, next, await guardedDecision($, e)))
}
