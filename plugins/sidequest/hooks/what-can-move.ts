import { END_YOUR_TURN_LINE, finishNowLines, isReturnedNotRecorded } from './agent-returns'
import { A_WEEK, daysWords, lastTouchedOf, oldestAge } from './ages'
import type { BoardConfig } from './board-config'
import { ticketHandle } from './branch-and-issue'
import { parseForYou } from './for-you'
import { frontierOf } from './frontier'
import { isCheckpoint, ticketsWaitingOnThePerson } from './human-answers'
import { interruptedIn, interruptedLabel, NO_INTERRUPTED_WORK, NO_RUN_IN_THIS_SESSION } from './interrupted-work'
import type { InterruptedWork } from './interrupted-work'
import { headedTickets, NO_STORIES, piecesOfWork, spansSeveralPieces, ticketNameUnder } from './pieces-of-work'
import type { BoardWork, HeadedTickets, StoriesAndCheckout } from './pieces-of-work'
import { hasSharedThings, heldThingsFor, sharedThingWords, thingsUsedBy, waitsForWords } from './shared-things'
import { NO_ONE_ELSE_COMMITTED_LAST } from './team-work'
import { NOT_TO_PASTE } from './waiting-view'
import type { CommittedLastBySomeoneElse } from './team-work'
import { inIdOrder, oneLine, runDuration } from './tickets'
import type { Ticket } from './tickets'
import { mostBlockingFirst } from './waiting-view'

// While one ticket holds something that exists once, the person asks what else can move. These answer it from the
// board alone: what runs, what waits for a shared thing, what could start, and what the person could do themselves.

// The clause is for a project that named shared things. It once read "planning uses nothing shared": a person saw
// that twice in real sessions and had no idea what it referred to.
const sayWhatIsNext = (config: BoardConfig): string =>
  hasSharedThings(config) ? 'Say what you want next: it can be planned while this runs' : 'Say what you want next'


const named = (ticket: Ticket): string => `${ticketHandle(ticket)} ${ticket.title}`

const questionOf = (ticket: Ticket): string => oneLine(parseForYou(ticket.forYou).question) || ticket.title

// Ten month-old questions read like ten from today, so once the oldest has waited a week the line says how long.
const oldestWords = (questions: readonly Ticket[], now: number | undefined): string => {
  const oldest = now === undefined ? 0 : oldestAge(questions.map(lastTouchedOf), now)
  const which = questions.length === 1 ? 'waiting' : 'the oldest waiting'

  return oldest >= A_WEEK ? ` (${which} ${daysWords(oldest)})` : ''
}

const questionsLine = (tickets: readonly Ticket[], now?: number): string[] => {
  const questions = mostBlockingFirst(ticketsWaitingOnThePerson(tickets).filter(ticket => !isCheckpoint(ticket)), tickets)
  const [first] = questions
  if (first === undefined) return []
  const age = oldestWords(questions, now)

  return questions.length === 1
    ? [`Answer: ${questionOf(first)}${age}`]
    : [`Answer ${questions.length} questions that wait on you${age}, first: ${questionOf(first)}`]
}

// A checkpoint is something to look at only while it waits on the person: one behind work that is not built has
// nothing to show yet, whatever its status, and one they already answered is with the session.
const finishedChangesLine = (tickets: readonly Ticket[]): string[] => {
  const checkpointsDue = new Set(ticketsWaitingOnThePerson(tickets).filter(isCheckpoint).map(ticket => ticket.id))
  const isBuiltChange = (ticket: Ticket): boolean => ticket.status === 'review' && !isCheckpoint(ticket)
  const changes = inIdOrder(tickets.filter(ticket => isBuiltChange(ticket) || checkpointsDue.has(ticket.id)))
  const [first] = changes
  if (first === undefined) return []

  return changes.length === 1
    ? [`Look at what is finished: ${named(first)}`]
    : [`Look at ${changes.length} finished changes, first: ${named(first)}`]
}

// Only the ones that are true, in the order a person would take them. The pane shows these and nothing else.
export const whatThePersonCouldDo = (tickets: readonly Ticket[], now?: number): string[] => [
  ...questionsLine(tickets, now),
  ...finishedChangesLine(tickets),
]

// Describing the next thing is always possible, so a session asked what else can move always has one line to say.
const whatThePersonCouldDoOrSay = (tickets: readonly Ticket[], config: BoardConfig, now?: number): string[] => [
  ...whatThePersonCouldDo(tickets, now),
  sayWhatIsNext(config),
]

type Startable = { free: Ticket[]; waiting: Ticket[] }

export const startableTickets = (tickets: readonly Ticket[], config: BoardConfig): Startable => {
  const frontier = frontierOf(inIdOrder(tickets), config.settings.worktrees)
  const isHeld = (ticket: Ticket): boolean => heldThingsFor(ticket, tickets, config).length > 0

  return { free: frontier.filter(ticket => !isHeld(ticket)), waiting: frontier.filter(isHeld) }
}

const waitingWords = (ticket: Ticket, tickets: readonly Ticket[], config: BoardConfig): string =>
  `${named(ticket)} ${waitsForWords(heldThingsFor(ticket, tickets, config))}`

const holdsWords = (ticket: Ticket, config: BoardConfig): string => {
  const things = thingsUsedBy(ticket, config)

  return things.length === 0 ? '' : `is using the ${things.map(sharedThingWords).join(' and the ')}`
}

const runningWords = (ticket: Ticket, config: BoardConfig, stamp: string): string => {
  const duration = runDuration(ticket.log, stamp)

  return [named(ticket), duration === undefined ? '' : `running ${duration}`, holdsWords(ticket, config)].filter(part => part !== '').join(', ')
}

const listed = (heading: string, lines: readonly string[]): string[] =>
  lines.length === 0 ? [] : [heading, ...lines.map(line => `- ${line}`)]

const onlyThingInFlight = (config: BoardConfig): string =>
  hasSharedThings(config)
    ? 'Nothing else can move: this is the only thing in flight. You could still say what you want next: it can be planned while this runs.'
    : 'Nothing else can move: this is the only thing in flight. You could still say what you want next.'

const personPart = (running: readonly Ticket[], free: readonly Ticket[], tickets: readonly Ticket[], config: BoardConfig, now: number): string[] => {
  const personLines = whatThePersonCouldDoOrSay(tickets, config, now)
  const nothingElseMoves = running.length > 0 && free.length === 0 && personLines.length === 1

  return nothingElseMoves ? [onlyThingInFlight(config)] : listed('You could:', personLines)
}

// Under the heading "nothing runs them now", no run in this session would only say it again.
const withActivity = (name: string, activity: string | undefined): string =>
  activity === undefined || activity === NO_RUN_IN_THIS_SESSION ? name : `${name}, ${activity}`

const interruptedWords = (tickets: readonly Ticket[], interrupted: InterruptedWork, theirs: CommittedLastBySomeoneElse): string[] =>
  interruptedIn(tickets, interrupted)
    .filter(ticket => !theirs.has(ticket.id))
    .map(ticket => withActivity(named(ticket), interrupted.get(ticket.id)))

const theirsWords = (tickets: readonly Ticket[], theirs: CommittedLastBySomeoneElse): string[] =>
  inIdOrder(tickets).flatMap(ticket => {
    const name = theirs.get(ticket.id)

    return name === undefined ? [] : [`${named(ticket)}, ${name}'s work now`]
  })

type WhatMoves = {
  tickets: readonly Ticket[]
  config: BoardConfig
  stamp: string
  interrupted: InterruptedWork
  theirs: CommittedLastBySomeoneElse
  running: Ticket[]
} & Startable

const byStatusLines = (moves: WhatMoves): string[] => {
  const { tickets, config, stamp, interrupted, theirs, running, free, waiting } = moves

  return [
    ...listed('Running now:', running.map(ticket => runningWords(ticket, config, stamp))),
    ...listed('Stopped, nothing runs them now:', interruptedWords(tickets, interrupted, theirs)),
    ...listed('Interrupted on a branch someone else committed to last, so not offered to resume:', theirsWords(tickets, theirs)),
    ...listed('Waiting for something only one ticket can use at a time:', waiting.map(ticket => waitingWords(ticket, tickets, config))),
    ...listed('Could start now:', free.map(named)),
  ]
}

// Grouped by the piece of work, each line starts with what the ticket is, since no status heading says it any more.
type WhatATicketIs = { ticket: Ticket; what: string }

const runningWhat = (ticket: Ticket, config: BoardConfig, stamp: string): string => {
  const duration = runDuration(ticket.log, stamp)

  return [duration === undefined ? 'running' : `running ${duration}`, holdsWords(ticket, config)].filter(part => part !== '').join(', ')
}

const waitsBehindWhat = (ticket: Ticket, tickets: readonly Ticket[], config: BoardConfig): string =>
  waitsForWords(heldThingsFor(ticket, tickets, config))

const interruptedWhat = ({ tickets, interrupted, theirs }: WhatMoves): WhatATicketIs[] =>
  interruptedIn(tickets, interrupted)
    .filter(ticket => !theirs.has(ticket.id))
    .map(ticket => ({ ticket, what: interruptedLabel(interrupted.get(ticket.id) ?? '') }))

const theirsWhat = ({ tickets, theirs }: WhatMoves): WhatATicketIs[] =>
  inIdOrder(tickets).flatMap(ticket => {
    const name = theirs.get(ticket.id)

    return name === undefined ? [] : [{ ticket, what: `interrupted, ${name}'s work now` }]
  })

const whatEachTicketIs = (moves: WhatMoves): WhatATicketIs[] => [
  ...moves.running.map(ticket => ({ ticket, what: runningWhat(ticket, moves.config, moves.stamp) })),
  ...interruptedWhat(moves),
  ...theirsWhat(moves),
  ...moves.waiting.map(ticket => ({ ticket, what: waitsBehindWhat(ticket, moves.tickets, moves.config) })),
  ...moves.free.map(ticket => ({ ticket, what: 'could start' })),
]

const linesUnder = (group: HeadedTickets, whatTheyAre: readonly WhatATicketIs[]): string[] => [
  group.heading,
  ...whatTheyAre.filter(({ ticket }) => group.tickets.includes(ticket)).map(({ ticket, what }) => `- ${what}: ${ticketNameUnder(ticket, group.piece)}`),
]

const byPieceLines = (moves: WhatMoves, board: BoardWork): string[] | undefined => {
  const whatTheyAre = whatEachTicketIs(moves)
  const grouped = piecesOfWork(whatTheyAre.map(({ ticket }) => ticket), board)

  return spansSeveralPieces(grouped) ? headedTickets(grouped).flatMap(group => linesUnder(group, whatTheyAre)) : undefined
}

export const whatCanMoveText = (
  tickets: readonly Ticket[],
  config: BoardConfig,
  stamp: string,
  interrupted: InterruptedWork = NO_INTERRUPTED_WORK,
  theirs: CommittedLastBySomeoneElse = NO_ONE_ELSE_COMMITTED_LAST,
  touched: ReadonlySet<string> = new Set(),
  storiesAndCheckout: StoriesAndCheckout = NO_STORIES,
): string => {
  const running = inIdOrder(tickets.filter(ticket => ticket.status === 'doing' && !interrupted.has(ticket.id)))
  const moves: WhatMoves = { tickets, config, stamp, interrupted, theirs, running, ...startableTickets(tickets, config) }
  const workLines = byPieceLines(moves, { ...storiesAndCheckout, tickets, touched }) ?? byStatusLines(moves)

  return [
    ...(running.length === 0 ? ['Nothing is running.'] : []),
    ...workLines,
    ...personPart(running, moves.free, tickets, config, Date.parse(stamp)),
    ...sessionOnlyLines(tickets, running),
  ].join('\n')
}

const isStillOut = (ticket: Ticket): boolean => !isReturnedNotRecorded(ticket)

// The view is pasted to the person, so what only the session acts on comes last, under the marker that keeps it out.
const sessionOnlyLines = (tickets: readonly Ticket[], running: readonly Ticket[]): string[] => {
  const lines = [...finishNowLines(tickets), ...(running.some(isStillOut) ? [END_YOUR_TURN_LINE] : [])]

  return lines.length === 0 ? [] : [NOT_TO_PASTE, ...lines]
}

const alongsideWords = (free: readonly Ticket[]): string =>
  free.length === 0 ? 'Nothing else on the board can go alongside it.' : `Can go alongside without touching it: ${free.map(named).join(', ')}.`

const waitingBehindWords = (waiting: readonly Ticket[], tickets: readonly Ticket[], config: BoardConfig): string =>
  waiting.length === 0 ? '' : ` Waiting: ${waiting.map(ticket => waitingWords(ticket, tickets, config)).join(', ')}.`

const OFFER_ONLY =
  'Tell the person in one line how long this may take, what it holds and what can go alongside, and start only what they pick.'

// Said at the moment something long starts, so the session can offer the rest instead of starting it on its own.
export const alongsideNote = (started: Ticket, tickets: readonly Ticket[], config: BoardConfig): string => {
  const things = thingsUsedBy(started, config)
  if (things.length === 0) return ''
  const { free, waiting } = startableTickets(tickets, config)
  const holding = `${started.id} holds the ${things.join(' and the ')} for this run. ${alongsideWords(free)}${waitingBehindWords(waiting, tickets, config)}`

  const couldDo = `What the person could do now: ${whatThePersonCouldDoOrSay(tickets, config).join('. ')}.`

  return ['', holding, couldDo, ...(free.length === 0 ? [] : [OFFER_ONLY])].join('\n')
}
