import type { SidequestSummary } from '../types'
import { lastTouchedOf } from './ages'
import { isFromEarlierWork } from './earlier-work'
import { needsHumanAnswer } from './human-answers'
import type { Ticket } from './tickets'

// `needsYou` counts every needs-you ticket whose answer the person has not sent from the board. The band warns only about the ones that are not from earlier work.
export type PublishedSummary = SidequestSummary & { needsYouFromEarlierWork?: number }

const countWithStatus = (tickets: readonly Ticket[], status: string): number =>
  tickets.filter(ticket => ticket.status === status).length

const NOTHING_TOUCHED: ReadonlySet<string> = new Set()

const countFromEarlierWork = (tickets: readonly Ticket[], touchedHere: ReadonlySet<string>, now: number): number =>
  tickets.filter(ticket => needsHumanAnswer(ticket) && isFromEarlierWork(ticket.id, lastTouchedOf(ticket), touchedHere, now)).length

export const summarize = (tickets: readonly Ticket[], touchedHere: ReadonlySet<string> = NOTHING_TOUCHED, now = Number.NaN): PublishedSummary => ({
  needsYou: tickets.filter(needsHumanAnswer).length,
  needsYouFromEarlierWork: countFromEarlierWork(tickets, touchedHere, now),
  ready: countWithStatus(tickets, 'ready'),
  doing: countWithStatus(tickets, 'doing'),
  review: countWithStatus(tickets, 'review'),
})
