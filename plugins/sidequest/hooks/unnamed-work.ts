import { MOST_INBOX_NAMED } from './inbox-age'
import type { Ticket } from './tickets'

const HOW_TO_SEE_THEM = 'To see them: ask for the done, parked or inbox list, or type /board.'

const countWords = (tickets: readonly Ticket[], status: string, words: string): string[] => {
  const count = tickets.filter(ticket => ticket.status === status).length

  return count === 0 ? [] : [`${count} ${words}`]
}

// Done work this session touched is on the closing report already, so only earlier work is counted. Dropped work is not.
export const alsoOnBoardLines = (tickets: readonly Ticket[], touchedThisSession: ReadonlySet<string>): string[] => {
  const untouched = tickets.filter(ticket => !touchedThisSession.has(ticket.id))
  const counts = [...countWords(untouched, 'done', 'done earlier'), ...countWords(tickets, 'parked', 'parked')]

  return counts.length === 0 ? [] : [`Also on the board: ${counts.join(', ')}.`]
}

export const withHowToSee = (inboxLines: readonly string[], alsoLines: readonly string[], inboxCount: number): string[] => {
  if (alsoLines.length > 0) return [...inboxLines, `${alsoLines[0]} ${HOW_TO_SEE_THEM}`]
  if (inboxLines.length > 0 && inboxCount > MOST_INBOX_NAMED) return [`${inboxLines[0]} ${HOW_TO_SEE_THEM}`]

  return [...inboxLines]
}
