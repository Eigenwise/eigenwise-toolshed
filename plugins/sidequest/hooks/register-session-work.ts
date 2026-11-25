import { atom, read, update } from 'claude-code'
import type { EngineInterface, Frozen, TurnCompleteInput } from 'claude-code'

import type { SessionWork } from '../types'
import { isRecord } from './board-config'
import { THINKING, activityOf } from './session-activity'
import { afterAMainTurnStarts, finishedAgentOf, withFinishedAgent } from './views/finished-agents'
import type { AgentEnd } from './views/finished-agents'

// The host only follows a state name declared in the file that uses it, so this file names its own.
const sessionWork = atom({ plugin: 'sidequest', key: 'sessionWork' } as const, { isWorking: false, steps: 0 })
const finishedAgents = atom({ plugin: 'sidequest', key: 'finishedAgents' } as const, [], { shape: 'finished-agents-1' })
const agentRuns = atom({ plugin: 'sidequest', key: 'runs' } as const, {})
const liveAgents = atom({ plugin: 'sidequest', key: 'agents' } as const, {}, { shape: 'live-agents-2' })

const IDLE: SessionWork = { isWorking: false, steps: 0 }

// Called from the module's existing turn hooks, so the pane follows the session's own work with no hook of its own
// and no model tokens. A failure only leaves the pane a step behind; it never touches the turn.

// Kept in memory so a burst of calls of one kind writes the state once, and no call reads the state to find out.
let activityShown: string | undefined

async function showActivity($: EngineInterface, activity: string, steps: (work: SessionWork) => number): Promise<void> {
  activityShown = activity
  const since = await $.clock.now()
  await update($, sessionWork, work => ({ isWorking: true, steps: steps(work), activity, since }))
}

export async function noteTurnStart($: EngineInterface, agentId: string | undefined): Promise<void> {
  if (agentId !== undefined) return
  await showActivity($, THINKING, () => 0)
  await update($, finishedAgents, afterAMainTurnStarts)
}

export async function noteTurnStep($: EngineInterface, agentId: string | undefined): Promise<void> {
  if (agentId === undefined) await showActivity($, THINKING, work => work.steps + 1)
}

/** One write when what the session does changes, none when a call repeats the one before it, none when a call ends. */
export async function noteToolStart($: EngineInterface, tool: string, input: unknown, agentId: string | undefined): Promise<void> {
  if (agentId !== undefined) return
  const activity = activityOf(tool, isRecord(input) ? input : {})
  if (activity !== activityShown) await showActivity($, activity, work => work.steps)
}

async function noteAgentFinished($: EngineInterface, end: AgentEnd): Promise<void> {
  const [agents, runs] = await Promise.all([read($, liveAgents), read($, agentRuns)])
  const agent = agents[end.agentId]
  if (agent === undefined) return
  const finished = finishedAgentOf(end, agent, runs[end.agentId])
  await update($, finishedAgents, earlier => withFinishedAgent(earlier, finished))
}

// Must run before the agent is forgotten: what it was doing is read from the live list.
export async function noteTurnEnd($: EngineInterface, e: Frozen<TurnCompleteInput>): Promise<void> {
  if (e.agentId === undefined) {
    activityShown = undefined
    await update($, sessionWork, () => IDLE)
  }
  else await noteAgentFinished($, { agentId: e.agentId, durationMs: e.durationMs, answer: e.answer })
}
