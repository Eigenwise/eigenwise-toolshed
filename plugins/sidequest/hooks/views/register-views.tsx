import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderElement, ToolCallResult } from 'claude-code'

import type { BoardCard, FinishedAgentDetail, StoryDetail, TicketDetail } from '../../types'
import {
  NO_PLAN_FORM,
  NO_TICKET_FORM,
  planFormFor,
  remarkSentLine,
  tickedItems,
  ticketFormFor,
  withAnswerPicked,
  withItemTicked,
  withOtherAnswerToggled,
  withPlanWordsTyped,
  withTicketWordsTyped,
  withWholeTicketShown,
} from './answer-form'
import { boardLocation, publishSummary, queueBoardWrite, takeChatEnding, takePathToPlace, takeTicketsAfterWrite, takeViewToShow } from '../board-session'
import type { ViewAfterWrite } from '../board-session'
import { pathDrawing, placedPathId, storyOfPlacedPath } from './code-path-drawing'
import type { CodePathElements } from './code-path-drawing'
import {
  answeredByHuman,
  approvedByHuman,
  paneAnswerText,
  planAnsweredByHuman,
  saidAboutStory,
  saidAboutTicket,
  saidToItsAgent,
  saidYesOnThePlan,
  wordsForItsAgent,
} from '../human-answers'
import type { HumanWrite, StoryRemark } from '../human-answers'
import { NO_INTERRUPTED_WORK } from '../interrupted-work'
import { pressOnTheBoard } from '../register-drop'
import { interruptedWorkOn } from '../register-interrupted'
import { rememberSessionChanges, ticketsTouchedThisSession } from '../register-closing-report'
import { readOutcome } from '../run-outcome'
import { NO_STORIES } from '../pieces-of-work'
import { proposedTicketsOf, withoutProposedTickets } from '../proposed-tickets'
import { replyWithBoardPlaced } from '../chat-ending'
import type { ChatEnding } from '../chat-ending'
import { idsOfLastBoardRead, readBoard, readBoardConfig, readStoriesAndCheckout, readStory, readTicket, writeBoardDecision } from '../store'
import type { BoardChange, BoardLocation } from '../store'
import { minuteStamp, oneLine, withChangedTickets } from '../tickets'
import type { Story, Ticket } from '../tickets'
import { textOf } from '../tool-input'
import { whatThePersonCouldDo } from '../what-can-move'
import { askForTidy } from '../register-worktrees'
import type { JsonRecord } from '../tool-input'
import { drawBand } from './band'
import {
  boardCards,
  boardNotices,
  doingTicketsIn,
  oldestWaitingOf,
  piecesWaitingOnYou,
  returnedTicketsIn,
  storiesToRead,
  storyDetail,
  ticketDetail,
} from './board-view'
import type { BoardNotice, FinishedRun } from './board-view'
import { finishedAgentDetail, transcriptOf } from './finished-agents'
import { DECISIONS_KEY, drawBoardPane } from './pane'
import type { BoardPaneActions } from './pane'
import { boardPaneLines, moreFinishedLines, MOST_ROWS_ASKED, olderTicketLines, paneLinesAsText, rowsToAskFor, setAsideLines } from './pane-sections'
import type { PaneContent } from './pane-sections'
import { agentRunningOn, runningAgentRows } from './running-agents'
import type { BoardActivity, ListedAgent, RunningAgentRow } from './running-agents'
import { drawBoardReadResult, drawNothing, drawToolRow } from './tool-row'
import { boardReadLine, boardToolRow, NO_BOARD_READS, runOfToolUse, toolRowLabel, withBoardRead } from './tool-rows'
import type { BoardReads } from './tool-rows'

// Which board reads drew the same line as the read before them. A reload forgets it, and a repeat then shows its line.
let boardReads: BoardReads = NO_BOARD_READS

const BOARD_PANE = 'board'
const BOARD_WRITING_TOOLS = ['mcp__sidequest__ticket', 'mcp__sidequest__start', 'mcp__sidequest__finish'] as const
const FINISH_TOOL = 'mcp__sidequest__finish'
const BOARD_READING_TOOL = 'mcp__sidequest__board'
const NOTIFICATION_TITLE = 'Sidequest'

// The host only follows a state name declared in the file that uses it, so each file names its own. The shape tags
// decline what an earlier version stored, which outlives a reload: change one in every file when its fields change.
const cardsOnBoard = atom({ plugin: 'sidequest', key: 'cards' } as const, null, { shape: 'cards-11' })
const openTicket = atom({ plugin: 'sidequest', key: 'openTicket' } as const, null, { shape: 'ticket-detail-8' })
const openStory = atom({ plugin: 'sidequest', key: 'openStory' } as const, null, { shape: 'story-detail-6' })
const ticketForm = atom({ plugin: 'sidequest', key: 'ticketForm' } as const, NO_TICKET_FORM, { shape: 'ticket-form-3' })
const planForm = atom({ plugin: 'sidequest', key: 'planForm' } as const, NO_PLAN_FORM, { shape: 'plan-form-3' })
const storiesToOpen = atom({ plugin: 'sidequest', key: 'storiesToRead' } as const, [], { shape: 'stories-to-read-3' })
const boardSummary = atom({ plugin: 'sidequest', key: 'summary' } as const, { needsYou: 0, ready: 0, doing: 0, review: 0 })
const agentRuns = atom({ plugin: 'sidequest', key: 'runs' } as const, {})
const liveAgents = atom({ plugin: 'sidequest', key: 'agents' } as const, {}, { shape: 'live-agents-2' })
const permissionWaits = atom({ plugin: 'sidequest', key: 'permissionWaits' } as const, {})
const boardWasOpened = atom({ plugin: 'sidequest', key: 'boardWasOpened' } as const, false)
const worktreeCount = atom({ plugin: 'sidequest', key: 'worktreeCount' } as const, 0)
const sessionWork = atom({ plugin: 'sidequest', key: 'sessionWork' } as const, { isWorking: false, steps: 0 })
const finishedAgents = atom({ plugin: 'sidequest', key: 'finishedAgents' } as const, [], { shape: 'finished-agents-1' })
const openFinishedAgent = atom({ plugin: 'sidequest', key: 'openFinishedAgent' } as const, null)
const showsMoreFinished = atom({ plugin: 'sidequest', key: 'showsMoreFinished' } as const, false)
const showsBoardIntro = atom({ plugin: 'sidequest', key: 'showsBoardIntro' } as const, false)
const showsSetAside = atom({ plugin: 'sidequest', key: 'showsSetAside' } as const, false)
const showsOlderTickets = atom({ plugin: 'sidequest', key: 'showsOlderTickets' } as const, false)
const whatYouCouldDo = atom({ plugin: 'sidequest', key: 'whatYouCouldDo' } as const, [])

// Kept in the plugin's store, which outlives the session, so the two lines that explain the pane show once.
const INTRO_SEEN_KEY = 'boardIntroSeen'
// The pane's width is only known once it draws; the rows it asks for when opening are counted at this width.
const OPENING_COLUMNS = 76

type HumanWriteOf = (ticket: Ticket, stamp: string) => HumanWrite | undefined

const storyOf = (ticket: Ticket, stories: readonly Story[]): Story | undefined => stories.find(story => story.id === ticket.story)

const refreshedDetail = (detail: TicketDetail | null, tickets: readonly Ticket[], stories: readonly Story[]): TicketDetail | null => {
  const ticket = detail ? tickets.find(one => one.id === detail.id) : undefined

  return ticket ? ticketDetail(ticket, storyOf(ticket, stories)) : null
}

const changedProposedIn = (detail: StoryDetail): Set<string> => new Set(detail.proposedTickets.filter(ticket => ticket.changed).map(ticket => ticket.id))

// A story missing from a read keeps its view: a listing that fails for a moment must not close what the person reads.
// What a correction changed stays marked until the plan view opens again on a write.
const refreshedStory = (detail: StoryDetail | null, stories: readonly Story[], tickets: readonly Ticket[]): StoryDetail | null => {
  const story = detail ? stories.find(one => one.id === detail.id) : undefined

  return story && detail ? storyDetail(story, tickets, changedProposedIn(detail)) : detail
}

export async function showTickets($: EngineInterface, tickets: readonly Ticket[]): Promise<BoardCard[]> {
  const location = await boardLocation($)
  const [config, interrupted, storiesAndCheckout, now] = await Promise.all([
    readBoardConfig($, location),
    interruptedWorkOn($, tickets).catch(() => NO_INTERRUPTED_WORK),
    readStoriesAndCheckout($, location).catch(() => NO_STORIES),
    $.clock.now(),
  ])
  const openWork = withoutProposedTickets(tickets, storiesAndCheckout.stories)
  const cards = boardCards(openWork, config, interrupted, { ...storiesAndCheckout, touched: ticketsTouchedThisSession() })
  await publishSummary($, tickets, storiesAndCheckout.stories)
  await update($, cardsOnBoard, () => cards)
  await update($, whatYouCouldDo, () => whatThePersonCouldDo(openWork))
  await update($, openTicket, detail => refreshedDetail(detail, tickets, storiesAndCheckout.stories))
  await update($, storiesToOpen, () => storiesToRead(storiesAndCheckout.stories, tickets, now))
  await update($, openStory, detail => refreshedStory(detail, storiesAndCheckout.stories, tickets))

  return cards
}

async function loadTickets($: EngineInterface): Promise<Ticket[]> {
  return (await readBoard($, await boardLocation($))).tickets
}

async function storyOfTicket($: EngineInterface, location: BoardLocation, ticket: Ticket | undefined): Promise<Story | undefined> {
  if (ticket?.story === undefined) return undefined

  return readStory($, location, ticket.story).catch(() => undefined)
}

async function showTicketDetail($: EngineInterface, id: string): Promise<void> {
  const location = await boardLocation($)
  const ticket = await readTicket($, location, id)
  const story = await storyOfTicket($, location, ticket)
  await update($, openTicket, () => (ticket ? ticketDetail(ticket, story) : null))
}

async function closeTicketDetail($: EngineInterface): Promise<void> {
  await update($, openTicket, () => null)
}

async function showStoryDetail($: EngineInterface, id: string, changedProposed: readonly string[] = []): Promise<void> {
  const location = await boardLocation($)
  const story = await readStory($, location, id)
  const tickets = story?.awaitsYes === true ? (await readBoard($, location)).tickets : []
  await update($, openStory, () => (story ? storyDetail(story, tickets, new Set(changedProposed)) : null))
}

// The person pressed what waits on them, so the plan opens where they answer it. A host that cannot scroll there still
// shows the plan.
async function showStoryDecisions($: EngineInterface, id: string): Promise<void> {
  await showStoryDetail($, id)
  await $.ui.scroll({ to: { key: DECISIONS_KEY }, in: BOARD_PANE, block: 'start' }).catch(() => undefined)
}

async function closeStoryDetail($: EngineInterface): Promise<void> {
  await update($, openStory, () => null)
}

async function listSetAside($: EngineInterface, isShown: boolean): Promise<void> {
  await update($, showsSetAside, () => isShown)
}

async function listOlderTickets($: EngineInterface, isShown: boolean): Promise<void> {
  await update($, showsOlderTickets, () => isShown)
}

// No model turn: the person pressed it and sees what happened in a toast.
async function pressOnOlderTicket($: EngineInterface, operation: JsonRecord): Promise<void> {
  const pressed = await pressOnTheBoard($, operation)
  if (pressed === undefined) return
  await showTickets($, pressed.tickets)
  $.ui.toast(pressed.text)
}

const handWriteOn = (tickets: readonly Ticket[], id: string, humanWriteOf: HumanWriteOf, stamp: string): { human?: HumanWrite; change?: BoardChange } => {
  const ticket = tickets.find(one => one.id === id)
  const human = ticket ? humanWriteOf(ticket, stamp) : undefined

  return human ? { human, change: { tickets: [human.ticket], stories: [] } } : {}
}

async function writeByHand($: EngineInterface, id: string, humanWriteOf: HumanWriteOf): Promise<string | undefined> {
  const stamp = minuteStamp(await $.clock.now())
  const written = await writeBoardDecision($, await boardLocation($), files => handWriteOn(files.tickets, id, humanWriteOf, stamp))
  if (written.saved.notes.length > 0) $.ui.toast(written.saved.notes.join(' '))
  if (written.saved.tickets.length === 0) return undefined
  rememberSessionChanges(written.files.tickets, written.saved.tickets)
  const after = withChangedTickets(written.files.tickets, written.saved.tickets)
  await showTickets($, after)

  return written.decision.human?.sessionLine
}

// The decision is already on the ticket. The line only saves the human from typing it in the chat as well, and it
// costs one model turn, on their press.
async function tellSession($: EngineInterface, line: string | undefined): Promise<void> {
  if (line === undefined) return
  const entered = await $.prompt.submit({ text: line, asUser: true })
  if (entered.drop !== undefined) $.ui.toast(`It is on the ticket, but the session did not take it: ${entered.drop}`)
}

async function decideByHand($: EngineInterface, id: string, humanWriteOf: HumanWriteOf): Promise<void> {
  const line = await queueBoardWrite(() => writeByHand($, id, humanWriteOf))
  await tellSession($, line).catch(() => $.ui.toast('It is on the ticket, but the session could not be told. Say it in the chat.'))
}

async function tellItsAgent($: EngineInterface, agentId: string, words: string): Promise<void> {
  const sent = await $.session.send({ to: { agentId }, text: words })
  $.ui.toast(sent.isDelivered ? 'Sent to the agent building it, and kept on the ticket.' : `It is on the ticket, but the agent did not take it: ${sent.reason}. Say it in the chat.`)
}

async function sayAboutTicket($: EngineInterface, id: string, typed: string): Promise<void> {
  const agentId = agentRunningOn(await runningRows($), id)
  if (agentId === undefined) return decideByHand($, id, (ticket, stamp) => saidAboutTicket(ticket, typed, stamp))
  const ticket = (await loadTickets($)).find(one => one.id === id)
  if (ticket === undefined) return
  await queueBoardWrite(() => writeByHand($, id, (current, stamp) => saidToItsAgent(current, typed, stamp)))
  await tellItsAgent($, agentId, wordsForItsAgent(ticket, typed)).catch(() => $.ui.toast('It is on the ticket, but the agent could not be told. Say it in the chat.'))
}

type StoryRemarkOf = (story: Story, stamp: string) => StoryRemark | undefined

const storyRemarkOn = (stories: readonly Story[], id: string, remarkOf: StoryRemarkOf, stamp: string): { sessionLine?: string; change?: BoardChange } => {
  const story = stories.find(one => one.id === id)
  const remark = story ? remarkOf(story, stamp) : undefined

  return remark ? { sessionLine: remark.sessionLine, change: { tickets: [], stories: [remark.story] } } : {}
}

async function writeStoryRemark($: EngineInterface, id: string, remarkOf: StoryRemarkOf): Promise<string | undefined> {
  const stamp = minuteStamp(await $.clock.now())
  const written = await writeBoardDecision($, await boardLocation($), files => storyRemarkOn(files.stories, id, remarkOf, stamp))
  if (written.saved.notes.length > 0) $.ui.toast(written.saved.notes.join(' '))
  if (written.saved.stories.length === 0) return undefined
  await showTickets($, written.files.tickets)
  await showStoryDetail($, id)

  return written.decision.sessionLine
}

async function remarkOnStory($: EngineInterface, id: string, remarkOf: StoryRemarkOf): Promise<void> {
  const line = await queueBoardWrite(() => writeStoryRemark($, id, remarkOf))
  await tellSession($, line).catch(() => $.ui.toast('It is on the plan, but the session could not be told. Say it in the chat.'))
}

const planRemarkOf = (otherAnswers: readonly number[], words: string): StoryRemarkOf => (story, stamp) =>
  story.questions.length === 0 ? saidAboutStory(story, words, stamp) : planAnsweredByHuman(story, otherAnswers, words, stamp)

// The person's yes on the playback, pressed on the board, reaches the session as their message and the plan's log, as
// typing yes would; the session's patch on that yes makes the tickets live.
async function sayYesToPlan($: EngineInterface, id: string): Promise<void> {
  const form = planFormFor(await read($, planForm), id)
  await update($, planForm, () => NO_PLAN_FORM)
  const tickets = await loadTickets($)
  await remarkOnStory($, id, (story, stamp) => saidYesOnThePlan(story, proposedTicketsOf(story, tickets).length, form.typed, stamp))
}

// One send: the picked answers and any words reach the chat as the person's one message, and the plan's log. Send
// takes what the field holds.
async function sendPlanAnswers($: EngineInterface, id: string): Promise<void> {
  const form = planFormFor(await read($, planForm), id)
  await update($, planForm, () => NO_PLAN_FORM)
  await remarkOnStory($, id, planRemarkOf(form.otherAnswers, form.typed))
}

// One send: the picked answer, the ticked extras and any words go out as one answer on the ticket and in the chat.
async function sendTicketAnswer($: EngineInterface, id: string): Promise<void> {
  const [form, detail] = await Promise.all([read($, ticketForm), read($, openTicket)])
  const current = ticketFormFor(form, id)
  const alsoDo = tickedItems(current, detail?.id === id ? detail.alsoYours : [])
  const text = paneAnswerText({ picked: current.picked, alsoDo, words: current.typed })
  if (text === '') return
  await update($, ticketForm, () => NO_TICKET_FORM)
  await decideByHand($, id, (ticket, stamp) => answeredByHuman(ticket, text, stamp))
}

async function sendTicketRemark($: EngineInterface, id: string): Promise<void> {
  const words = oneLine(ticketFormFor(await read($, ticketForm), id).typed)
  if (words === '') return
  const isToItsAgent = agentRunningOn(await runningRows($), id) !== undefined
  await update($, ticketForm, () => ({ ...NO_TICKET_FORM, id, remarkSent: remarkSentLine(words, isToItsAgent) }))
  await sayAboutTicket($, id, words)
}

async function sendStoryRemark($: EngineInterface, id: string): Promise<void> {
  const words = oneLine(planFormFor(await read($, planForm), id).typed)
  if (words === '') return
  await update($, planForm, () => ({ ...NO_PLAN_FORM, id, remarkSent: remarkSentLine(words, false) }))
  await remarkOnStory($, id, (story, stamp) => saidAboutStory(story, words, stamp))
}

async function showAgentTranscript($: EngineInterface, agentId: string): Promise<void> {
  const shown = await $.ui.view({ agentId })
  if (shown.deny !== undefined) $.ui.toast(shown.deny)
}

// A workflow's agents are never in the host's list, and a host without the call answers nothing: both leave the rows
// to what the spawn hook recorded.
async function listedAgents($: EngineInterface): Promise<ListedAgent[]> {
  return $.agent.list().catch(() => [])
}

async function runningRows($: EngineInterface): Promise<RunningAgentRow[]> {
  const [listed, agents, runs] = await Promise.all([listedAgents($), read($, liveAgents), read($, agentRuns)])

  return runningAgentRows(listed, agents, runs)
}

// A ticket's agent opens its ticket, whose view already holds what it returned; a lookup has no ticket, so it opens its own.
async function showFinishedAgent($: EngineInterface, agentId: string): Promise<void> {
  const agent = (await read($, finishedAgents)).find(one => one.agentId === agentId)
  if (agent?.ticket !== undefined) await showTicketDetail($, agent.ticket)
  else await update($, openFinishedAgent, () => (agent === undefined ? null : agentId))
}

async function closeFinishedAgent($: EngineInterface): Promise<void> {
  await update($, openFinishedAgent, () => null)
}

async function listMoreFinished($: EngineInterface, isShown: boolean): Promise<void> {
  await update($, showsMoreFinished, () => isShown)
}

async function openFinishedAgentDetail($: EngineInterface, hasMainView: boolean): Promise<FinishedAgentDetail | null> {
  const [agentId, finished] = await Promise.all([read($, openFinishedAgent), read($, finishedAgents)])
  const agent = finished.find(one => one.agentId === agentId)
  if (agent === undefined) return null
  const listedIds = (await listedAgents($)).map(listed => listed.id)

  return finishedAgentDetail(agent, transcriptOf(agent.agentId, listedIds, hasMainView))
}

async function boardActivity($: EngineInterface): Promise<BoardActivity> {
  const [agents, runs, cards, waits, now] = await Promise.all([
    read($, liveAgents),
    read($, agentRuns),
    read($, cardsOnBoard),
    read($, permissionWaits),
    $.clock.now(),
  ])
  const touchedHere = ticketsTouchedThisSession()
  const waiting = { oldestWaitingMs: oldestWaitingOf(cards ?? [], now, touchedHere), piecesWaitingOnYou: piecesWaitingOnYou(cards ?? [], now, touchedHere) }

  return { agents, runs, waits, doingTickets: doingTicketsIn(cards), returnedTickets: returnedTicketsIn(cards), ...waiting }
}

// The desktop app answers a View press with "no main view here": the row has nowhere to put an agent's transcript.
const SURFACE_WITH_A_MAIN_VIEW = 'terminal'

async function paneContent($: EngineInterface, columns: number, surface?: string): Promise<PaneContent> {
  const [cards, running, work, finished, worktrees, showsIntro, youCould, stories, now] = await Promise.all([
    read($, cardsOnBoard),
    runningRows($),
    read($, sessionWork),
    read($, finishedAgents),
    read($, worktreeCount),
    read($, showsBoardIntro),
    read($, whatYouCouldDo),
    read($, storiesToOpen),
    $.clock.now(),
  ])
  const facts = { sessionWork: work, finishedAgents: finished, worktreeCount: worktrees, showsIntro, whatYouCouldDo: youCould, storiesToRead: stories }

  return { cards: cards ?? [], running, ...facts, touchedHere: ticketsTouchedThisSession(), columns, now, hasMainView: surface === SURFACE_WITH_A_MAIN_VIEW }
}

async function isFirstOpenEver($: EngineInterface): Promise<boolean> {
  const seen = await $.store.get(INTRO_SEEN_KEY).catch(() => true)

  return seen !== true
}

// The intro is only spent once it was placed: an open the surface holds back undrawn leaves it for the next one.
async function openBoard($: EngineInterface, rowsForALongRead?: number): Promise<boolean> {
  const isFirstOpen = await isFirstOpenEver($)
  if (isFirstOpen) await update($, showsBoardIntro, () => true)
  const lines = boardPaneLines(await paneContent($, OPENING_COLUMNS))
  const opened = await $.ui.open({ id: BOARD_PANE, title: 'Board', rows: rowsForALongRead ?? rowsToAskFor(lines) })
  if (isFirstOpen && opened.isPlaced) await $.store.set(INTRO_SEEN_KEY, true).catch(() => undefined)

  return opened.isPlaced
}

async function openBoardPane($: EngineInterface): Promise<boolean> {
  await showTickets($, await loadTickets($))

  return openBoard($)
}

// With nothing on the board nothing draws, so a human never sees that it exists. The first write of a session
// opens it once; after that where it lives, or whether it stays closed, is theirs.
async function openBoardOnFirstWrite($: EngineInterface): Promise<void> {
  if (await read($, boardWasOpened)) return
  await update($, boardWasOpened, () => true)
  await openBoard($)
}

async function showTicketInPlaceOfThePlan($: EngineInterface, id: string): Promise<void> {
  await closeStoryDetail($)
  await showTicketDetail($, id)
}

// The person reads the plan or the commit question while they answer, so a write that carries one shows it and opens
// the pane for it, at the height of a long read: a board with one row would otherwise open three rows tall. It never
// asks for the keyboard: the person's most common answer is yes typed in the prompt. So it cannot raise the board over
// another plugin's tab either, and the chat's pointer names /board.
async function showViewAfterWrite($: EngineInterface, view: ViewAfterWrite): Promise<boolean> {
  if ('story' in view) await showStoryDetail($, view.story, view.changedProposed)
  else await showTicketInPlaceOfThePlan($, view.ticket)
  await update($, boardWasOpened, () => true)

  return openBoard($, MOST_ROWS_ASKED)
}

async function showBoardOrText($: EngineInterface): Promise<{ text?: string }> {
  if (await openBoardPane($)) return {}

  return { text: paneLinesAsText(boardPaneLines(await paneContent($, Number.MAX_SAFE_INTEGER))) }
}

// The outcome is read the way finish reads it, so "success" raises the same notice as "done".
const finishedRunsIn = (call: JsonRecord): FinishedRun[] =>
  call.tool === FINISH_TOOL
    ? [{ id: textOf(call, 'id') ?? '', outcome: readOutcome(textOf(call, 'outcome'), textOf(call, 'needs')) }]
    : []

// A toast is gone in four seconds, so the same line also goes out as a notification for a human who stepped away.
async function tellTheHuman($: EngineInterface, notice: BoardNotice): Promise<void> {
  $.ui.toast(notice.text)
  await $.ui.notify(notice.text, { title: NOTIFICATION_TITLE, key: notice.key }).catch(() => undefined)
}

async function announceTickets(
  $: EngineInterface,
  before: readonly BoardCard[] | null,
  tickets: readonly Ticket[],
  finished: readonly FinishedRun[],
): Promise<void> {
  const after = await showTickets($, tickets)
  for (const notice of boardNotices(before, after, finished)) await tellTheHuman($, notice)
}

// The board's own writes (a return record, a repair) redraw and notify the way a tool's write does.
export async function showBoardOwnWrite($: EngineInterface, tickets: readonly Ticket[], finished: readonly FinishedRun[]): Promise<void> {
  await announceTickets($, await read($, cardsOnBoard), tickets, finished)
}

async function showBoardWrite(
  $: EngineInterface,
  before: readonly BoardCard[] | null,
  finished: readonly FinishedRun[],
): Promise<boolean> {
  await announceTickets($, before, takeTicketsAfterWrite() ?? (await loadTickets($)), finished)
  const view = takeViewToShow()
  if (view === undefined) await openBoardOnFirstWrite($)
  const isViewPlaced = view !== undefined && (await showViewAfterWrite($, view))
  const storyWithFirstPath = takePathToPlace()
  if (!isViewPlaced) await placeFirstPath($, storyWithFirstPath)

  return isViewPlaced
}

const answerForTheBoard = (answer: ToolCallResult, chat: ChatEnding | undefined, isViewPlaced: boolean): ToolCallResult =>
  chat !== undefined && isViewPlaced && typeof answer.result === 'string' ? { ...answer, result: replyWithBoardPlaced(answer.result, chat) } : answer

// The path is placed once, when a story first gets one, so the transcript keeps it at full width. Only with no board
// placed: the plan view beside the talk already draws it, and the same path twice side by side was seen in a real run.
async function placeFirstPath($: EngineInterface, storyId: string | undefined): Promise<void> {
  if (storyId !== undefined) await $.ui.place({ id: placedPathId(storyId) }).catch(() => undefined)
}

async function drawPlacedPath($: EngineInterface, storyId: string, elements: CodePathElements): Promise<RenderElement | false> {
  const story = await readStory($, await boardLocation($), storyId)

  return story ? pathDrawing(elements, story.path) : false
}

function paneActions($: EngineInterface): BoardPaneActions {
  return {
    openTicket: id => showTicketDetail($, id),
    openStory: id => showStoryDetail($, id),
    openStoryDecisions: id => showStoryDecisions($, id),
    closeStory: () => closeStoryDetail($),
    approveCheckpoint: id => decideByHand($, id, approvedByHuman),
    pickAnswer: async (id, label) => {
      await update($, ticketForm, form => withAnswerPicked(form, id, label))
    },
    tickAlsoYours: async (id, index) => {
      await update($, ticketForm, form => withItemTicked(form, id, index))
    },
    showWholeTicket: async id => {
      await update($, ticketForm, form => withWholeTicketShown(form, id))
    },
    typeTicketWords: async (id, typed) => {
      await update($, ticketForm, form => withTicketWordsTyped(form, id, typed))
    },
    sendTicketAnswer: id => sendTicketAnswer($, id),
    keepTicketWords: async (id, typed) => {
      await update($, ticketForm, form => withTicketWordsTyped(form, id, typed))
    },
    keepPlanWords: async (id, typed) => {
      await update($, planForm, form => withPlanWordsTyped(form, id, typed))
    },
    sendTicketRemark: id => sendTicketRemark($, id),
    sendStoryRemark: id => sendStoryRemark($, id),
    togglePlanAnswer: async (id, index) => {
      await update($, planForm, form => withOtherAnswerToggled(form, id, index))
    },
    typePlanWords: async (id, typed) => {
      await update($, planForm, form => withPlanWordsTyped(form, id, typed))
    },
    sendPlanAnswers: id => sendPlanAnswers($, id),
    sayYesToPlan: id => sayYesToPlan($, id),
    viewAgent: agentId => showAgentTranscript($, agentId),
    closeTicket: () => closeTicketDetail($),
    showSetAside: () => listSetAside($, true),
    closeSetAside: () => listSetAside($, false),
    showOlder: () => listOlderTickets($, true),
    closeOlder: () => listOlderTickets($, false),
    setAsideTicket: id => pressOnOlderTicket($, { op: 'move', id, status: 'parked' }),
    dropTicket: id => pressOnOlderTicket($, { op: 'drop', id }),
    tidyWorktrees: () => askForTidy($),
    openFinishedAgent: agentId => showFinishedAgent($, agentId),
    closeFinishedAgent: () => closeFinishedAgent($),
    showMoreFinished: () => listMoreFinished($, true),
    closeMoreFinished: () => listMoreFinished($, false),
  }
}

export async function startBoardViews($: EngineInterface, tickets: readonly Ticket[]): Promise<void> {
  boardReads = NO_BOARD_READS
  await $.command.register({ name: 'board', description: 'Open the Sidequest board', immediate: true })
  await showTickets($, tickets)
}

export const registerViews = (on: On): void => {
  for (const tool of BOARD_WRITING_TOOLS) {
    on('tool.call', { tool }, async ($, e, next) => {
      const before = await read($, cardsOnBoard)
      const answer = await next(e)
      const chat = takeChatEnding()
      if (answer.deny !== undefined) return answer
      // The write already happened. A drawing that fails must never turn it into an error for the model.
      const isViewPlaced = await showBoardWrite($, before, finishedRunsIn(e)).catch(() => false)

      return answerForTheBoard(answer, chat, isViewPlaced)
    }).catch(($, e, next) => next(e))
  }

  on('command.run', { command: 'board' }, async $ => showBoardOrText($))

  on('ui.render', { component: 'Pane', requestId: BOARD_PANE }, async ($, e) => {
    const [summary, detail, story, content, isSetAsideShown, isOlderShown, isMoreFinishedShown] = await Promise.all([
      read($, boardSummary),
      read($, openTicket),
      read($, openStory),
      paneContent($, e.props.bodyColumns, e.surface),
      read($, showsSetAside),
      read($, showsOlderTickets),
      read($, showsMoreFinished),
    ])
    const [finishedAgent, ticketFormNow, planFormNow] = await Promise.all([
      openFinishedAgentDetail($, content.hasMainView === true),
      read($, ticketForm),
      read($, planForm),
    ])
    const setAside = isSetAsideShown ? setAsideLines(content.cards) : null
    const older = isOlderShown ? olderTicketLines(content) : null
    const moreFinished = isMoreFinishedShown ? moreFinishedLines(content) : null
    const forms = { ticket: ticketFormFor(ticketFormNow, detail?.id ?? ''), plan: planFormFor(planFormNow, story?.id ?? '') }
    const state = { props: e.props, summary, lines: boardPaneLines(content), setAside, older, detail, story, finishedAgent, moreFinished, forms }

    return drawBoardPane($.ui.resolve(e), state, paneActions($))
  })

  on('ui.render', { component: 'Placed' }, async ($, e, next) => {
    const storyId = storyOfPlacedPath(e.props)
    const drawing = storyId === undefined ? false : await drawPlacedPath($, storyId, $.ui.resolve(e))

    return drawing === false ? next(e) : drawing
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const [summary, activity] = await Promise.all([read($, boardSummary), boardActivity($)])
    const band = drawBand($.ui.resolve(e), summary, activity, e.props.bodyColumns, () => openBoardPane($))

    return band ?? next(e)
  })

  // Drawing only: the row is rewritten, the call and what the model read are untouched. Expanded, the host's own row
  // shows, with the raw input.
  on('ui.render', { component: 'ToolUse', plugin: '*' }, async ($, e, next) => {
    if (e.props.isExpanded) return next(e)
    const run = e.props.tool === 'Agent' ? runOfToolUse(await read($, agentRuns), e.props.tool_use_id) : undefined
    const row = boardToolRow(e.props, run, idsOfLastBoardRead())

    return row === undefined ? next(e) : drawToolRow($.ui.resolve(e), toolRowLabel(e.props.tool), row)
  }).catch(($, e, next) => next(e))

  // Only notes what the read's row will say, so the next read can tell it repeats; the answer is handed on untouched.
  on('tool.call', { tool: BOARD_READING_TOOL }, async ($, e, next) => {
    const answer = await next(e)
    if (answer.deny === undefined) boardReads = withBoardRead(boardReads, e.tool_use_id, boardReadLine(await read($, boardSummary)))

    return answer
  }).catch(($, e, next) => next(e))

  // Drawing only. What a board read returns is written for the model, so a person gets one line of what is open;
  // expanded, the host shows all of it.
  on('ui.render', { component: 'ToolResult', plugin: '*' }, async ($, e, next) => {
    if (e.props.isExpanded || e.props.isErrored || e.props.tool !== BOARD_READING_TOOL) return next(e)
    if (boardReads.repeatedIds.includes(e.props.tool_use_id)) return drawNothing($.ui.resolve(e))

    return drawBoardReadResult($.ui.resolve(e), boardReads.linesById[e.props.tool_use_id] ?? boardReadLine(await read($, boardSummary)))
  }).catch(($, e, next) => next(e))
}
