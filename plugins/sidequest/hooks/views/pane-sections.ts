import type { BoardCard, FinishedAgent, SessionWork, StoryDetail, StoryToRead } from '../../types'
import { A_WEEK, daysWords } from '../ages'
import { spokenDuration } from '../agent-returns'
import { finishedAgentAside, isJustFinished, newestReturnFirst } from './finished-agents'
import { sessionAside } from '../session-activity'
import { spokenAgo } from '../interrupted-work'
import { handleUnder, OTHER_TICKETS_HEADING, pieceHeading, shortPieceName, titleWithoutKey } from '../pieces-of-work'
import { isCardFromEarlierWork, isStoryWaitingOnThePerson, isWaitingCard } from './board-view'
import { idNumber, spokenMinutes } from '../tickets'
import { hasManyWorktrees, worktreeRowText } from '../worktree-count'
import { statusWords } from '../status-words'
import { withTicketRef } from './running-agents'
import type { RunningAgentRow } from './running-agents'

// What the pane says, top to bottom, one entry per row on screen, so the drawing and the scroll cue agree on the
// height. The order is what a person wants to know at a glance: what waits on them, what runs, what is next, what got
// done, and housekeeping last, so a cut at the bottom always loses the least important.

export type SectionTone = 'live' | 'waiting' | 'plain' | 'dim'

export type RowPress =
  | { opens: 'ticket'; id: string }
  | { opens: 'agent'; id: string }
  | { opens: 'story'; id: string }
  | { opens: 'story-decisions'; id: string }
  | { opens: 'story-yes'; id: string }
  | { opens: 'finished-agent'; id: string }
  | { opens: 'finished-agents' }
  | { opens: 'nothing' }

// `keepsAside` marks an aside that says what the row is (a model, a status): the title gives way to it when room is short.
export type SectionRow = {
  kind: 'row'
  tone: SectionTone
  text: string
  aside: string
  keepsAside: boolean
  press: RowPress
}

export type PaneLine =
  | { kind: 'gap' }
  | { kind: 'sentence'; text: string; isDim: boolean }
  | { kind: 'label'; text: string; tone: SectionTone }
  | { kind: 'heading'; text: string; press?: RowPress }
  | SectionRow
  | { kind: 'set-aside'; text: string }
  | { kind: 'older'; text: string }
  | { kind: 'older-ticket'; id: string; text: string; aside: string }
  | { kind: 'worktrees'; text: string }
  | { kind: 'scroll-cue'; text: string }

export type PaneContent = {
  cards: readonly BoardCard[]
  running: readonly RunningAgentRow[]
  sessionWork: SessionWork
  finishedAgents: readonly FinishedAgent[]
  worktreeCount: number
  // The tickets this session created, started, finished, moved or noted: the rest of the board is other work.
  touchedHere: ReadonlySet<string>
  showsIntro: boolean
  columns: number
  // Milliseconds since the epoch, for how long each running row has run.
  now: number
  whatYouCouldDo: readonly string[]
  // Whether this surface has a main view an agent's transcript can be put in. Only the terminal is known to.
  hasMainView?: boolean
  storiesToRead?: readonly StoryToRead[]
}

export const NOTHING_IS_RUNNING = 'Nothing is running.'

const INTRO = [
  'Now is what runs this moment. Waits on you needs your answer.',
  'Next is what comes after that, Done what finished. Press a row to open it.',
]

const NEARLY_EMPTY =
  'Work bigger than a quick fix gets a ticket. This pane then shows who is on what, what waits on you, what is ' +
  'next and what got done.'

const WAITS_ON_YOU = 'Waits on you'

const RECENT_DONE = 3
const SHORTEST_TEXT = 12

const byIdNumber = (left: BoardCard, right: BoardCard): number => idNumber(left.id) - idNumber(right.id)

const newestFirst = (left: BoardCard, right: BoardCard): number =>
  right.updated.localeCompare(left.updated) || byIdNumber(right, left)

const withStatus = (cards: readonly BoardCard[], status: string): BoardCard[] =>
  cards.filter(card => card.status === status && !isWaitingCard(card)).sort(byIdNumber)

const addWord = (lines: string[], word: string, width: number): string[] => {
  const last = lines.at(-1)
  if (last === undefined || `${last} ${word}`.length > width) return [...lines, word]

  return [...lines.slice(0, -1), `${last} ${word}`]
}

export const wrappedWords = (text: string, width: number): string[] =>
  text.split(' ').reduce<string[]>((lines, word) => addWord(lines, word, width), [])

const sentenceLines = (text: string, columns: number, isDim: boolean): PaneLine[] =>
  wrappedWords(text, columns).map(line => ({ kind: 'sentence', text: line, isDim }))

const label = (text: string, tone: SectionTone): PaneLine => ({ kind: 'label', text, tone })

const NO_PRESS: RowPress = { opens: 'nothing' }

// The key leads, then the board id. The branch and pull request stay in the ticket view, and the title drops a key it starts with.
const statusRowHandle = (card: BoardCard): string => [card.issue ?? '', card.id].filter(part => part !== '').join(' ')

// A title that is nothing but its key adds no words to the handle.
const wordsBesideHandle = (card: BoardCard, words: string): string => {
  const withoutKey = titleWithoutKey(words, card.issue)

  return withoutKey === card.issue ? '' : withoutKey
}

const statusRowWords = (card: BoardCard, words: string): string =>
  [statusRowHandle(card), wordsBesideHandle(card, words)].filter(part => part !== '').join(' ')

const ticketRow = (card: BoardCard, tone: SectionTone, words: string, aside: string, keepsAside = false): SectionRow => ({
  kind: 'row',
  tone,
  text: statusRowWords(card, words),
  aside,
  keepsAside,
  press: { opens: 'ticket', id: card.id },
})

type AgentWords = (agent: RunningAgentRow, cards: readonly BoardCard[]) => string

const agentWords: AgentWords = (agent, cards) => {
  const card = cards.find(one => one.id === agent.ticket)

  return card ? statusRowWords(card, card.title) : withTicketRef(agent.what, agent.ticket)
}

const titleOf = (card: BoardCard): string => titleWithoutKey(card.title, card.piece?.trackerKey)

// Beside the blocks by piece of work, a running ticket says which piece it serves.
const agentWordsByPiece: AgentWords = (agent, cards) => {
  const card = cards.find(one => one.id === agent.ticket)

  return card?.piece === undefined ? agentWords(agent, cards) : `${shortPieceName(card.piece)}: ${titleOf(card)}`
}

const runningFor = (startedAt: string, now: number): string => {
  const minutes = Math.round((now - Date.parse(startedAt)) / 60000)

  return Number.isFinite(minutes) && minutes > 0 ? spokenMinutes(minutes) : 'just started'
}

const agentAside = (agent: RunningAgentRow, cards: readonly BoardCard[], now: number): string => {
  const startedAt = cards.find(one => one.id === agent.ticket)?.startedAt

  return [agent.model, startedAt === undefined ? '' : runningFor(startedAt, now)].filter(part => part !== '').join(', ')
}

const agentRow = (agent: RunningAgentRow, content: PaneContent, words: AgentWords = agentWords): SectionRow => ({
  kind: 'row',
  tone: 'live',
  text: words(agent, content.cards),
  aside: agentAside(agent, content.cards, content.now),
  keepsAside: true,
  press: agent.canBeViewed && content.hasMainView !== false ? { opens: 'agent', id: agent.agentId } : NO_PRESS,
})

const sessionRow = (work: SessionWork): SectionRow => ({
  kind: 'row',
  tone: 'live',
  text: 'This session',
  aside: sessionAside(work),
  keepsAside: true,
  press: NO_PRESS,
})

const justFinishedRow = (finished: FinishedAgent): SectionRow => ({
  kind: 'row',
  tone: 'live',
  text: `Just finished: ${finished.what}`,
  aside: `took ${spokenDuration(finished.durationMs)}`,
  keepsAside: false,
  press: { opens: 'finished-agent', id: finished.agentId },
})

const justFinishedRows = (content: PaneContent): SectionRow[] =>
  newestReturnFirst(content.finishedAgents).filter(isJustFinished).map(justFinishedRow)

const finishedRow = (finished: FinishedAgent): SectionRow => ({
  kind: 'row',
  tone: 'dim',
  text: finished.what,
  aside: finishedAgentAside(finished),
  keepsAside: false,
  press: { opens: 'finished-agent', id: finished.agentId },
})

const NEWEST_FINISHED_SHOWN = 3

const earlierFinished = (content: PaneContent): FinishedAgent[] =>
  newestReturnFirst(content.finishedAgents).filter(agent => !isJustFinished(agent))

const moreFinishedRow = (count: number): SectionRow => ({
  kind: 'row',
  tone: 'dim',
  text: `${count} more finished`,
  aside: '',
  keepsAside: false,
  press: { opens: 'finished-agents' },
})

// An agent that finished stays pressable for the session, so what a lookup found can be read after the turn it woke.
// Past the newest three the rest wait behind one row, so they never push work off the pane.
const finishedRows = (content: PaneContent): SectionRow[] => {
  const earlier = earlierFinished(content)
  const shown = earlier.slice(0, NEWEST_FINISHED_SHOWN).map(finishedRow)

  return earlier.length > NEWEST_FINISHED_SHOWN ? [...shown, moreFinishedRow(earlier.length - NEWEST_FINISHED_SHOWN)] : shown
}

const FINISHED_LABEL = 'Finished agents'

// An agent row already says why the session is busy: it is waiting on that agent.
const sessionRows = (content: PaneContent): SectionRow[] =>
  content.sessionWork.isWorking && content.running.length === 0 ? [sessionRow(content.sessionWork)] : []

const ticketsWithAnAgent = (running: readonly RunningAgentRow[]): Set<string> =>
  new Set(running.flatMap(agent => agent.ticket ?? []))

// Shown under what runs so a person sees at a glance that it is not moving. A ticket that waits on the person is
// listed with what waits and nowhere else: seen in a review, one left in progress drew twice, and one key twice.
const interruptedCards = (content: PaneContent): BoardCard[] => {
  const withAgent = ticketsWithAnAgent(content.running)

  return content.cards.filter(card => card.interrupted !== undefined && !withAgent.has(card.id) && !isWaitingCard(card)).sort(byIdNumber)
}

const STOPPED = 'stopped, nothing runs it'

const HOW_LONG_AGO = /\d+(?:s|m|h| days) ago/

// A narrow pane cut the full words off mid-phrase, so the row keeps how long ago and drops which trace said so.
const interruptedAside = (words: string): string => {
  const ago = HOW_LONG_AGO.exec(words)?.[0]

  return ago === undefined ? STOPPED : `${STOPPED} (${ago})`
}

const interruptedRow = (card: BoardCard): SectionRow => ticketRow(card, 'dim', card.title, interruptedAside(card.interrupted ?? ''), true)

const MOST_LOOKUPS_NAMED = 2

const countRow = (text: string): SectionRow => ({ kind: 'row', tone: 'live', text, aside: '', keepsAside: false, press: NO_PRESS })

// An agent the session started for a lookup has no ticket. Ticket work comes first, and past a few lookups the rest
// are counted, so helpers never push real work off a narrow pane.
const lookupRows = (lookups: readonly RunningAgentRow[], content: PaneContent): SectionRow[] => {
  if (lookups.length <= MOST_LOOKUPS_NAMED + 1) return lookups.map(agent => agentRow(agent, content))
  const named = lookups.slice(0, MOST_LOOKUPS_NAMED).map(agent => agentRow(agent, content))

  return [...named, countRow(`and ${lookups.length - MOST_LOOKUPS_NAMED} more lookups running`)]
}

const agentRows = (content: PaneContent, words: AgentWords): SectionRow[] => [
  ...content.running.filter(agent => agent.ticket !== undefined).map(agent => agentRow(agent, content, words)),
  ...lookupRows(content.running.filter(agent => agent.ticket === undefined), content),
]

const whatRunsRows = (content: PaneContent, words: AgentWords): SectionRow[] => [
  ...agentRows(content, words),
  ...sessionRows(content),
  ...justFinishedRows(content),
]

export const ANSWER_WITH_SESSION = 'your answer is with the session'

const answeredCards = (content: PaneContent): BoardCard[] => withStatus(content.cards, 'needs-you').filter(card => card.answerIsWithSession === true)

const answeredRow = (card: BoardCard): SectionRow => ticketRow(card, 'plain', card.question ?? card.title, ANSWER_WITH_SESSION, true)

const nowRows = (content: PaneContent): SectionRow[] => [
  ...whatRunsRows(content, agentWords),
  ...answeredCards(content).map(answeredRow),
  ...interruptedCards(content).map(interruptedRow),
]

const nowBlock = (rows: readonly SectionRow[]): PaneLine[] =>
  rows.length === 0 ? [{ kind: 'sentence', text: NOTHING_IS_RUNNING, isDim: false }] : [label('Now', 'live'), ...rows]

const recommendedAside = (card: BoardCard): string => (card.recommended ? `recommended: ${card.recommended}` : '')

const millisecondsSinceTouched = (card: BoardCard, now: number): number => now - Date.parse(card.lastTouched ?? '')

// What waits on the person stays in its section however old, so a week-old question says how long it has waited.
const waitedAside = (card: BoardCard, now: number): string => {
  const waited = millisecondsSinceTouched(card, now)

  return waited >= A_WEEK ? `waiting ${daysWords(waited)}` : ''
}

const NO_QUESTION_ASIDE = 'no question written yet'

const waitingAside = (card: BoardCard, now: number): string =>
  [waitedAside(card, now), recommendedAside(card), card.question === undefined ? NO_QUESTION_ASIDE : ''].filter(part => part !== '').join(', ')

const needsYouCards = (content: PaneContent, fromEarlierWork: boolean): BoardCard[] =>
  content.cards.filter(isWaitingCard).sort(byIdNumber).filter(card => isCardFromEarlierWork(card, content.touchedHere, content.now) === fromEarlierWork)

const waitingRows = (content: PaneContent, fromEarlierWork: boolean): SectionRow[] =>
  needsYouCards(content, fromEarlierWork).map(card =>
    ticketRow(card, fromEarlierWork ? 'dim' : 'waiting', card.question ?? card.title, waitingAside(card, content.now)),
  )

const startedAside = (card: BoardCard): string =>
  card.isReturnedNotRecorded ? 'its agent is back, result not written up yet' : 'started earlier, nothing runs it now'

const droppedBlockerWords = (ids: readonly string[]): string =>
  `waits on ${ids.join(', ')}, which ${ids.length === 1 ? 'was' : 'were'} dropped`

const readyAside = (card: BoardCard): string | undefined =>
  card.droppedBlockers === undefined ? card.waitsFor : droppedBlockerWords(card.droppedBlockers)

const readyRow = (card: BoardCard): SectionRow => {
  const aside = readyAside(card)

  return aside === undefined ? ticketRow(card, 'plain', card.title, '') : ticketRow(card, 'plain', card.title, aside, true)
}

const isNotInterrupted = (card: BoardCard): boolean => card.interrupted === undefined

const startedCards = (content: PaneContent): BoardCard[] => {
  const withAgent = ticketsWithAnAgent(content.running)

  return withStatus(content.cards, 'doing').filter(card => !withAgent.has(card.id) && isNotInterrupted(card))
}

const reviewCards = (content: Pick<PaneContent, 'cards'>): BoardCard[] => withStatus(content.cards, 'review').filter(isNotInterrupted)

// What the Being checked section lists and the band counts: built tickets that are not interrupted and not left for a week.
export const cardsBeingChecked = (content: CardsAndWork): BoardCard[] => {
  const older = new Set(olderCards(content).map(card => card.id))

  return reviewCards({ cards: content.cards.filter(card => !older.has(card.id)) })
}

// Seen in a real run: a built ticket listed under Next as "finished, not merged yet", and the person asked what merged
// means for work built in the main checkout. Built work that is being reviewed and proven has a section of its own.
const BEING_CHECKED = 'Being checked'

const beingCheckedRows = (content: PaneContent): SectionRow[] => reviewCards(content).map(card => ticketRow(card, 'plain', card.title, ''))

const nextRows = (content: PaneContent): SectionRow[] => [
  ...withStatus(content.cards, 'ready').map(readyRow),
  ...startedCards(content).map(card => ticketRow(card, 'plain', card.title, startedAside(card), true)),
]

const MOST_THINGS_YOU_COULD_DO = 3

const sentenceRow = (text: string): SectionRow => ({ kind: 'row', tone: 'plain', text, aside: '', keepsAside: false, press: NO_PRESS })

// Asked while something runs: what else can I do? With nothing running the person is not waiting on anything.
const youCouldRows = (content: PaneContent): SectionRow[] =>
  content.running.length === 0 ? [] : content.whatYouCouldDo.slice(0, MOST_THINGS_YOU_COULD_DO).map(sentenceRow)

const recentDoneCards = (content: PaneContent): BoardCard[] =>
  content.cards
    .filter(card => card.status === 'done' && content.touchedHere.has(card.id))
    .sort(newestFirst)
    .slice(0, RECENT_DONE)

const doneRows = (content: PaneContent): SectionRow[] => recentDoneCards(content).map(card => ticketRow(card, 'dim', card.title, ''))

const section = (name: string, tone: SectionTone, rows: readonly SectionRow[]): PaneLine[] =>
  rows.length === 0 ? [] : [label(name, tone), ...rows]

const countWords = (count: number, words: string): string[] => (count > 0 ? [`${count} ${words}`] : [])

export const setAsideCounts = (cards: readonly BoardCard[]): string =>
  ['parked', 'inbox'].flatMap(status => countWords(withStatus(cards, status).length, statusWords(status))).join(', ')

const setAsideBlock = (cards: readonly BoardCard[]): PaneLine[] => {
  const counts = setAsideCounts(cards)

  return counts === '' ? [] : [{ kind: 'set-aside', text: `Also on the board: ${counts}` }]
}

const olderBlock = (count: number): PaneLine[] => {
  if (count === 0) return []

  return [{ kind: 'older', text: count === 1 ? '1 ticket nobody touched for a week' : `${count} tickets nobody touched for a week` }]
}

const worktreeBlock = (count: number): PaneLine[] =>
  hasManyWorktrees(count) ? [{ kind: 'worktrees', text: worktreeRowText(count) }] : []

const introBlock = (content: PaneContent): PaneLine[] =>
  content.showsIntro ? INTRO.flatMap(sentence => sentenceLines(sentence, content.columns, false)) : []

const gapBetween = (blocks: readonly PaneLine[][]): PaneLine[] =>
  blocks.filter(block => block.length > 0).flatMap((block, index) => (index === 0 ? block : [{ kind: 'gap' } as const, ...block]))

// Age never changes a status. Running work and what waits on the person stay where they are however old.
const STATUSES_THAT_GROW_OLD = ['ready', 'doing', 'review']

const isUntouchedForAWeek = (card: BoardCard, now: number): boolean => millisecondsSinceTouched(card, now) >= A_WEEK

type CardsAndWork = Pick<PaneContent, 'cards' | 'running' | 'now'>

const olderCards = (content: CardsAndWork): BoardCard[] => {
  const withAgent = ticketsWithAnAgent(content.running)

  return content.cards
    .filter(card => STATUSES_THAT_GROW_OLD.includes(card.status) && !isWaitingCard(card) && !withAgent.has(card.id) && isUntouchedForAWeek(card, content.now))
    .sort(byIdNumber)
}

// With two or three pieces of work in flight a status-first pane interleaves them, so it lists by the piece of work
// and each row says first what the ticket is.
type WhatACardIs = { card: BoardCard; what: string; tone: SectionTone; words: string; aside: string; keepsAside: boolean }

const plainly = (card: BoardCard, what: string, aside = ''): WhatACardIs => ({ card, what, tone: 'plain', words: titleOf(card), aside, keepsAside: aside !== '' })

const waitingWhat = (content: PaneContent, fromEarlierWork: boolean): WhatACardIs[] =>
  needsYouCards(content, fromEarlierWork).map((card): WhatACardIs => ({
    card,
    what: fromEarlierWork ? 'from an earlier session' : 'waits on you',
    tone: fromEarlierWork ? 'dim' : 'waiting',
    words: card.question ?? titleOf(card),
    aside: waitingAside(card, content.now),
    keepsAside: false,
  }))

const howLongAgo = (words: string): string => HOW_LONG_AGO.exec(words)?.[0] ?? ''

const dimmed = (entry: WhatACardIs): WhatACardIs => ({ ...entry, tone: 'dim' })

const interruptedWhat = (card: BoardCard): WhatACardIs => dimmed(plainly(card, STOPPED, howLongAgo(card.interrupted ?? '')))

const whatEachCardIs = (content: PaneContent): WhatACardIs[] => [
  ...waitingWhat(content, false),
  ...waitingWhat(content, true),
  ...answeredCards(content).map(card => plainly(card, 'answered', ANSWER_WITH_SESSION)),
  ...interruptedCards(content).map(interruptedWhat),
  ...withStatus(content.cards, 'ready').map(card => plainly(card, 'next', readyAside(card))),
  ...startedCards(content).map(card => plainly(card, 'next', startedAside(card))),
  ...recentDoneCards(content).map(card => dimmed(plainly(card, 'done'))),
]

const rowUnderPiece = (entry: WhatACardIs): SectionRow => ({
  kind: 'row',
  tone: entry.tone,
  text: `${entry.what}: ${entry.words}`,
  aside: [entry.aside, handleUnder(entry.card, entry.card.piece)].filter(part => part !== '').join(ASIDE_GAP),
  keepsAside: entry.keepsAside,
  press: { opens: 'ticket', id: entry.card.id },
})

// Tickets of no piece come last, after every piece in the board's order of work.
const pieceOrderOf = (card: BoardCard): number => card.piece?.order ?? Number.POSITIVE_INFINITY

const headingOf = (entries: readonly WhatACardIs[]): string => {
  const piece = entries[0]?.card.piece

  return piece === undefined ? OTHER_TICKETS_HEADING : pieceHeading(piece)
}

const storyPress = (storyId: string | undefined): RowPress => (storyId === undefined ? NO_PRESS : { opens: 'story', id: storyId })

const pieceBlock = (entries: readonly WhatACardIs[]): PaneLine[] => [
  { kind: 'heading', text: headingOf(entries), press: storyPress(entries[0]?.card.piece?.storyId) },
  ...entries.map(rowUnderPiece),
]

// A title alone in bold read as a stray heading to a person, so the row says what its press opens.
const WHAT_A_PLAN_HOLDS = 'analysis and decisions'

export const ANSWERS_WITH_SESSION = 'your answers are with the session'

const storyRow = (story: StoryToRead): SectionRow => ({
  kind: 'row',
  tone: 'plain',
  text: story.title,
  aside: story.answersWithSession ? ANSWERS_WITH_SESSION : WHAT_A_PLAN_HOLDS,
  keepsAside: false,
  press: storyPress(story.id),
})

const storiesWaiting = (content: PaneContent): StoryToRead[] => (content.storiesToRead ?? []).filter(isStoryWaitingOnThePerson)

const decisionsWords = (count: number): string => (count === 1 ? '1 decision on the plan' : `${count} decisions on the plan`)

// Seen in a narrow pane: a longer row was cut before it said where to answer.
export const YES_ON_THE_PLAN = 'Your yes on the proposed tickets'

const planWaitRow = (text: string, press: RowPress, aside: string): SectionRow => ({ kind: 'row', tone: 'waiting', text, aside, keepsAside: false, press })

// Seen in real runs: the plan's questions, and later the yes on its playback, waited on the person while the pane said
// nothing waits on them.
const planWaitRows = (story: StoryToRead, isOneOfSeveral: boolean): SectionRow[] => {
  const aside = isOneOfSeveral ? story.title : ''
  const decisions = story.openQuestions > 0 ? [planWaitRow(decisionsWords(story.openQuestions), { opens: 'story-decisions', id: story.id }, aside)] : []

  return story.awaitsYes ? [...decisions, planWaitRow(YES_ON_THE_PLAN, { opens: 'story-yes', id: story.id }, aside)] : decisions
}

const planDecisionsRows = (content: PaneContent): SectionRow[] => {
  const stories = storiesWaiting(content)

  return stories.flatMap(story => planWaitRows(story, stories.length > 1))
}

// A story is read before it has a ticket, so one with an analysis gets a row of its own wherever no block heads it.
const storiesBlock = (content: PaneContent, headedStoryIds: ReadonlySet<string>): PaneLine[] => {
  const rows = (content.storiesToRead ?? []).filter(story => !headedStoryIds.has(story.id)).map(storyRow)

  return section(rows.length === 1 ? 'The plan' : 'The plans', 'plain', rows)
}

const storyIdsHeading = (entries: readonly WhatACardIs[]): Set<string> => new Set(entries.flatMap(entry => entry.card.piece?.storyId ?? []))

const pieceBlocks = (entries: readonly WhatACardIs[]): PaneLine[][] => {
  const orders = [...new Set(entries.map(entry => pieceOrderOf(entry.card)))].sort((left, right) => left - right)

  return orders.map(order => pieceBlock(entries.filter(entry => pieceOrderOf(entry.card) === order)))
}

const cardsWithAnAgent = (content: PaneContent): BoardCard[] => {
  const withAgent = ticketsWithAnAgent(content.running)

  return content.cards.filter(card => withAgent.has(card.id))
}

const spansSeveralPiecesOfWork = (cards: readonly BoardCard[]): boolean =>
  new Set(cards.flatMap(card => (card.piece === undefined ? [] : [card.piece.order]))).size > 1

// Seen in a real run: the plan sat above what waited on the person. Whatever waits on them is the first section.
const byPiecePaneLines = (content: PaneContent, entries: readonly WhatACardIs[], olderCount: number): PaneLine[] =>
  gapBetween([
    introBlock(content),
    section(WAITS_ON_YOU, 'waiting', planDecisionsRows(content)),
    nowBlock(whatRunsRows(content, agentWordsByPiece)),
    section(BEING_CHECKED, 'plain', beingCheckedRows(content)),
    storiesBlock(content, storyIdsHeading(entries)),
    section('You could', 'plain', youCouldRows(content)),
    ...pieceBlocks(entries),
    section(FINISHED_LABEL, 'dim', finishedRows(content)),
    setAsideBlock(content.cards),
    olderBlock(olderCount),
    worktreeBlock(content.worktreeCount),
  ])

const recentPaneLines = (content: PaneContent, olderCount: number): PaneLine[] => {
  const entries = whatEachCardIs(content)
  const shown = [...cardsWithAnAgent(content), ...reviewCards(content), ...entries.map(entry => entry.card)]

  return spansSeveralPiecesOfWork(shown) ? byPiecePaneLines(content, entries, olderCount) : byStatusPaneLines(content, olderCount)
}

// Seen in a real run: the line on what gets a ticket sat under a plan and a running build, which the person was already
// looking at. It explains an empty board and nothing else.
const isEmptyBoard = (content: PaneContent, ticketSections: readonly PaneLine[][], olderCount: number): boolean =>
  ticketSections.every(block => block.length === 0) &&
  interruptedCards(content).length === 0 &&
  olderCount === 0 &&
  content.running.length === 0 &&
  (content.storiesToRead ?? []).length === 0

const byStatusPaneLines = (content: PaneContent, olderCount: number): PaneLine[] => {
  const waitsOnYou = section(WAITS_ON_YOU, 'waiting', [...planDecisionsRows(content), ...waitingRows(content, false)])
  const ticketSections = [
    waitsOnYou,
    section('Waiting on you from earlier sessions', 'dim', waitingRows(content, true)),
    section('You could', 'plain', youCouldRows(content)),
    section(BEING_CHECKED, 'plain', beingCheckedRows(content)),
    section('Next', 'plain', nextRows(content)),
    section('Done', 'dim', doneRows(content)),
  ]
  const finished = section(FINISHED_LABEL, 'dim', finishedRows(content))
  const nearlyEmpty = isEmptyBoard(content, ticketSections, olderCount) ? sentenceLines(NEARLY_EMPTY, content.columns, true) : []

  return gapBetween([
    introBlock(content),
    waitsOnYou,
    nowBlock(nowRows(content)),
    storiesBlock(content, new Set()),
    nearlyEmpty,
    ...ticketSections.slice(1),
    finished,
    setAsideBlock(content.cards),
    olderBlock(olderCount),
    worktreeBlock(content.worktreeCount),
  ])
}

// Open tickets nobody touched for a week go under one line at the end, so last week's work does not read as this
// week's. Drawn from the cards already loaded: no lookup and no model tokens.
export const boardPaneLines = (content: PaneContent): PaneLine[] => {
  const older = new Set(olderCards(content).map(card => card.id))

  return recentPaneLines({ ...content, cards: content.cards.filter(card => !older.has(card.id)) }, older.size)
}

const olderTicketLine = (card: BoardCard, now: number): PaneLine => ({
  kind: 'older-ticket',
  id: card.id,
  text: statusRowWords(card, card.title),
  aside: `${statusWords(card.status)}, last touched ${spokenAgo(millisecondsSinceTouched(card, now))}`,
})

export const olderTicketLines = (content: PaneContent): PaneLine[] => {
  const rows = olderCards(content).map(card => olderTicketLine(card, content.now))

  return rows.length === 0 ? [] : [label('Untouched for a week', 'dim'), ...rows]
}

export const moreFinishedLines = (content: PaneContent): PaneLine[] =>
  section(FINISHED_LABEL, 'dim', earlierFinished(content).slice(NEWEST_FINISHED_SHOWN).map(finishedRow))

export const setAsideLines = (cards: readonly BoardCard[]): PaneLine[] =>
  gapBetween([
    section('Set aside', 'dim', withStatus(cards, 'parked').map(card => ticketRow(card, 'dim', card.title, ''))),
    section('Not ready yet', 'plain', withStatus(cards, 'inbox').map(card => ticketRow(card, 'plain', card.title, ''))),
  ])

export type ScrollWindow = { offset: number; bodyRows: number; isFocused: boolean }

const scrollHint = (isFocused: boolean): string => (isFocused ? 'the arrow keys scroll' : 'press ctrl+x, then tab, then the arrow keys')

// The cue takes the last row the window shows, so what it covers moves one row down and is counted below.
export const withScrollCue = (lines: readonly PaneLine[], window: ScrollWindow): PaneLine[] => {
  const lastShown = window.offset + window.bodyRows - 1
  const below = lines.length - lastShown
  if (window.bodyRows < 2 || below <= 1) return [...lines]
  const cue: PaneLine = { kind: 'scroll-cue', text: `${below} more below: ${scrollHint(window.isFocused)}` }

  return [...lines.slice(0, lastShown), cue, ...lines.slice(lastShown)]
}

const rowsOf = (text: string, columns: number): number =>
  text.split('\n').reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / Math.max(1, columns))), 0)

const READING_VIEW_OWN_ROWS = 5

// The host draws the Markdown, so the height is counted from the text: near enough to say more is below.
export const readingScrollCue = (texts: readonly string[], window: ScrollWindow, columns: number): string | undefined => {
  const rows = texts.reduce((total, text) => total + rowsOf(text, columns), READING_VIEW_OWN_ROWS)

  return rows > window.offset + window.bodyRows ? `More below: ${scrollHint(window.isFocused)}` : undefined
}

const decisionsForYouTexts = (story: StoryDetail): string[] =>
  story.decisionsForYou.flatMap(decision => [decision.question, ...decision.recommended, decision.otherwise]).filter(text => text !== '')

// A bordered step is its lines plus two border rows, and the arrow under it one more.
const pathTexts = (story: StoryDetail): string[] => story.path.map(step => [step.what, step.file, step.note, '', ''].join('\n'))

const excerptTexts = (story: StoryDetail): string[] => story.excerpts.map(excerpt => `${excerpt.file}\n${excerpt.lines}`)

const proposedTicketTexts = (story: StoryDetail): string[] => story.proposedTickets.flatMap(ticket => [ticket.title, ticket.what, ticket.doneWhen])

export const storyScrollCue = (story: StoryDetail, window: ScrollWindow, columns: number): string | undefined =>
  readingScrollCue(
    [story.inShort, story.destination, story.analysis, ...pathTexts(story), ...excerptTexts(story), ...decisionsForYouTexts(story), story.decided, ...proposedTicketTexts(story)],
    window,
    columns,
  )

export const MOST_ROWS_ASKED = 20
const FEWEST_ROWS_ASKED = 3

export const rowsToAskFor = (lines: readonly PaneLine[]): number =>
  Math.min(MOST_ROWS_ASKED, Math.max(FEWEST_ROWS_ASKED, lines.length))

export const cutToColumns = (text: string, columns: number): string =>
  text.length <= columns ? text : `${text.slice(0, Math.max(0, columns - 3))}...`

export const ASIDE_GAP = '  '
const SHORTEST_ASIDE = 12
const LONG_ASIDE = 20

const keptAsideWidth = (row: SectionRow): number => (row.keepsAside && row.aside !== '' ? row.aside.length + ASIDE_GAP.length : 0)

// Cut short, a count or a status reads as nonsense, so it shows whole or not at all; a long answer can be cut.
const fittedAside = (aside: string, room: number): string => {
  if (aside.length <= room) return aside

  return aside.length > LONG_ASIDE && room >= SHORTEST_ASIDE ? cutToColumns(aside, room) : ''
}

// A row is one line on screen. The title comes first, except before an aside that says what the row is.
export const fittedRow = (row: SectionRow, room: number): { text: string; aside: string } => {
  const shownText = cutToColumns(row.text, Math.max(SHORTEST_TEXT, room - keptAsideWidth(row)))

  return { text: shownText, aside: fittedAside(row.aside, room - shownText.length - ASIDE_GAP.length) }
}

const lineText = (line: PaneLine): string => {
  if (line.kind === 'gap') return ''
  if (line.kind === 'label') return line.text
  if (line.kind === 'row' || line.kind === 'older-ticket') return `  ${line.text}  ${line.aside}`.trimEnd()

  return line.text
}

export const paneLinesAsText = (lines: readonly PaneLine[]): string => lines.map(lineText).join('\n')
