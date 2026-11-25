import type { AnswerOption, BoardCard, LiveAgents, ProposedTicket, SayingYesToShown, SidequestRun, StoryDetail, StoryToRead, TicketDetail } from '../../types'
import { A_WEEK, daysWords, lastTouchedOf, oldestAge } from '../ages'
import { isReturnedNotRecorded } from '../agent-returns'
import type { BoardConfig } from '../board-config'
import { handleDetails } from '../branch-and-issue'
import { namedDecisionsOnly } from '../brief'
import { decisionsForYouLines } from '../decisions-for-you'
import { fencedDiffOf } from '../code-path'
import { droppedBlockerIds, dropWordsFor, SET_ASIDE_WORDS } from '../drop'
import { isFromEarlierWork } from '../earlier-work'
import { alsoYoursText, optionLetter, parseForYou } from '../for-you'
import { commitSummaryLines, decisionsAsDrawn, destinationLead, destinationRest, takenByDefaultRows } from './first-screen'
import type { ForYou } from '../for-you'
import { NO_STORIES, OTHER_TICKETS_HEADING, pieceOfEachTicket, shortPieceName } from '../pieces-of-work'
import type { BoardWork, PieceOfATicket } from '../pieces-of-work'
import { awaitsHumanAnswer, canBeApproved, isAnswerWithSession, ticketsWithThePerson } from '../human-answers'
import { NO_INTERRUPTED_WORK } from '../interrupted-work'
import { proposedTicketsOf } from '../proposed-tickets'
import { diffOfHunks, hasAfterTheReview, hasSayingYesTo, PART_NAMES, SAYING_YES_TO_PARTS } from '../saying-yes-to'
import type { SayingYesTo, SayingYesToPart } from '../saying-yes-to'
import type { InterruptedWork } from '../interrupted-work'
import { shortModelName } from '../routing'
import { heldThingsFor, shortWaitsForWords } from '../shared-things'
import type { PublishedSummary } from '../summary'
import { REVIEW_WORDS_IN_A_COUNT, statusWords } from '../status-words'
import { inIdOrder, lastStartStamp, oneLine } from '../tickets'
import type { Story, Ticket } from '../tickets'
import { forYouLines, recommendedAnswer } from '../waiting-view'
import { permissionWaitText, runningTicketCount } from './running-agents'
import type { BoardActivity } from './running-agents'
import { tablesAsLines } from './tables-as-lines'

export type FinishedRun = { id: string; outcome: string }

export type TicketPresses = { canApprove: boolean; canSetAside: boolean; canDrop: boolean }

const STATUSES_THAT_ARE_OVER = ['done', 'dropped']

export const ticketPresses = (detail: Pick<TicketDetail, 'status' | 'canBeApproved'>): TicketPresses => {
  const isOpen = !STATUSES_THAT_ARE_OVER.includes(detail.status)

  return { canApprove: detail.canBeApproved, canSetAside: isOpen && detail.status !== 'parked', canDrop: isOpen }
}

const APPROVE_WORDS = 'Approve: you looked and it is right, so what it blocks carries on.'
export const pressWords = (presses: TicketPresses, dropWords: string): string =>
  [presses.canApprove ? APPROVE_WORDS : '', presses.canSetAside ? SET_ASIDE_WORDS : '', presses.canDrop ? dropWords : ''].filter(words => words !== '').join(' ')

const placeOf = (ticket: Ticket): Pick<BoardCard, 'issue' | 'branch' | 'startedBy' | 'pullRequest'> => ({
  ...(ticket.issue === undefined ? {} : { issue: ticket.issue }),
  ...(ticket.branch === undefined ? {} : { branch: ticket.branch }),
  ...(ticket.startedBy === undefined ? {} : { startedBy: ticket.startedBy }),
  ...(ticket.pullRequest === undefined ? {} : { pullRequest: ticket.pullRequest }),
})

const runFacts = (ticket: Ticket, tickets: readonly Ticket[], config: BoardConfig): Pick<BoardCard, 'startedAt' | 'waitsFor'> => {
  const startedAt = ticket.status === 'doing' ? lastStartStamp(ticket.log) : undefined
  const held = ticket.status === 'ready' ? heldThingsFor(ticket, tickets, config) : []

  return {
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(held.length === 0 ? {} : { waitsFor: shortWaitsForWords(held) }),
  }
}

const interruptedFact = (ticket: Ticket, interrupted: InterruptedWork): Pick<BoardCard, 'interrupted'> => {
  const words = interrupted.get(ticket.id)

  return words === undefined ? {} : { interrupted: words }
}

const ageFacts = (ticket: Ticket, tickets: readonly Ticket[]): Pick<BoardCard, 'lastTouched' | 'droppedBlockers'> => {
  const lastTouched = lastTouchedOf(ticket)
  const droppedBlockers = droppedBlockerIds(ticket, tickets)

  return {
    ...(lastTouched === '' ? {} : { lastTouched }),
    ...(droppedBlockers.length === 0 ? {} : { droppedBlockers }),
  }
}

const answerFact = (ticket: Ticket): Pick<BoardCard, 'answerIsWithSession'> => (isAnswerWithSession(ticket) ? { answerIsWithSession: true } : {})

type CardFacts = {
  tickets: readonly Ticket[]
  config: BoardConfig
  interrupted: InterruptedWork
  pieces: ReadonlyMap<string, PieceOfATicket>
  theirsToDoNow: ReadonlySet<string>
}

const pieceFact = (ticket: Ticket, pieces: ReadonlyMap<string, PieceOfATicket>): Pick<BoardCard, 'piece'> => {
  const piece = pieces.get(ticket.id)

  return piece === undefined ? {} : { piece }
}

const cardOf = (ticket: Ticket, { tickets, config, interrupted, pieces, theirsToDoNow }: CardFacts): BoardCard => {
  const forYou = parseForYou(ticket.forYou)
  const question = oneLine(forYou.question)
  const recommended = recommendedAnswer(forYou)

  return {
    id: ticket.id,
    title: ticket.title,
    status: ticket.status,
    category: ticket.category,
    updated: ticket.updated,
    ...(isReturnedNotRecorded(ticket) ? { isReturnedNotRecorded: true } : {}),
    ...answerFact(ticket),
    ...(theirsToDoNow.has(ticket.id) ? { isTheirsToDoNow: true } : {}),
    ...(question ? { question } : {}),
    ...(recommended ? { recommended } : {}),
    ...placeOf(ticket),
    ...runFacts(ticket, tickets, config),
    ...interruptedFact(ticket, interrupted),
    ...ageFacts(ticket, tickets),
    ...pieceFact(ticket, pieces),
  }
}

export type WorkAroundTheTickets = Omit<BoardWork, 'tickets'>

const NO_WORK_AROUND: WorkAroundTheTickets = { ...NO_STORIES, touched: new Set() }

export const boardCards = (
  tickets: readonly Ticket[],
  config: BoardConfig,
  interrupted: InterruptedWork = NO_INTERRUPTED_WORK,
  workAround: WorkAroundTheTickets = NO_WORK_AROUND,
): BoardCard[] => {
  const theirs = ticketsWithThePerson(tickets, workAround.stories).filter(ticket => ticket.mode === 'hitl')
  const facts: CardFacts = {
    tickets,
    config,
    interrupted,
    pieces: pieceOfEachTicket({ ...workAround, tickets }),
    theirsToDoNow: new Set(theirs.map(ticket => ticket.id)),
  }

  return tickets.map(ticket => cardOf(ticket, facts))
}

// Seen in a review: a ticket with the person was left out of the count of work in progress and still counted here,
// so its agent made a stopped ticket read as running. The two lists hold the same tickets the count does.
export const doingTicketsIn = (cards: readonly BoardCard[] | null): string[] =>
  (cards ?? []).filter(card => card.status === 'doing' && !isWaitingCard(card)).map(card => card.id)

export const returnedTicketsIn = (cards: readonly BoardCard[] | null): string[] =>
  (cards ?? []).filter(card => card.isReturnedNotRecorded && !isWaitingCard(card)).map(card => card.id)

const agentsRunning = (count: number): string => (count === 1 ? '1 agent running' : `${count} agents running`)

// Read as `agents 7 opus` before: count and model ran together and nothing said the agents were running.
export const agentModelCounts = (agents: LiveAgents): string => {
  const models = Object.values(agents).map(agent => shortModelName(agent.model))
  if (models.length === 0) return ''
  const counts = new Map<string, number>()
  for (const model of models) counts.set(model, (counts.get(model) ?? 0) + 1)
  if (counts.size === 1) return `${agentsRunning(models.length)} on ${models[0]}`

  return `${agentsRunning(models.length)}: ${[...counts].map(([model, count]) => `${count} ${model}`).join(', ')}`
}

const countWords = (count: number, words: string): string => (count > 0 ? `${count} ${words}` : '')

type TicketCount = { count: number; words: string }

const ticketsWord = (count: number): string => (count === 1 ? 'ticket' : 'tickets')

// The first count names what is counted, and the rest follow it in one phrase: 2 tickets ready to start, 1 running.
const ticketPhrase = (counts: readonly TicketCount[]): string =>
  counts
    .filter(part => part.count > 0)
    .map((part, index) => (index === 0 ? `${part.count} ${ticketsWord(part.count)} ${part.words}` : `${part.count} ${part.words}`))
    .join(', ')

// Only a doing ticket whose own agent is alive is running. One whose agent returned waits for its result to be
// recorded. Any other was left behind by a session that ended, and an unrelated agent being alive says nothing about it.
const doingCounts = (summary: PublishedSummary, activity: BoardActivity): TicketCount[] => {
  const running = Math.min(runningTicketCount(activity), summary.doing)
  const returned = Math.min(activity.returnedTickets.length, summary.doing - running)
  const leftBehind = summary.doing - running - returned

  return [
    { count: running, words: 'running' },
    { count: returned, words: 'back, result not written up yet' },
    { count: leftBehind, words: 'stopped' },
  ]
}

const fromEarlierWork = (summary: PublishedSummary): number => summary.needsYouFromEarlierWork ?? 0

const warnedAbout = (summary: PublishedSummary): number => summary.needsYou - fromEarlierWork(summary)

const plansWaiting = (summary: PublishedSummary): number => summary.plansWaiting ?? 0

// The pane's Being checked section lists the tickets the board read named; a summary with no such list counts every built ticket.
const beingChecked = (summary: PublishedSummary, activity: BoardActivity): number => activity.beingCheckedTickets?.length ?? summary.review

export const bandCounts = (summary: PublishedSummary, activity: BoardActivity): string =>
  [
    ticketPhrase([{ count: summary.ready, words: statusWords('ready') }, ...doingCounts(summary, activity), { count: beingChecked(summary, activity), words: REVIEW_WORDS_IN_A_COUNT }]),
    agentModelCounts(activity.agents),
  ]
    .filter(part => part !== '')
    .join('  ')

// A month-old question looked like one from today, so once the oldest has waited a week the band says how long.
const oldestWaitingWords = (count: number, activity: BoardActivity): string => {
  const oldest = activity.oldestWaitingMs ?? 0
  if (oldest < A_WEEK) return ''

  return count === 1 ? `, waiting ${daysWords(oldest)}` : `, the oldest waiting ${daysWords(oldest)}`
}

const needsYouWords = (count: number): string => (count === 1 ? '1 ticket needs you' : `${count} tickets need you`)

const plansNeedYouWords = (count: number): string => (count === 1 ? '1 plan needs you' : `${count} plans need you`)

const touchedStamp = (card: BoardCard): string => card.lastTouched ?? card.updated

export const isWaitingCard = (card: BoardCard): boolean =>
  (card.status === 'needs-you' || card.isTheirsToDoNow === true) && card.answerIsWithSession !== true

export const isCardFromEarlierWork = (card: BoardCard, touchedHere: ReadonlySet<string>, now: number): boolean =>
  isWaitingCard(card) && isFromEarlierWork(card.id, touchedStamp(card), touchedHere, now)

export const oldestWaitingOf = (cards: readonly BoardCard[], now: number, touchedHere: ReadonlySet<string> = new Set()): number =>
  oldestAge(
    cards.filter(card => isWaitingCard(card) && !isCardFromEarlierWork(card, touchedHere, now)).map(touchedStamp),
    now,
  )

type CardPiece = NonNullable<BoardCard['piece']>

const byPieceOrder = (left: CardPiece, right: CardPiece): number => left.order - right.order

const LONGEST_PIECE_NAME = 30

const bandPieceName = (piece: CardPiece): string => {
  const name = shortPieceName(piece)

  return name.length <= LONGEST_PIECE_NAME ? name : `${name.slice(0, LONGEST_PIECE_NAME - 3).trimEnd()}...`
}

const OTHER_TICKETS_NAME = OTHER_TICKETS_HEADING.toLowerCase()

// In the board's order of work, so the band names the work this session is on first. Tickets of no piece are named
// last, so every ticket the band counts is in a name it reads.
export const piecesWaitingOnYou = (cards: readonly BoardCard[], now: number, touchedHere: ReadonlySet<string>): string[] => {
  const waiting = cards.filter(card => isWaitingCard(card) && !isCardFromEarlierWork(card, touchedHere, now))
  const byOrder = new Map<number, CardPiece>()
  for (const { piece } of waiting) if (piece !== undefined) byOrder.set(piece.order, piece)
  const named = [...byOrder.values()].sort(byPieceOrder).map(bandPieceName)

  return waiting.some(card => card.piece === undefined) ? [...named, OTHER_TICKETS_NAME] : named
}

const MOST_PIECES_NAMED = 3

// With one piece of work in flight the person knows which it is, so only several are named.
const piecesNamed = (activity: BoardActivity): string => {
  const pieces = activity.piecesWaitingOnYou ?? []
  if (pieces.length <= 1) return ''
  const named = pieces.slice(0, MOST_PIECES_NAMED).join(', ')

  return pieces.length > MOST_PIECES_NAMED ? `: ${named} and ${pieces.length - MOST_PIECES_NAMED} more` : `: ${named}`
}

const ticketsNeedYouWarning = (summary: PublishedSummary, activity: BoardActivity): string => {
  const count = warnedAbout(summary)

  return count > 0 ? `${needsYouWords(count)}${oldestWaitingWords(count, activity)}${piecesNamed(activity)}` : ''
}

const plansNeedYouWarning = (summary: PublishedSummary): string => (plansWaiting(summary) > 0 ? plansNeedYouWords(plansWaiting(summary)) : '')

// Said with what warns, not with the counts the narrow band drops: a person who asks what waits on them reads all of it first.
const fromEarlierSessionsWarning = (summary: PublishedSummary): string => countWords(fromEarlierWork(summary), 'waiting on you from earlier sessions')

const needsYouWarning = (summary: PublishedSummary, activity: BoardActivity): string =>
  [ticketsNeedYouWarning(summary, activity), plansNeedYouWarning(summary), fromEarlierSessionsWarning(summary)].filter(part => part !== '').join(', ')

export const bandWarnings = (summary: PublishedSummary, activity: BoardActivity): string =>
  [needsYouWarning(summary, activity), permissionWaitText(activity.waits, activity.runs)]
    .filter(part => part !== '')
    .join('  ')

export type BandLine = { warnings: string; counts: string }

export const OPEN_BOARD_LABEL = 'open board'

const bandWidth = (line: BandLine): number =>
  [line.warnings, line.counts, OPEN_BOARD_LABEL].filter(part => part !== '').join('  ').length

// Beside a docked pane the band has little room, and a wrapped band breaks mid-word into fragments. What waits on the
// person and what runs are what a glance needs; the rest is one press away in the pane.
// Tickets and permission prompts both wait here, so the narrow band counts them without naming either.
const waitingOnYou = (count: number): string => (count === 1 ? '1 needs you' : countWords(count, 'need you'))

const narrowBand = (summary: PublishedSummary, activity: BoardActivity): BandLine => {
  const agentCount = Object.keys(activity.agents).length

  return {
    warnings: waitingOnYou(warnedAbout(summary) + plansWaiting(summary) + fromEarlierWork(summary) + Object.keys(activity.waits).length),
    counts: agentCount > 0 ? agentsRunning(agentCount) : '',
  }
}

// The ticket counts go first when room runs out: they are one press away in the pane, and what runs is not.
export const bandLine = (summary: PublishedSummary, activity: BoardActivity, columns: number): BandLine => {
  const warnings = bandWarnings(summary, activity)
  const wide = { warnings, counts: bandCounts(summary, activity) }
  const withoutTicketCounts = { warnings, counts: agentModelCounts(activity.agents) }

  return [wide, withoutTicketCounts].find(line => bandWidth(line) < columns) ?? narrowBand(summary, activity)
}

export const widgetCounts = (summary: PublishedSummary): string =>
  `${summary.needsYou + plansWaiting(summary)} need you, ${summary.ready} ${statusWords('ready')}, ${summary.doing} ${statusWords('doing')}, ${summary.review} ${REVIEW_WORDS_IN_A_COUNT}`

const optionalFacts = (ticket: Ticket): string[] => [
  ticket.story ? `story ${ticket.story}` : '',
  ticket.blockedBy.length > 0 ? `blocked by ${ticket.blockedBy.join(' and ')}` : '',
]

const nameOnBranch = (ticket: Ticket): string => {
  const name = [ticket.issue ?? '', ticket.id].filter(part => part !== '').join(' ')

  return ticket.branch === undefined ? name : `${name} on branch ${ticket.branch}`
}

const statusFact = (ticket: Ticket): string => (isAnswerWithSession(ticket) ? 'answered, with the session to act on' : statusWords(ticket.status))

// Kind, mode and category are routing words for the model: a person reading the ticket has no use for them.
const factsLine = (ticket: Ticket): string =>
  [nameOnBranch(ticket), ...handleDetails(ticket, ticket.branch), statusFact(ticket), ...optionalFacts(ticket), `updated ${ticket.updated}`]
    .filter(fact => fact !== '')
    .join(', ')

const answerOptions = (forYou: ForYou): AnswerOption[] =>
  forYou.options.map((option, index) => ({ key: `option-${optionLetter(index)}`, label: `${optionLetter(index)}. ${oneLine(option.label)}` }))

const markdownSection = (heading: string, text: string): string => (text.trim() === '' ? '' : `## ${heading}\n${text.trim()}`)

// The decisions live on the story. Without it the ids the ticket names are all there is to show.
const decisionsOf = (ticket: Ticket, story: Story | undefined): string =>
  story === undefined ? ticket.decisions.join(', ') : decisionsAsDrawn(namedDecisionsOnly(story.decisions, ticket.decisions))

// The log is the model's audit trail and the For you section is drawn line by line above, so neither is in the body.
const bodyForThePerson = (ticket: Ticket, story: Story | undefined): string =>
  [markdownSection('What', ticket.what), markdownSection('Done when', ticket.doneWhen), markdownSection('Already decided', decisionsOf(ticket, story))]
    .filter(section => section !== '')
    .join('\n\n')

const DRAWN_AS: Record<SayingYesToPart, SayingYesToShown['drawnAs']> = {
  changed: 'markdown',
  checked: 'markdown',
  hunks: 'diff',
  reviewFound: 'markdown',
  commitMessage: 'words',
  pullRequestTitle: 'words',
  pullRequestDescription: 'markdown',
}

const sayingYesToShown = (parts: SayingYesTo): SayingYesToShown[] =>
  SAYING_YES_TO_PARTS.filter(part => parts[part].trim() !== '').map(part => ({
    key: `yes-to-${part}`,
    heading: PART_NAMES[part],
    text: part === 'hunks' ? diffOfHunks(parts.hunks) : parts[part],
    drawnAs: DRAWN_AS[part],
  }))

const sentAnswerOf = (ticket: Ticket): Pick<TicketDetail, 'answerSent' | 'answerSentAt'> => ({
  answerSent: ticket.answerSent ?? '',
  answerSentAt: ticket.answerSentAt ?? '',
})

export const ticketDetail = (ticket: Ticket, story?: Story): TicketDetail => {
  const { diff, withoutDiff } = fencedDiffOf(ticket.forYou)
  const forYou = parseForYou(withoutDiff)
  const takesAnswer = awaitsHumanAnswer(ticket)

  return {
    diff,
    sayingYesTo: sayingYesToShown(forYou.sayingYesTo),
    isStillReviewed: hasSayingYesTo(forYou.sayingYesTo) && !hasAfterTheReview(forYou.sayingYesTo),
    summary: hasAfterTheReview(forYou.sayingYesTo) ? commitSummaryLines(ticket, forYou.sayingYesTo) : [],
    id: ticket.id,
    title: ticket.title,
    status: ticket.status,
    canBeApproved: canBeApproved(ticket),
    facts: factsLine(ticket),
    question: oneLine(forYou.question),
    forYouLines: forYouLines({ ...forYou, question: '', alsoYours: [] }),
    alsoYours: forYou.alsoYours.map(alsoYoursText),
    dropWords: dropWordsFor(ticket),
    options: takesAnswer ? answerOptions(forYou) : [],
    body: bodyForThePerson(ticket, story),
    takesAnswer,
    ...sentAnswerOf(ticket),
  }
}

const proposedTicketOf = (ticket: Ticket, changed: ReadonlySet<string>): ProposedTicket => ({
  id: ticket.id,
  title: ticket.title,
  what: tablesAsLines(ticket.what),
  doneWhen: ticket.doneWhen,
  ...(changed.has(ticket.id) ? { changed: true } : {}),
})

const NOTHING_CHANGED: ReadonlySet<string> = new Set()

export const storyDetail = (story: Story, tickets: readonly Ticket[] = [], changed: ReadonlySet<string> = NOTHING_CHANGED): StoryDetail => ({
  id: story.id,
  title: story.title,
  inShort: tablesAsLines(story.inShort),
  destination: story.destination,
  analysis: tablesAsLines(story.analysis),
  path: story.path,
  excerpts: story.excerpts,
  decisionsForYou: decisionsForYouLines(story.questions),
  decided: decisionsAsDrawn(story.decisions),
  destinationLead: destinationLead(story.destination),
  destinationRest: destinationRest(story.destination),
  takenByDefault: takenByDefaultRows(story.decisions),
  proposedTickets: inIdOrder(proposedTicketsOf(story, tickets)).map(ticket => proposedTicketOf(ticket, changed)),
  decisionPicksSent: story.decisionPicksSent ?? [],
  decisionWordsSent: story.decisionWordsSent ?? '',
  playbackAnswerSent: story.playbackAnswerSent ?? '',
})

const isOpenTicketOf = (story: Story) => (ticket: Ticket): boolean => ticket.story === story.id && !STATUSES_THAT_ARE_OVER.includes(ticket.status)

// An analysis is read while the work is being agreed and built. A story whose tickets are all over, or one left with
// no ticket for a week, is not offered again; its file still holds it.
const isBeingWorkedOn = (story: Story, tickets: readonly Ticket[], now: number): boolean => {
  if (tickets.some(isOpenTicketOf(story))) return true

  return !tickets.some(ticket => ticket.story === story.id) && now - Date.parse(story.updated) < A_WEEK
}

const hasSomethingToRead = (story: Story): boolean => story.analysis !== '' || story.inShort !== '' || story.questions.length > 0 || story.awaitsYes === true

// From the person's send on, what they sent waits on the session and no longer on them.
const decisionsWaiting = (story: Story): number => (story.decisionPicksSent === undefined ? story.questions.length : 0)

const yesWaits = (story: Story): boolean => story.awaitsYes === true && story.playbackAnswerSent === undefined

const hasAnswersWithSession = (story: Story): boolean => story.decisionPicksSent !== undefined || story.playbackAnswerSent !== undefined

const storyToRead = (story: Story): StoryToRead => ({
  id: story.id,
  title: story.title,
  openQuestions: decisionsWaiting(story),
  ...(yesWaits(story) ? { awaitsYes: true } : {}),
  ...(hasAnswersWithSession(story) ? { answersWithSession: true } : {}),
})

// Open decisions, or the yes on the proposed tickets, that the person has not sent.
export const isStoryWaitingOnThePerson = (story: StoryToRead): boolean => story.openQuestions > 0 || story.awaitsYes === true

export const storiesToRead = (stories: readonly Story[], tickets: readonly Ticket[], now: number): StoryToRead[] =>
  stories.filter(story => hasSomethingToRead(story) && isBeingWorkedOn(story, tickets, now)).map(storyToRead)

// A ticket asked again after the person's send waits anew, so it is said again.
const wasWaitingIn = (cards: readonly BoardCard[], id: string): boolean => cards.some(card => card.id === id && isWaitingCard(card))

// `key` names the notification, so a later one about the same ticket replaces it where the host keeps them.
export type BoardNotice = { text: string; key: string }

const needsYouArrivals = (before: readonly BoardCard[] | null, after: readonly BoardCard[]): BoardNotice[] => {
  if (before === null) return []

  return after
    .filter(card => isWaitingCard(card) && !wasWaitingIn(before, card.id))
    .map(card => ({ text: `Needs you: ${card.title} (${card.id})`, key: `needs-you-${card.id}` }))
}

const FINISH_WORDS: Record<string, string> = { done: 'Finished', failed: 'Run failed' }

// "Finished: ..., now built, being checked" says it was done twice.
const statusAfterFinish = (status: string): string => (status === 'review' ? REVIEW_WORDS_IN_A_COUNT : `now ${statusWords(status)}`)

const finishNotice = (run: FinishedRun, after: readonly BoardCard[]): BoardNotice[] => {
  const word = FINISH_WORDS[run.outcome]
  const card = after.find(one => one.id === run.id)
  if (!word || !card) return []

  return [{ text: `${word}: ${card.title} (${card.id}), ${statusAfterFinish(card.status)}`, key: `finished-${card.id}` }]
}

// A finish call finishes one run; a board repair can finish several in one write.
export const boardNotices = (
  before: readonly BoardCard[] | null,
  after: readonly BoardCard[],
  finished: readonly FinishedRun[],
): BoardNotice[] => [...finished.flatMap(run => finishNotice(run, after)), ...needsYouArrivals(before, after)]
