import type { SidequestSummary } from '../types'
import { A_WEEK, lastTouchedOf, millisecondsSince } from './ages'
import { isFromEarlierWork } from './earlier-work'
import { ticketsWaitingOnThePerson } from './human-answers'
import { withoutProposedTickets } from './proposed-tickets'
import type { Story, Ticket } from './tickets'
import { isStoryWaitingOnThePerson, storiesToRead } from './views/board-view'

// `needsYou` counts every ticket that waits on the person and whose answer they have not sent from the board. The band warns only about the ones that are not from earlier work.
export type PublishedSummary = SidequestSummary & { needsYouFromEarlierWork?: number }

const idsOf = (tickets: readonly Ticket[]): ReadonlySet<string> => new Set(tickets.map(ticket => ticket.id))

// A ticket that waits on the person is counted as waiting, once: the pane lists it there and in no other section.
const countWithStatus = (tickets: readonly Ticket[], status: string, waiting: ReadonlySet<string>): number =>
  tickets.filter(ticket => ticket.status === status && !waiting.has(ticket.id)).length

const NOTHING_TOUCHED: ReadonlySet<string> = new Set()

const countFromEarlierWork = (waiting: readonly Ticket[], touchedHere: ReadonlySet<string>, now: number): number =>
  waiting.filter(ticket => isFromEarlierWork(ticket.id, lastTouchedOf(ticket), touchedHere, now)).length

// The same plans the pane lists under Waits on you, read from every ticket as the pane reads them.
const countPlansWaiting = (stories: readonly Story[], tickets: readonly Ticket[], now: number): number =>
  storiesToRead(stories, tickets, now).filter(isStoryWaitingOnThePerson).length

type CheckedFacts = { waiting: ReadonlySet<string>; interrupted: ReadonlyMap<string, string>; now: number }

const isBeingChecked = (ticket: Ticket, { waiting, interrupted, now }: CheckedFacts): boolean =>
  ticket.status === 'review' && !waiting.has(ticket.id) && !interrupted.has(ticket.id) && !(millisecondsSince(lastTouchedOf(ticket), now) >= A_WEEK)

// The tickets the pane lists under Being checked: built, not waiting on the person, not interrupted and not left for a week.
export const countBeingChecked = (
  tickets: readonly Ticket[],
  interrupted: ReadonlyMap<string, string>,
  now: number,
  stories: readonly Story[] = [],
): number => {
  const facts = { waiting: idsOf(ticketsWaitingOnThePerson(tickets, stories)), interrupted, now }

  return tickets.filter(ticket => isBeingChecked(ticket, facts)).length
}

// Takes every ticket of the board: a plan's proposed tickets are no open work until its yes, so they are left out of
// the counts here, while the plans are read from all of them.
export const summarize = (
  tickets: readonly Ticket[],
  touchedHere: ReadonlySet<string> = NOTHING_TOUCHED,
  now = Number.NaN,
  stories: readonly Story[] = [],
): PublishedSummary => {
  const openWork = withoutProposedTickets(tickets, stories)
  const waitingTickets = ticketsWaitingOnThePerson(tickets, stories)
  const waiting = idsOf(waitingTickets)

  return {
    plansWaiting: countPlansWaiting(stories, tickets, now),
    needsYou: waitingTickets.length,
    needsYouFromEarlierWork: countFromEarlierWork(waitingTickets, touchedHere, now),
    ready: countWithStatus(openWork, 'ready', waiting),
    doing: countWithStatus(openWork, 'doing', waiting),
    review: countWithStatus(openWork, 'review', waiting),
  }
}
