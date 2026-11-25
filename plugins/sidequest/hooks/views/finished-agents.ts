import type { FinishedAgent, FinishedAgentDetail, LiveAgent, SidequestRun } from '../../types'
import { cutToLength, spokenDuration } from '../agent-returns'
import { effortLevelOf, shortModelName } from '../routing'
import { oneLine } from '../tickets'
import { withTicketRef } from './running-agents'
import { tablesAsLines } from './tables-as-lines'

const ROUTE_TAGS = /\[route:[a-z][a-z0-9-]*\]\s*/g
const SENTENCE_END = /(?<=[.!?])\s+/
const SENTENCES_ASKED = 2
const LONGEST_ASKED = 280
// Every finished agent's report is held for the whole session and drawn as one Markdown block, which the host limits.
const LONGEST_REPORT = 30000

// A brief runs to pages; a line or two of it is enough to recognise what was asked.
export const askedIn = (prompt: string): string => {
  const sentences = oneLine(prompt.replace(ROUTE_TAGS, '')).split(SENTENCE_END)

  return cutToLength(sentences.slice(0, SENTENCES_ASKED).join(' '), LONGEST_ASKED)
}

export type AgentEnd = { agentId: string; durationMs: number; answer: string }

// An effort of `own` or none means the agent kept whatever its definition or the session set, which is not known here.
const effortOf = (run: SidequestRun | undefined): { effort?: string } => {
  const effort = effortLevelOf(run?.effort ?? '')

  return effort === undefined ? {} : { effort }
}

export const finishedAgentOf = (end: AgentEnd, agent: LiveAgent, run: SidequestRun | undefined): FinishedAgent => ({
  agentId: end.agentId,
  what: withTicketRef(agent.description, run?.ticket),
  ...(run?.ticket === undefined ? {} : { ticket: run.ticket }),
  asked: agent.asked ?? '',
  model: shortModelName(agent.model),
  ...effortOf(run),
  durationMs: end.durationMs,
  report: cutToLength(end.answer, LONGEST_REPORT),
  mainTurnsSince: 0,
})

// An agent woken again returns again: its latest return replaces the one before and counts as the newest.
export const withFinishedAgent = (finished: readonly FinishedAgent[], agent: FinishedAgent): FinishedAgent[] => [
  ...finished.filter(one => one.agentId !== agent.agentId),
  agent,
]

const MAIN_TURNS_IT_STAYS_JUST_FINISHED = 2

export const afterAMainTurnStarts = (finished: readonly FinishedAgent[]): FinishedAgent[] =>
  finished.map(agent => ({ ...agent, mainTurnsSince: Math.min(agent.mainTurnsSince + 1, MAIN_TURNS_IT_STAYS_JUST_FINISHED) }))

export const isJustFinished = (agent: FinishedAgent): boolean => agent.mainTurnsSince < MAIN_TURNS_IT_STAYS_JUST_FINISHED

export const newestReturnFirst = (finished: readonly FinishedAgent[]): FinishedAgent[] => [...finished].reverse()

export const finishedAgentAside = (agent: FinishedAgent): string =>
  [agent.model, `took ${spokenDuration(agent.durationMs)}`].filter(part => part !== '').join(', ')

const factsOf = (agent: FinishedAgent): string =>
  [agent.model === '' ? '' : `On ${agent.model}`, agent.effort === undefined ? '' : `${agent.effort} effort`, `took ${spokenDuration(agent.durationMs)}`]
    .filter(part => part !== '')
    .join(', ')

// The host's View answers only for an agent its tasks list still shows, and drops a finished one some time after it
// returns, so whether it is still listed is the one sign a plugin has that View would work.
export const transcriptOf = (agentId: string, listedIds: readonly string[], hasMainView: boolean): FinishedAgentDetail['transcript'] => {
  if (!hasMainView) return 'elsewhere'

  return listedIds.includes(agentId) ? 'viewable' : 'gone'
}

export const finishedAgentDetail = (agent: FinishedAgent, transcript: FinishedAgentDetail['transcript']): FinishedAgentDetail => ({
  agentId: agent.agentId,
  title: agent.what,
  asked: agent.asked,
  facts: factsOf(agent),
  report: tablesAsLines(agent.report),
  transcript,
})
