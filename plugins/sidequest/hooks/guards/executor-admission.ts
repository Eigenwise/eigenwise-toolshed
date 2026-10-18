import type { EngineInterface, On, ToolCallResult } from 'claude-code'

import { classify, isReadOnlyExecutor } from '../../src/lib/exec-names.js'
import { namesShellWrite } from '../../src/hooks/shared/shell-writes.js'
import { terminalPeerRow } from './context-guards.js'
import type { SnapshotRow } from './context-guards.js'
import { projectDirectory, readSnapshot } from './snapshot.js'

// The executor admission decisions (hooks/force-exec-bypass.js) need the store, agentsync and git, which a
// module cannot load. So the module answers every call the snapshot proves that code would pass, and runs it
// as one process only for an Agent spawn or a call it could refuse.

export const ADMISSION_FAILED = 'sidequest: executor admission guard could not run; spawn refused'

export const GUARDED_TOOLS = /^(Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit|SendMessage|mcp__plugin_sidequest_board__(dispatch|update|scopeRequest|remove|verdict))$/
const SHELL_TOOLS = /^(Bash|PowerShell)$/
const WRITE_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/
const CLI_DISPATCH = /\bsidequest(?:\.js)?["']?\s+dispatch\s+SQ-\d+\b/i
const LIVE_STATES = new Set(['prepared', 'launched', 'bound', 'claimed'])
const CURRENT_EXECUTOR_KINDS = new Set([
  'claude_builtin', 'codex_dispatch', 'discovered_model', 'read_only_claude_builtin', 'read_only_codex_dispatch', 'read_only_discovered_model',
])
const RESERVED_KEYS = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent'])
const SNAPSHOT_TTL_MS = 2000

export type Caller = { agentId: string; type: string; sessionId: string; rows: readonly SnapshotRow[] }
export type Decision = { deny?: string; updatedInput?: Record<string, unknown>; context?: string }

function isCurrentExecutor(type: string): boolean {
  return CURRENT_EXECUTOR_KINDS.has(classify(type).kind)
}

function namePrefixes(name: string, value: string): boolean {
  return value === name || value.startsWith(`${name}-`) || value.startsWith(`a${name}-`)
}

// force-exec-bypass.ts dispatchIdentityMatches, read from a snapshot row.
export function identityMatches(row: SnapshotRow, agentId: string, type: string): boolean {
  if (row.agentId === agentId) return true
  return Boolean(row.agentName && (namePrefixes(row.agentName, agentId) || namePrefixes(row.agentName, type)))
}

// shortcut: an archived ticket leaves the snapshot, so a finished executor of one is not told to stop; the
// store still refuses its board writes.
export function closedExecutorCandidate(caller: Caller): boolean {
  return isCurrentExecutor(caller.type) && caller.rows.some((row) => (
    !LIVE_STATES.has(row.state) && row.sessionId === caller.sessionId && identityMatches(row, caller.agentId, caller.type)
  ))
}

export function shellNeedsDecision(caller: Caller, command: string): boolean {
  if (!caller.agentId) return false
  return CLI_DISPATCH.test(command) || (isReadOnlyExecutor(caller.type) && namesShellWrite(command)) || closedExecutorCandidate(caller)
}

function comparablePath(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase()
}

function sessionTicketRow(caller: Caller): boolean {
  return caller.rows.some((row) => row.sessionId === caller.sessionId
    && (row.state === 'claimed' || identityMatches(row, caller.agentId, caller.type)))
}

// A helper's write is checked against its owner's scope, and any subagent's against board-owned evidence.
export function writeNeedsDecision(caller: Caller, target: string, evidenceRoot: string): boolean {
  if (!caller.agentId) return false
  if (isCurrentExecutor(caller.type)) return closedExecutorCandidate(caller)
  return comparablePath(target).includes(`${comparablePath(evidenceRoot)}/`) || sessionTicketRow(caller)
}

export function messageNeedsDecision(caller: Caller, to: string): boolean {
  return terminalPeerRow(caller.rows, to) !== null || (Boolean(caller.agentId) && closedExecutorCandidate(caller))
}

function textField(e: object, name: string): string {
  const value: unknown = Reflect.get(e, name)
  return typeof value === 'string' ? value : ''
}

function writeTarget(e: object): string {
  return textField(e, 'file_path') || textField(e, 'notebook_path') || textField(e, 'path')
}

function parentOf(directory: string): string {
  return directory.slice(0, Math.max(directory.lastIndexOf('/'), directory.lastIndexOf('\\')))
}

export function needsDecision(tool: string, e: object, caller: Caller, projectDirectory: string): boolean {
  if (SHELL_TOOLS.test(tool)) return shellNeedsDecision(caller, textField(e, 'command'))
  if (WRITE_TOOLS.test(tool)) return writeNeedsDecision(caller, writeTarget(e), parentOf(projectDirectory))
  if (tool === 'SendMessage') return messageNeedsDecision(caller, textField(e, 'to').trim())
  return Boolean(caller.agentId)
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

const snapshots = new Map<string, { at: number; rows: readonly SnapshotRow[] }>()

async function snapshotRows($: EngineInterface, directory: string): Promise<readonly SnapshotRow[]> {
  const cached = snapshots.get(directory)
  if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return cached.rows
  const rows = (await readSnapshot($, directory))?.dispatches ?? []
  snapshots.set(directory, { at: Date.now(), rows })
  return rows
}

async function callerType($: EngineInterface, agentId: string): Promise<string> {
  if (!agentId) return ''
  return (await $.agent.list()).find((agent) => agent.id === agentId)?.type ?? ''
}

async function callerOf($: EngineInterface, agentId: string, directory: string): Promise<Caller> {
  return { agentId, type: await callerType($, agentId), sessionId: await $.session.id(), rows: await snapshotRows($, directory) }
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

async function guardedDecision($: EngineInterface, e: { tool: string; agentId?: string }): Promise<Decision> {
  try {
    const directory = await projectDirectory($, await $.session.cwd())
    const caller = await callerOf($, e.agentId ?? '', directory)
    return needsDecision(e.tool, e, caller, directory) ? await runDecision($, e.tool, e, caller) : {}
  } catch {
    $.ui.status('sidequest: executor guard skipped')
    return {}
  }
}

// A spawn admitted by accident skips routing and bypass-mode stamping, so this one fails closed.
async function admissionDecision($: EngineInterface, e: { tool: string; agentId?: string }): Promise<Decision> {
  try {
    const directory = await projectDirectory($, await $.session.cwd())
    return await runDecision($, e.tool, e, await callerOf($, e.agentId ?? '', directory))
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
