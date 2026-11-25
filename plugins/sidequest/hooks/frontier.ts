import type { Ticket } from './tickets'

const REVIEW_NOTE = /^\S+ note review (pass|fail|failed|failure|skipped)\b/

export const lastReviewOutcome = (ticket: Ticket): string | undefined => {
  const lastNote = ticket.log.findLast(line => REVIEW_NOTE.test(line))

  return lastNote === undefined ? undefined : REVIEW_NOTE.exec(lastNote)?.[1]
}

const isReviewedOk = (blocker: Ticket): boolean => {
  const outcome = lastReviewOutcome(blocker)

  return blocker.status === 'review' && (outcome === 'pass' || outcome === 'skipped')
}

// A ticket only becomes done when it lands. With worktrees off every run commits in the one checkout, so a blocker that
// passed its review already has its work where the blocked ticket will run. With worktrees on it does not until it lands.
export const isBlockerMet = (blocker: Ticket | undefined, worktrees = true): boolean =>
  blocker?.status === 'done' || (blocker !== undefined && !worktrees && isReviewedOk(blocker))

export const frontierOf = (tickets: readonly Ticket[], worktrees = true): Ticket[] => {
  const byId = new Map(tickets.map(ticket => [ticket.id, ticket]))

  return tickets.filter(
    ticket =>
      ticket.status === 'ready' && ticket.mode === 'afk' && ticket.blockedBy.every(id => isBlockerMet(byId.get(id), worktrees)),
  )
}
