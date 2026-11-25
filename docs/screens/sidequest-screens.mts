// Sidequest's screens, drawn from a state of the made-up story with the plugin's own pane, band and tool-row code.
// What the pane hook reads from its state when the host asks it to draw is put together here from the same functions.
import type { RenderPropsOf } from 'claude-code'

import { boardIdsOf } from '../../plugins/sidequest/hooks/board-ids.ts'
import { NO_INTERRUPTED_WORK } from '../../plugins/sidequest/hooks/interrupted-work.ts'
import { withoutProposedTickets } from '../../plugins/sidequest/hooks/proposed-tickets.ts'
import { summarize } from '../../plugins/sidequest/hooks/summary.ts'
import type { Story, Ticket } from '../../plugins/sidequest/hooks/tickets.ts'
import { whatThePersonCouldDo } from '../../plugins/sidequest/hooks/what-can-move.ts'
import { NO_PLAN_FORM, NO_TICKET_FORM, planFormFor, ticketFormFor } from '../../plugins/sidequest/hooks/views/answer-form.ts'
import { drawBand } from '../../plugins/sidequest/hooks/views/band.tsx'
import {
  boardCards,
  doingTicketsIn,
  oldestWaitingOf,
  piecesWaitingOnYou,
  returnedTicketsIn,
  storiesToRead,
  storyDetail,
  ticketDetail,
} from '../../plugins/sidequest/hooks/views/board-view.ts'
import { finishedAgentDetail, transcriptOf } from '../../plugins/sidequest/hooks/views/finished-agents.ts'
import { drawBoardPane } from '../../plugins/sidequest/hooks/views/pane.tsx'
import type { BoardPaneActions } from '../../plugins/sidequest/hooks/views/pane.tsx'
import { boardPaneLines } from '../../plugins/sidequest/hooks/views/pane-sections.ts'
import { runningAgentRows } from '../../plugins/sidequest/hooks/views/running-agents.ts'
import type { BoardActivity } from '../../plugins/sidequest/hooks/views/running-agents.ts'
import { drawToolRow } from '../../plugins/sidequest/hooks/views/tool-row.tsx'
import { boardToolRow, toolRowLabel } from '../../plugins/sidequest/hooks/views/tool-rows.ts'
import type { FinishedAgentDetail, PlanForm, TicketForm } from '../../plugins/sidequest/types/index.d.ts'

import { HOST_ELEMENTS, elementHtml } from './host-drawing.mts'
import { escapedText, paneFrame, saidByThePerson, sessionLayout, terminalWindow } from './pages.mts'
import type { BoardMoment, ChatEntry } from './sidequest-story.mts'

const PANE_ROWS_ENOUGH_FOR_ALL = 400

const nothing = async (): Promise<void> => undefined

// Every press on a picture goes nowhere.
const NO_PRESSES: BoardPaneActions = {
  openTicket: nothing,
  openStory: nothing,
  openStoryDecisions: nothing,
  closeStory: nothing,
  pickAnswer: nothing,
  tickAlsoYours: nothing,
  showWholeTicket: nothing,
  typeTicketWords: nothing,
  sendTicketAnswer: nothing,
  keepTicketWords: nothing,
  keepPlanWords: nothing,
  sendTicketRemark: nothing,
  sendStoryRemark: nothing,
  togglePlanAnswer: nothing,
  typePlanWords: nothing,
  sendPlanAnswers: nothing,
  sayYesToPlan: nothing,
  approveCheckpoint: nothing,
  viewAgent: nothing,
  closeTicket: nothing,
  showSetAside: nothing,
  closeSetAside: nothing,
  showOlder: nothing,
  closeOlder: nothing,
  setAsideTicket: nothing,
  dropTicket: nothing,
  tidyWorktrees: nothing,
  openFinishedAgent: nothing,
  closeFinishedAgent: nothing,
  showMoreFinished: nothing,
  closeMoreFinished: nothing,
}

const touchedOf = (moment: BoardMoment): Set<string> => new Set(moment.files.tickets.map(ticket => ticket.id))

const openWorkOf = (moment: BoardMoment): Ticket[] => withoutProposedTickets(moment.files.tickets, moment.files.stories)

const cardsOf = (moment: BoardMoment) =>
  boardCards(openWorkOf(moment), moment.files.config, NO_INTERRUPTED_WORK, {
    stories: moment.files.stories,
    checkedOutBranch: moment.files.checkedOutBranch,
    touched: touchedOf(moment),
  })

const paneContentOf = (moment: BoardMoment, columns: number) => ({
  cards: cardsOf(moment),
  running: runningAgentRows([], moment.agents, moment.runs),
  sessionWork: { isWorking: false, steps: 0 },
  finishedAgents: moment.finishedAgents,
  worktreeCount: 0,
  showsIntro: false,
  whatYouCouldDo: whatThePersonCouldDo(openWorkOf(moment)),
  storiesToRead: storiesToRead(moment.files.stories, moment.files.tickets, moment.now),
  touchedHere: touchedOf(moment),
  columns,
  now: moment.now,
  hasMainView: true,
})

// What is opened in the pane, and what the person has picked or typed in its form so far.
export type Opened = { ticket?: string; story?: string; finishedAgent?: string; ticketForm?: Partial<TicketForm>; planForm?: Partial<PlanForm> }

const paneProps = (columns: number): RenderPropsOf['Pane'] => ({
  title: 'Board',
  isFocused: false,
  bodyColumns: columns,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: PANE_ROWS_ENOUGH_FOR_ALL },
  view: {},
})

const storyOf = (moment: BoardMoment, ticket: Ticket): Story | undefined => moment.files.stories.find(story => story.id === ticket.story)

const openedTicket = (moment: BoardMoment, id: string | undefined) => {
  const ticket = moment.files.tickets.find(one => one.id === id)
  return ticket === undefined ? null : ticketDetail(ticket, storyOf(moment, ticket))
}

const openedStory = (moment: BoardMoment, id: string | undefined) => {
  const story = moment.files.stories.find(one => one.id === id)
  return story === undefined ? null : storyDetail(story, story.awaitsYes === true ? moment.files.tickets : [])
}

// The host's tasks list still shows an agent that has just returned, so its View works.
const openedFinishedAgent = (moment: BoardMoment, id: string | undefined): FinishedAgentDetail | null => {
  const agent = moment.finishedAgents.find(one => one.agentId === id)
  return agent === undefined ? null : finishedAgentDetail(agent, transcriptOf(agent.agentId, [agent.agentId], true))
}

const formsOf = (opened: Opened, ticketId: string, storyId: string) => ({
  ticket: { ...ticketFormFor(NO_TICKET_FORM, ticketId), ...opened.ticketForm },
  plan: { ...planFormFor(NO_PLAN_FORM, storyId), ...opened.planForm },
})

const summaryOf = (moment: BoardMoment) => summarize(openWorkOf(moment), touchedOf(moment), moment.now)

export const paneDrawing = (moment: BoardMoment, columns: number, opened: Opened = {}): string => {
  const detail = openedTicket(moment, opened.ticket)
  const story = openedStory(moment, opened.story)
  const state = {
    props: paneProps(columns),
    summary: summaryOf(moment),
    lines: boardPaneLines(paneContentOf(moment, columns)),
    setAside: null,
    older: null,
    detail,
    story,
    finishedAgent: openedFinishedAgent(moment, opened.finishedAgent),
    moreFinished: null,
    forms: formsOf(opened, detail?.id ?? '', story?.id ?? ''),
  }

  return paneFrame('Board', columns, elementHtml(drawBoardPane(HOST_ELEMENTS, state, NO_PRESSES)))
}

const activityOf = (moment: BoardMoment): BoardActivity => {
  const cards = cardsOf(moment)
  const touched = touchedOf(moment)

  return {
    agents: moment.agents,
    runs: moment.runs,
    waits: {},
    doingTickets: doingTicketsIn(cards),
    returnedTickets: returnedTicketsIn(cards),
    oldestWaitingMs: oldestWaitingOf(cards, moment.now, touched),
    piecesWaitingOnYou: piecesWaitingOnYou(cards, moment.now, touched),
  }
}

const bandDrawing = (moment: BoardMoment, columns: number): string =>
  elementHtml(drawBand(HOST_ELEMENTS, summaryOf(moment), activityOf(moment), columns, async () => undefined) ?? null)

// A row the plugin leaves to the host (none in this story) would be drawn by the host, so it is left out.
const chatEntryDrawing = (moment: BoardMoment, entry: ChatEntry): string => {
  if ('saidByThePerson' in entry) return saidByThePerson(escapedText(entry.saidByThePerson))
  const row = boardToolRow({ tool: entry.tool, input: entry.input, output: entry.output, isErrored: false }, entry.run, boardIdsOf(moment.files.config.prefix))

  return row === undefined ? '' : `<div>${elementHtml(drawToolRow(HOST_ELEMENTS, toolRowLabel(entry.tool), row))}</div>`
}

const CHAT_COLUMNS = 64
const DOCKED_PANE_COLUMNS = 48
const OPENED_PANE_COLUMNS = 64

/** The terminal: the chat since the person last spoke, the band above the prompt, the board docked beside it. */
export const sessionWithTheBoard = (moment: BoardMoment): string =>
  terminalWindow(
    'claude',
    sessionLayout({
      chatRows: moment.chat.map(entry => chatEntryDrawing(moment, entry)),
      band: bandDrawing(moment, CHAT_COLUMNS),
      pane: paneDrawing(moment, DOCKED_PANE_COLUMNS),
      chatColumns: CHAT_COLUMNS,
    }),
  )

/** The board's list on its own, as wide as an opened view so each row's model and time fit. */
export const boardOnly = (moment: BoardMoment): string => terminalWindow('claude', paneDrawing(moment, OPENED_PANE_COLUMNS))

export const opened = (moment: BoardMoment, what: Opened): string => terminalWindow('claude', paneDrawing(moment, OPENED_PANE_COLUMNS, what))

export const ticketIdOf = (moment: BoardMoment, title: string): string => {
  const ticket = moment.files.tickets.find(one => one.title === title)
  if (ticket === undefined) throw new Error(`no ticket "${title}" on the board at ${moment.state}`)
  return ticket.id
}

export const storyIdOf = (moment: BoardMoment): string => {
  const story = moment.files.stories[0]
  if (story === undefined) throw new Error(`no plan on the board at ${moment.state}`)
  return story.id
}

/** The same moment a few minutes on: nothing changed on the board, only the clock the rows count from. */
export const minutesLater = (moment: BoardMoment, minutes: number): BoardMoment => ({ ...moment, now: moment.now + minutes * 60_000 })
