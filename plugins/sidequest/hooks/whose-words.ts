import type { BoardChange } from './store'
import { appendLogLine, oneLine } from './tickets'
import type { Ticket } from './tickets'

export type TurnWords =
  | { source: 'person'; words: string }
  | { source: 'another session'; words: string }
  | { source: 'nobody typed' }
  | { source: 'other'; what: string; words: string }

export type PromptOriginSeen = { kind: string; asUser?: true }

export type PromptSeen = { text: string; turnId?: string; origin: PromptOriginSeen }

const PERSON_ORIGINS = new Set(['composer', 'sdk', 'bridge'])

const ANOTHER_SESSION_ORIGINS = new Set(['peer', 'peer-send-message'])

const OTHER_TURNS: Record<string, string> = {
  'scheduled-trigger': 'a scheduled run the person set up',
  'task-notification': 'a turn a finished background task started, in a run with nobody at the prompt',
}

const WORDS_KEPT = 200

// The board's own presses submit as the person (asUser), so a press on the pane is their word too.
const isPersonsPrompt = (origin: PromptOriginSeen): boolean =>
  PERSON_ORIGINS.has(origin.kind) || (origin.kind === 'plugin' && origin.asUser === true)

const otherTurn = (prompt: PromptSeen): TurnWords => ({
  source: 'other',
  what: OTHER_TURNS[prompt.origin.kind] ?? `a turn from ${prompt.origin.kind}, not typed by the person`,
  words: prompt.text,
})

const turnOfItsOwn = (prompt: PromptSeen, isInteractive: boolean): TurnWords => {
  if (ANOTHER_SESSION_ORIGINS.has(prompt.origin.kind)) return { source: 'another session', words: prompt.text }
  if (prompt.origin.kind === 'task-notification' && isInteractive) return { source: 'nobody typed' }

  return otherTurn(prompt)
}

// Undefined means the prompt changes nothing: a notification or a message folded into a turn already running. The
// person typing over a running turn is still the person.
export const turnWordsOf = (prompt: PromptSeen, isInteractive: boolean): TurnWords | undefined => {
  if (isPersonsPrompt(prompt.origin)) return { source: 'person', words: prompt.text }

  return prompt.turnId === undefined ? turnOfItsOwn(prompt, isInteractive) : undefined
}

export const NOBODY_TYPED_LINE =
  'Sidequest: nobody typed this turn, a background task finished. Report what finished, and continue only what it unblocks inside the plan the person started. Parked tickets, the inbox and a stopped plan wait for the person.'

export const nobodyTypedLine = (turn: TurnWords | undefined): string | undefined =>
  turn?.source === 'nobody typed' ? NOBODY_TYPED_LINE : undefined

const quoted = (words: string): string => {
  const line = oneLine(words)

  return JSON.stringify(line.length > WORDS_KEPT ? `${line.slice(0, WORDS_KEPT)}...` : line)
}

// How a log line says whose words a write happened on. The model never supplies these: they come from the prompt.
export const turnPhrase = (turn: TurnWords | undefined): string => {
  if (turn === undefined) return 'in a turn the board did not see start'
  if (turn.source === 'person') return `on the person's words: ${quoted(turn.words)}`
  if (turn.source === 'another session') return `on a message from another session: ${quoted(turn.words)}`
  if (turn.source === 'nobody typed') return 'in a turn nobody typed, which a finished background task started'

  return `in ${turn.what}: ${quoted(turn.words)}`
}

const UNASKED_FROM = ['parked', 'inbox']

export type TurnRecord = { tickets: Ticket[]; startedUnasked: string[] }

const leftStatus = (before: Ticket | undefined, after: Ticket, status: string): boolean =>
  before?.status === status && after.status !== status

const leftUnasked = (before: Ticket | undefined, after: Ticket): string | undefined =>
  UNASKED_FROM.find(status => leftStatus(before, after, status))

const lineForLeaving = (from: string | undefined, turn: TurnWords | undefined): string | undefined => {
  if (from === undefined) return undefined
  if (turn?.source === 'nobody typed') return `taken out of ${from} ${turnPhrase(turn)}`

  return from === 'parked' ? `taken out of parked ${turnPhrase(turn)}` : undefined
}

// Every write that takes a ticket out of parked carries the words of the turn it happened in. In a turn nobody typed
// the same goes for the inbox, and the person is told: nothing is refused, so this is how they find out.
export const withTurnRecord = (
  before: readonly Ticket[],
  change: BoardChange,
  turn: TurnWords | undefined,
  stamp: string,
): TurnRecord => {
  const earlier = new Map(before.map(ticket => [ticket.id, ticket]))
  const startedUnasked: string[] = []
  const tickets = change.tickets.map(ticket => {
    const line = lineForLeaving(leftUnasked(earlier.get(ticket.id), ticket), turn)
    if (line === undefined) return ticket
    if (turn?.source === 'nobody typed') startedUnasked.push(ticket.id)

    return appendLogLine(ticket, stamp, line)
  })

  return { tickets, startedUnasked }
}

export const startedUnaskedNotice = (ticketIds: readonly string[]): string =>
  `${ticketIds.join(', ')} started on ${ticketIds.length === 1 ? 'its' : 'their'} own after a background task finished, not by you. To undo, open ${ticketIds.length === 1 ? 'it' : 'each'} on the board and press Set aside.`
