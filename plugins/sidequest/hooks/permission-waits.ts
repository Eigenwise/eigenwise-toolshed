import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { asksAPerson, toolShortName } from './views/running-agents'

const agentRuns = atom({ plugin: 'sidequest', key: 'runs' } as const, {})
const liveAgents = atom({ plugin: 'sidequest', key: 'agents' } as const, {}, { shape: 'live-agents-2' })
const permissionWaits = atom({ plugin: 'sidequest', key: 'permissionWaits' } as const, {})

// tool.check and turn.step run for every tool call and every model request, so they look here first and touch state
// only for an agent that is really waiting.
const waitingAgents = new Set<string>()

export const isWaitingOnPermission = (agentId: string): boolean => waitingAgents.has(agentId)

const withoutAgent = <Value>(byAgent: Record<string, Value>, agentId: string): Record<string, Value> =>
  Object.fromEntries(Object.entries(byAgent).filter(([id]) => id !== agentId))

async function notifyOfPermissionWait($: EngineInterface, agentId: string, tool: string): Promise<void> {
  const ticket = (await read($, agentRuns))[agentId]?.ticket
  const text = `${ticket ?? 'A background agent'} waits on your permission for ${toolShortName(tool)}.`
  await $.ui.notify(text, { title: 'Sidequest', key: `permission-${agentId}` })
}

export async function notePermissionWait($: EngineInterface, agentId: string, tool: string): Promise<void> {
  if (waitingAgents.has(agentId)) return
  const agent = (await read($, liveAgents))[agentId]
  if (!asksAPerson(agent?.permissionMode)) return
  waitingAgents.add(agentId)
  await update($, permissionWaits, waits => ({ ...waits, [agentId]: tool }))
  await notifyOfPermissionWait($, agentId, tool)
}

export async function forgetPermissionWait($: EngineInterface, agentId: string): Promise<void> {
  waitingAgents.delete(agentId)
  await update($, permissionWaits, waits => withoutAgent(waits, agentId))
}

export async function clearPermissionWait($: EngineInterface, agentId: string): Promise<void> {
  if (waitingAgents.has(agentId)) await forgetPermissionWait($, agentId)
}
