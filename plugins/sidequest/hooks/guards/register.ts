import type { EngineInterface, Register } from 'claude-code'

import { bashWindowsPathVerdict, homeDeleteDenial, powershellShimContext } from './text-guards.js'
import type { GuardVerdict, Machine } from './text-guards.js'

// classic.PreToolUse hands a module only { tool, tool_use_id, ...args } (no agent_type, session_id or cwd),
// so the guards hook tool.call, whose e also carries agentId inside a subagent (SQ-3743 probe).

async function machine($: EngineInterface): Promise<Machine> {
  const windows = (await $.env.get('OS')) === 'Windows_NT'
  const home = (windows ? await $.env.get('USERPROFILE') : undefined) ?? (await $.env.get('HOME')) ?? ''
  return { home, windows }
}

function commandOf(e: { command?: unknown }): string {
  return typeof e.command === 'string' ? e.command : ''
}

export const register: Register = on => {
  on('tool.call', { tool: /^(Bash|PowerShell)$/ }, async ($, e, next) => {
    try {
      const denial = homeDeleteDenial(commandOf(e), await machine($))
      if (denial) return { deny: denial }
    } catch {
      $.ui.status('sidequest: guard-home-delete skipped')
    }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    let verdict: GuardVerdict = null
    try {
      if ((await machine($)).windows) verdict = bashWindowsPathVerdict(commandOf(e))
    } catch {
      $.ui.status('sidequest: guard-bash-windows-paths skipped')
    }
    if (verdict && 'deny' in verdict) return { deny: verdict.deny }
    const ran = await next(e)
    return verdict ? { ...ran, context: [...(ran.context ?? []), verdict.context] } : ran
  })

  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    let context: string | null = null
    try {
      if ((await machine($)).windows) context = powershellShimContext(commandOf(e))
    } catch {
      $.ui.status('sidequest: guard-powershell-cmd-shims skipped')
    }
    const ran = await next(e)
    return context ? { ...ran, context: [...(ran.context ?? []), context] } : ran
  })
}
