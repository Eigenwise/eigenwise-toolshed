import { handleDetails } from './branch-and-issue'
import { isAnswerWithSession, ticketsWithThePerson } from './human-answers'
import type { InterruptedWork } from './interrupted-work'
import { NOTHING_WAS_CHECKED, wasFinishedUnchecked } from './nothing-checked'
import { headedTickets, NO_STORIES, OTHER_TICKETS_HEADING, piecesOfWork, spansSeveralPieces, ticketNameUnder, titleWithoutKey } from './pieces-of-work'
import type { BoardWork, HeadedTickets, StoriesAndCheckout } from './pieces-of-work'
import { WORDS_CHANGED_AFTER_THE_YES } from './saying-yes-to'
import { statusWords } from './status-words'
import { inIdOrder } from './tickets'
import type { Ticket } from './tickets'

// Ticket id to its status before this session first wrote it through the board's tools; undefined when this session
// created it. Kept in the module, so a reload forgets it and the report then names nothing of this session.
export type SessionChanges = ReadonlyMap<string, string | undefined>

export const NO_SESSION_CHANGES: SessionChanges = new Map()

const NOT_OPEN = ['done', 'parked', 'dropped']

// Seen in a real run: `NOTE-212 RF-2 (branch ..., pull request #1) NOTE-212 Search ...: waiting on you to done`, the
// key twice and a pair of statuses read as a sentence. A line says the status the ticket ended in.
const whatItEndedAs = (ticket: Ticket): string => `${statusWords(ticket.status)}${wasFinishedUnchecked(ticket) ? `, ${NOTHING_WAS_CHECKED}` : ''}`

const keyAndId = (ticket: Ticket): string => [ticket.issue ?? '', ticket.id].filter(part => part !== '').join(' ')

// The branch stays in the ticket view: passed as already known, it is left out and the pull request is said.
const detailsAfterStatus = (ticket: Ticket): string => {
  const details = handleDetails(ticket, ticket.branch)

  return details.length === 0 ? '' : ` (${details.join(', ')})`
}

const sessionLine = (ticket: Ticket): string =>
  `- ${keyAndId(ticket)} ${titleWithoutKey(ticket.title, ticket.issue)}: ${whatItEndedAs(ticket)}${detailsAfterStatus(ticket)}`

const sessionLinesUnder = (group: HeadedTickets): string[] => [
  group.heading,
  ...group.tickets.map(ticket => `- ${ticketNameUnder(ticket, group.piece)}: ${whatItEndedAs(ticket)}`),
]

const sessionLines = (changed: readonly Ticket[], board: BoardWork): string[] => {
  const grouped = piecesOfWork(changed, board)

  return spansSeveralPieces(grouped) ? headedTickets(grouped).flatMap(sessionLinesUnder) : inIdOrder(changed).map(sessionLine)
}

const sessionPart = (changes: SessionChanges, board: BoardWork): string[] => {
  const lines = sessionLines(board.tickets.filter(ticket => changes.has(ticket.id)), board)

  return lines.length === 0 ? ['This session changed nothing on the board.'] : ['What this session changed on the board:', ...lines]
}

// The report says waiting on you for the same tickets the band, the pane, the summary and the waiting view do.
type EarlierFacts = { interrupted: InterruptedWork; withThePerson: ReadonlySet<string> }

type EarlierCount = { words: string; counts: (ticket: Ticket, facts: EarlierFacts) => boolean }

const isWaiting = (ticket: Ticket, { interrupted, withThePerson }: EarlierFacts): boolean =>
  withThePerson.has(ticket.id) && !isAnswerWithSession(ticket) && !interrupted.has(ticket.id)

const isAnswered = (ticket: Ticket, { interrupted, withThePerson }: EarlierFacts): boolean =>
  withThePerson.has(ticket.id) && isAnswerWithSession(ticket) && !interrupted.has(ticket.id)

const isPlainOpen = (ticket: Ticket, { interrupted, withThePerson }: EarlierFacts): boolean =>
  !NOT_OPEN.includes(ticket.status) && !interrupted.has(ticket.id) && !withThePerson.has(ticket.id)

const EARLIER_COUNTS: EarlierCount[] = [
  { words: 'open', counts: isPlainOpen },
  { words: 'stopped', counts: (ticket, { interrupted }) => interrupted.has(ticket.id) },
  { words: 'waiting on you', counts: isWaiting },
  { words: 'answered, with the session to act on', counts: isAnswered },
  { words: 'set aside', counts: ticket => ticket.status === 'parked' },
]

const countWords = (tickets: readonly Ticket[], facts: EarlierFacts): string[] =>
  EARLIER_COUNTS.flatMap(({ words, counts }) => {
    const count = tickets.filter(ticket => counts(ticket, facts)).length

    return count === 0 ? [] : [`${count} ${words}`]
  })

const isCounted = (ticket: Ticket, facts: EarlierFacts): boolean => EARLIER_COUNTS.some(({ counts }) => counts(ticket, facts))

const pieceCount = (group: HeadedTickets, facts: EarlierFacts): string =>
  `${group.piece?.handle ?? OTHER_TICKETS_HEADING.toLowerCase()} (${countWords(group.tickets, facts).join(', ')})`

// One count line for the rest, never their titles: a list of old work read as a list of things to do. Several pieces
// of work are each named by their own handle, so the count says which work the rest belongs to.
const earlierPart = (changes: SessionChanges, interrupted: InterruptedWork, board: BoardWork): string[] => {
  const facts = { interrupted, withThePerson: new Set(ticketsWithThePerson(board.tickets, board.stories).map(ticket => ticket.id)) }
  const earlier = board.tickets.filter(ticket => !changes.has(ticket.id) && isCounted(ticket, facts))
  const grouped = piecesOfWork(earlier, board)
  if (spansSeveralPieces(grouped)) return [`Also on the board: ${headedTickets(grouped).map(group => pieceCount(group, facts)).join(', ')}.`]
  const parts = countWords(earlier, facts)

  return parts.length === 0 ? [] : [`Also on the board from before: ${parts.join(', ')}.`]
}

// The person said yes to the words they read, so any that went out changed are named, with what changed.
const wordsChangedAfterTheYes = (ticket: Ticket): string[] =>
  ticket.log.flatMap(line => {
    const at = line.indexOf(WORDS_CHANGED_AFTER_THE_YES)

    return at === -1 ? [] : [`Changed after your yes on ${keyAndId(ticket)} ${titleWithoutKey(ticket.title, ticket.issue)}: ${line.slice(at + WORDS_CHANGED_AFTER_THE_YES.length).trim()}.`]
  })

const changedAfterTheYesPart = (changes: SessionChanges, tickets: readonly Ticket[]): string[] =>
  inIdOrder(tickets.filter(ticket => changes.has(ticket.id))).flatMap(wordsChangedAfterTheYes)

export const closingReportText = (
  tickets: readonly Ticket[],
  changes: SessionChanges,
  interrupted: InterruptedWork,
  storiesAndCheckout: StoriesAndCheckout = NO_STORIES,
): string => {
  const board = { ...storiesAndCheckout, tickets, touched: new Set(changes.keys()) }

  return [...sessionPart(changes, board), ...changedAfterTheYesPart(changes, tickets), ...earlierPart(changes, interrupted, board)].join('\n')
}

// The status a ticket had before this session first touched it is what the report compares against, so a later write
// in the same session never replaces it.
export const withSessionChanges = (
  changes: SessionChanges,
  before: readonly Ticket[],
  written: readonly Ticket[],
): Map<string, string | undefined> => {
  const earlier = new Map(before.map(ticket => [ticket.id, ticket.status]))
  const next = new Map(changes)
  for (const ticket of written) if (!next.has(ticket.id)) next.set(ticket.id, earlier.get(ticket.id))

  return next
}
