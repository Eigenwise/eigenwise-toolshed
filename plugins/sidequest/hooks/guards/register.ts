import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import {
  callerRow, deniedToolsDenial, heredocDenial, inlineWorkNudge, inlineWorkStep, isolatedPeerRow, missingWorktreeDenial,
  repeatedCommandStep, REPEATED_COMMAND_WARNING, taskOutputDenial, terminalPeerDenial, terminalPeerRow,
} from './context-guards.js'
import type { SnapshotRow } from './context-guards.js'
import type { InlineWork } from '../../types/index.js'
import { boardExists, machine, projectDirectory, readSnapshot, worktreeExists } from './snapshot.js'
import { bashWindowsPathVerdict, homeDeleteDenial, powershellShimContext } from './text-guards.js'
import type { GuardVerdict } from './text-guards.js'

// classic.PreToolUse hands a module only { tool, tool_use_id, ...args } (no agent_type, session_id or cwd),
// so the guards hook tool.call, whose e also carries agentId inside a subagent (SQ-3743 probe).

const REPEATED_COMMANDS = { plugin: 'sidequest', key: 'repeatedCommands' } as const
const INLINE_WORK = { plugin: 'sidequest', key: 'inlineWork' } as const
const AUTOMATION_TAG = /^<(?:agent-message|local-command(?:-caveat)?|task-notification|task-progress|task-result)\b/i

function textField(e: object, name: string): string {
  const value: unknown = Reflect.get(e, name)
  return typeof value === 'string' ? value : ''
}

function withContext(ran: ToolCallResult, context: string | null): ToolCallResult {
  if (!context || ran.deny !== undefined) return ran
  return { ...ran, context: [...(ran.context ?? []), context] }
}

async function sessionRows($: EngineInterface): Promise<SnapshotRow[]> {
  return (await readSnapshot($, await projectDirectory($, await $.session.cwd())))?.dispatches ?? []
}

async function caller($: EngineInterface, agentId: string | undefined): Promise<SnapshotRow | null> {
  return callerRow(await sessionRows($), agentId, await $.session.id())
}

async function isSidequestAgent($: EngineInterface, agentId: string): Promise<boolean> {
  const agent = (await $.agent.list()).find(candidate => candidate.id === agentId)
  return /^(?:sidequest:)?sidequest-/.test(agent?.type ?? '')
}

async function peerMessageDenial($: EngineInterface, to: string): Promise<string | null> {
  const rows = await sessionRows($)
  const terminal = terminalPeerRow(rows, to)
  if (terminal) return terminalPeerDenial(terminal, to)
  const isolated = isolatedPeerRow(rows, to)
  return isolated?.worktree && !(await worktreeExists($, isolated.worktree)) ? missingWorktreeDenial(isolated) : null
}

async function routedBoard($: EngineInterface): Promise<boolean> {
  const directory = await projectDirectory($, await $.session.cwd())
  if (!(await boardExists($, directory))) return false
  return (await readSnapshot($, directory))?.routed !== false
}

async function inlineWorkAdvice($: EngineInterface, tool: string, command: string, subagentType: string): Promise<string | null> {
  const { value = {} } = await $.state.get(INLINE_WORK)
  const { next, crossed } = inlineWorkStep(value, tool, command, subagentType)
  if (next !== value) await $.state.set(INLINE_WORK, next)
  if (!crossed || !(await routedBoard($)) || (await caller($, undefined))) return null
  return inlineWorkNudge(next.substantiveActions ?? 0)
}

export const register: Register = on => {
  on('tool.call', { tool: /^(Bash|PowerShell)$/ }, async ($, e, next) => {
    try {
      const denial = homeDeleteDenial(textField(e, 'command'), await machine($))
      if (denial) return { deny: denial }
    } catch {
      $.ui.status('sidequest: guard-home-delete skipped')
    }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    let verdict: GuardVerdict = null
    try {
      if ((await machine($)).windows) verdict = bashWindowsPathVerdict(textField(e, 'command'))
    } catch {
      $.ui.status('sidequest: guard-bash-windows-paths skipped')
    }
    if (verdict && 'deny' in verdict) return { deny: verdict.deny }
    return withContext(await next(e), verdict?.context ?? null)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    try {
      const denial = heredocDenial(textField(e, 'command'), await caller($, e.agentId), await $.session.cwd())
      if (denial) return { deny: denial }
    } catch {
      $.ui.status('sidequest: guard-heredoc-isolated skipped')
    }
    return next(e)
  })

  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    let context: string | null = null
    try {
      if ((await machine($)).windows) context = powershellShimContext(textField(e, 'command'))
    } catch {
      $.ui.status('sidequest: guard-powershell-cmd-shims skipped')
    }
    return withContext(await next(e), context)
  })

  on('tool.call', { tool: /^(Bash|PowerShell)$/ }, async ($, e, next) => {
    let warn = false
    try {
      if (e.agentId && (await isSidequestAgent($, e.agentId))) {
        const { value = {} } = await $.state.get(REPEATED_COMMANDS)
        const step = repeatedCommandStep(value[e.agentId], textField(e, 'command'))
        if (step) await $.state.set(REPEATED_COMMANDS, { ...value, [e.agentId]: step.next })
        warn = step?.warn === true
      }
    } catch {
      $.ui.status('sidequest: repeated-command-warn skipped')
    }
    return withContext(await next(e), warn ? REPEATED_COMMAND_WARNING : null)
  })

  // The engine takes one matcher-less tool.call hook per module, so the two every-tool guards share it.
  on('tool.call', async ($, e, next) => {
    try {
      const denial = deniedToolsDenial(e.tool, await caller($, e.agentId))
      if (denial) return { deny: denial }
    } catch {
      $.ui.status('sidequest: guard-denied-tools skipped')
    }
    let advice: string | null = null
    try {
      if (!e.agentId) advice = await inlineWorkAdvice($, e.tool, textField(e, 'command'), textField(e, 'subagent_type'))
      if (advice) $.ui.toast(advice)
    } catch {
      $.ui.status('sidequest: inline-work-nudge skipped')
    }
    return withContext(await next(e), advice)
  })

  on('tool.call', { tool: /^TaskOutput$/ }, async ($, e, next) => {
    try {
      const denial = e.agentId ? null : taskOutputDenial({ task_id: Reflect.get(e, 'task_id'), id: Reflect.get(e, 'id') }, await sessionRows($), await $.session.id())
      if (denial) return { deny: denial }
    } catch {
      $.ui.status('sidequest: guard-task-output skipped')
    }
    return next(e)
  })

  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    try {
      const denial = await peerMessageDenial($, textField(e, 'to').trim())
      if (denial) return { deny: denial }
    } catch {
      $.ui.status('sidequest: guard-peer-message skipped')
    }
    return next(e)
  })

  // A board call silences the inline-work nudge only until the next prompt, so a later inline burst is
  // still counted; advisorySurfaced stays, so the nudge shows once per session.
  on('prompt.submit', async ($, e, next) => {
    try {
      const { value } = await $.state.get(INLINE_WORK)
      if (!e.isMeta && !AUTOMATION_TAG.test(e.text.trim()) && value?.boardInteraction) {
        await $.state.set(INLINE_WORK, { advisorySurfaced: value.advisorySurfaced } satisfies InlineWork)
      }
    } catch {
      $.ui.status('sidequest: inline-work-nudge skipped')
    }
    return next(e)
  })
}
