import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import {
  deniedToolsDenial, heredocDenial, inlineWorkNudge, inlineWorkStep, isolatedPeerRow, missingWorktreeDenial,
  repeatedCommandStep, REPEATED_COMMAND_WARNING, taskOutputDenial, terminalPeerDenial, terminalPeerRow,
} from './context-guards.js'
import type { InlineWork } from '../../types/index.js'
import { destructiveGitDenial, sharedCheckoutGitDenial } from './git-guards.js'
import { registerExecutorAdmission } from './executor-admission.js'
import { boardExists, caller, machine, projectDirectory, readSnapshot, sessionRows, worktreeExists } from './snapshot.js'
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

function contextOf(verdict: GuardVerdict): string | null {
  return verdict && 'context' in verdict ? verdict.context : null
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

// The main loop only: a subagent's work is its ticket's, and the nudge is about work done without one.
async function nudgeWanted($: EngineInterface): Promise<boolean> {
  return (await routedBoard($)) && !(await caller($, undefined))
}

async function inlineWorkAdvice($: EngineInterface, tool: string, command: string, subagentType: string): Promise<string | null> {
  const { value = {} } = await $.state.get(INLINE_WORK)
  const { next, crossed } = inlineWorkStep(value, tool, command, subagentType)
  if (next !== value) await $.state.set(INLINE_WORK, next)
  return crossed && (await nudgeWanted($)) ? inlineWorkNudge(next.substantiveActions ?? 0) : null
}

async function repeatedCommandWarning($: EngineInterface, agentId: string, command: string): Promise<string | null> {
  if (!(await isSidequestAgent($, agentId))) return null
  const { value = {} } = await $.state.get(REPEATED_COMMANDS)
  const step = repeatedCommandStep(value[agentId], command)
  if (!step) return null
  await $.state.set(REPEATED_COMMANDS, { ...value, [agentId]: step.next })
  return step.warn ? REPEATED_COMMAND_WARNING : null
}

async function deniedToolsGuard($: EngineInterface, e: { tool: string; agentId?: string }): Promise<string | null> {
  try {
    return deniedToolsDenial(e.tool, await caller($, e.agentId))
  } catch {
    $.ui.status('sidequest: guard-denied-tools skipped')
    return null
  }
}

async function inlineWorkGuard($: EngineInterface, e: { tool: string; agentId?: string }): Promise<string | null> {
  if (e.agentId) return null
  try {
    const advice = await inlineWorkAdvice($, e.tool, textField(e, 'command'), textField(e, 'subagent_type'))
    if (advice) $.ui.toast(advice)
    return advice
  } catch {
    $.ui.status('sidequest: inline-work-nudge skipped')
    return null
  }
}

export const register: Register = on => {
  registerExecutorAdmission(on)

  on('tool.call', { tool: /^(Bash|PowerShell)$/ }, async ($, e, next) => {
    try {
      const denial = homeDeleteDenial(textField(e, 'command'), await machine($))
      if (denial) return { deny: denial }
    } catch {
      $.ui.status('sidequest: guard-home-delete skipped')
    }
    return next(e)
  })

  // The one guard that fails closed: a reset or push it could not check may destroy or publish work.
  on('tool.call', { tool: /^(Bash|PowerShell)$/ }, async ($, e, next) => {
    const command = textField(e, 'command')
    let denial: string | null
    try {
      denial = await destructiveGitDenial($, command)
    } catch {
      denial = `sidequest: destructive git guard could not run; refusing ${command.slice(0, 300)}`
    }
    return denial ? { deny: denial } : next(e)
  })

  on('tool.call', { tool: /^(Bash|PowerShell)$/ }, async ($, e, next) => {
    try {
      const denial = await sharedCheckoutGitDenial($, textField(e, 'command'), e.agentId)
      if (denial) return { deny: denial }
    } catch {
      $.ui.status('sidequest: guard-shared-checkout-git skipped')
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
    return withContext(await next(e), contextOf(verdict))
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
    let warning: string | null = null
    try {
      if (e.agentId) warning = await repeatedCommandWarning($, e.agentId, textField(e, 'command'))
    } catch {
      $.ui.status('sidequest: repeated-command-warn skipped')
    }
    return withContext(await next(e), warning)
  })

  // The engine takes one matcher-less tool.call hook per module, so the two every-tool guards share it.
  on('tool.call', async ($, e, next) => {
    const denial = await deniedToolsGuard($, e)
    if (denial) return { deny: denial }
    return withContext(await next(e), await inlineWorkGuard($, e))
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
