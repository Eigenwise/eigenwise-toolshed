import { A_DAY, A_WEEK, daysWords, oldestAge } from './ages'
import { inIdOrder, oneLine } from './tickets'
import type { Ticket } from './tickets'

// Seen on a scratch board on 2026-11-20: with 200 tickets in the inbox, the oldest 60 days, the summary said only that
// nothing was ready to start. The inbox is named when nothing else can start or when it has sat for a week.
// Seen on a first session: "1 in the inbox" gave the person nothing to open, so the oldest few are named.

export const MOST_INBOX_NAMED = 3

const oldestWords = (oldest: number, inboxCount: number): string => {
  if (oldest < A_DAY) return inboxCount === 1 ? 'from the last day' : 'all from the last day'

  return inboxCount === 1 ? `${daysWords(oldest)} old` : `the oldest ${daysWords(oldest)} old`
}

// A ticket with no readable date is taken as new, so it never pushes a dated one off the line.
const createdAt = (ticket: Ticket): number => Date.parse(ticket.created) || Number.POSITIVE_INFINITY

const oldestFirst = (inbox: readonly Ticket[]): Ticket[] =>
  inIdOrder(inbox).sort((left, right) => (createdAt(left) === createdAt(right) ? 0 : createdAt(left) - createdAt(right)))

const LONGEST_TITLE_NAMED = 60

const shortTitle = (title: string): string => {
  const whole = oneLine(title)

  return whole.length <= LONGEST_TITLE_NAMED ? whole : `${whole.slice(0, LONGEST_TITLE_NAMED - 3)}...`
}

const namedTickets = (inbox: readonly Ticket[]): string => {
  const named = oldestFirst(inbox).slice(0, MOST_INBOX_NAMED).map(ticket => `${shortTitle(ticket.title)} (${ticket.id})`)
  const more = inbox.length - MOST_INBOX_NAMED

  return more > 0 ? `${named.join(', ')}, and ${more} more` : named.join(', ')
}

export const inboxLines = (tickets: readonly Ticket[], isNothingStartable: boolean, now: number): string[] => {
  const inbox = tickets.filter(ticket => ticket.status === 'inbox')
  const oldest = oldestAge(inbox.map(ticket => ticket.created), now)
  const isWorthSaying = inbox.length > 0 && (isNothingStartable || oldest >= A_WEEK)

  return isWorthSaying ? [`${inbox.length} in the inbox, ${oldestWords(oldest, inbox.length)}: ${namedTickets(inbox)}.`] : []
}
