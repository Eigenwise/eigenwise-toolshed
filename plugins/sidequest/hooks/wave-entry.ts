import { effortLevelOf, isClaudeAlias } from './routing'
import type { Route } from './routing'

// What the wave workflow reads for one ticket. Model and effort are left out when the route has no value the agent
// call can carry, as the Agent call is.
export type WaveEntry = {
  id: string
  title: string
  briefFile: string
  agentType: string
  model?: string
  effort?: string
  worktree: boolean
  review: boolean
}

export type ReviewRoute = { model?: string; effort?: string }

type RoutedAgent = { subagent_type: string; model?: string; effort?: string; isolation?: string }

type EntryTicket = { id: string; title: string; category: string }

const isOutsideCode = (route: Route): boolean => route.role === 'outside-code-reviewer'

export const waveEntryFor = (ticket: EntryTicket, route: Route, call: RoutedAgent, briefFile: string): WaveEntry => ({
  id: ticket.id,
  title: ticket.title,
  briefFile,
  agentType: call.subagent_type,
  ...(call.model === undefined ? {} : { model: call.model }),
  ...(call.effort === undefined ? {} : { effort: call.effort }),
  worktree: call.isolation === 'worktree',
  review: ticket.category !== 'quick' && !isOutsideCode(route),
})

export const reviewRouteOf = (route: Route | undefined): ReviewRoute => ({
  ...(route !== undefined && isClaudeAlias(route.model) ? { model: route.model } : {}),
  ...(route !== undefined && effortLevelOf(route.effort) !== undefined ? { effort: route.effort } : {}),
})

export const waveAnswerText = (entry: WaveEntry, reviewRoute: ReviewRoute): string =>
  [
    `The brief is kept in ${entry.briefFile}, and the wave's agents read it there.`,
    `Entry for this ticket: ${JSON.stringify(entry)}`,
    `reviewRoute: ${JSON.stringify(reviewRoute)}`,
    'Collect the entries of every ticket, then call the saved wave workflow with { tickets: [...entries], reviewRoute }.',
  ].join('\n')
