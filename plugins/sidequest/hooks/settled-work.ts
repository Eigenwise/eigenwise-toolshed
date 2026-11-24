import type { Ticket } from './tickets'

// Measured on 2026-11-20: at 2,000 tickets the list was 95,000 characters, and the host showed the model its first
// 2,000, every one a done ticket. Past this many tickets a list with no status leaves settled work out and counts it.
// At 50 lines the list is about 2,500 characters, so a board this small still lists exactly as it always did, and a
// board where most tickets are history stops paying for them on every read.
export const MOST_TICKETS_LISTED_WHOLE = 50

const SETTLED_STATUSES = ['done', 'parked', 'dropped']

export type ListedTickets = { shown: Ticket[]; settledLine: string[] }

const countWords = (count: number, status: string): string[] => (count === 0 ? [] : [`${count.toLocaleString('en-US')} ${status}`])

const settledCountLine = (settled: readonly Ticket[]): string[] => {
  const counts = SETTLED_STATUSES.flatMap(status => countWords(settled.filter(ticket => ticket.status === status).length, status))

  return counts.length === 0 ? [] : [`and ${counts.join(', ')}: list with a status to see them`]
}

export const withoutSettledWork = (tickets: readonly Ticket[]): ListedTickets => {
  if (tickets.length <= MOST_TICKETS_LISTED_WHOLE) return { shown: [...tickets], settledLine: [] }

  return {
    shown: tickets.filter(ticket => !SETTLED_STATUSES.includes(ticket.status)),
    settledLine: settledCountLine(tickets.filter(ticket => SETTLED_STATUSES.includes(ticket.status))),
  }
}
