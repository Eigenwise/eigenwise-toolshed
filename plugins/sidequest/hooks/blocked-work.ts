import { isBlockerMet } from './frontier'
import { inIdOrder } from './tickets'
import type { Ticket } from './tickets'

// Seen on scratch boards on 2026-11-20: three ready tickets behind a parked, a dropped and a missing blocker read as
// "3 ready ... Nothing is ready to start." and nothing said why. These name which ticket waits for which, and why.

export type Wait = { ticketId: string; words: string }

const MOST_WAITS_NAMED = 3

const NOT_DONE_YET = 'is not done yet'
const IN_REVIEW_UNTIL_LANDED = 'is in review, and only counts once it lands'

const blockerState = (blocker: Ticket | undefined): string => {
  if (blocker === undefined) return 'is not on the board'
  if (blocker.status === 'parked' || blocker.status === 'dropped') return `is ${blocker.status}`

  return blocker.status === 'review' ? IN_REVIEW_UNTIL_LANDED : NOT_DONE_YET
}

// A parked, dropped or missing blocker never clears by itself; one that is only not done yet will.
const isStuck = (state: string): boolean => state !== NOT_DONE_YET && state !== IN_REVIEW_UNTIL_LANDED

type Blocked = { ticketId: string; blockerId: string; state: string }

const blockedPairsOf = (ticket: Ticket, byId: ReadonlyMap<string, Ticket>, worktrees: boolean): Blocked[] =>
  ticket.blockedBy.flatMap(blockerId => {
    const blocker = byId.get(blockerId)

    return isBlockerMet(blocker, worktrees) ? [] : [{ ticketId: ticket.id, blockerId, state: blockerState(blocker) }]
  })

const ticketsById = (tickets: readonly Ticket[]): Map<string, Ticket> => new Map(tickets.map(ticket => [ticket.id, ticket]))

const waitOf = (pair: Blocked): Wait => ({ ticketId: pair.ticketId, words: `waits for ${pair.blockerId}, which ${pair.state}` })

export const blockerWaits = (ticket: Ticket, tickets: readonly Ticket[], worktrees = true): Wait[] =>
  blockedPairsOf(ticket, ticketsById(tickets), worktrees).map(waitOf)

const handWorkWait = (ticket: Ticket): Wait[] => (ticket.mode === 'hitl' ? [{ ticketId: ticket.id, words: 'is marked hitl, so no agent starts it' }] : [])

// With nothing able to start, every reason is news. With something to start, only a blocker that never clears is.
export const readyWaits = (tickets: readonly Ticket[], isAnythingStartable: boolean, worktrees = true): Wait[] => {
  const byId = ticketsById(tickets)
  const ready = inIdOrder(tickets.filter(ticket => ticket.status === 'ready'))
  const pairs = ready.flatMap(ticket => blockedPairsOf(ticket, byId, worktrees)).filter(pair => !isAnythingStartable || isStuck(pair.state))
  const blockerLines = pairs.map(waitOf)

  return isAnythingStartable ? blockerLines : [...blockerLines, ...ready.flatMap(handWorkWait)]
}

export const waitLines = (waits: readonly Wait[]): string[] => {
  const named = waits.slice(0, MOST_WAITS_NAMED).map(wait => `${wait.ticketId} ${wait.words}.`)
  const more = waits.length - named.length

  return more > 0 ? [...named, `And ${more} more like these.`] : named
}

// The count of ready tickets and the frontier are both true, so the sentence says how they fit together.
export const nothingStartsWords = (readyCount: number): string =>
  readyCount === 0 ? 'Nothing is ready to start.' : `Nothing is ready to start: of the ${readyCount} ready, none can start yet.`
