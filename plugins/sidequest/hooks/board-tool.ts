import { finishNowLines } from './agent-returns'
import { boardConfigProblems } from './board-config'
import { unusableFileLines, unusableFileProblem } from './board-folder'
import type { BoardFolder } from './board-folder'
import { closingReportText, NO_SESSION_CHANGES } from './closing-report'
import type { SessionChanges } from './closing-report'
import type { BeforeBuilding, SharedThing } from './board-config'
import { otherBranchLines, ticketHandle } from './branch-and-issue'
import { nothingStartsWords, readyWaits, waitLines } from './blocked-work'
import { droppedBlockerIds } from './drop'
import { inboxLines } from './inbox-age'
import { proposedTicketsAmong, withoutProposedTickets } from './proposed-tickets'
import { pathAsMermaid } from './pull-request-diagram'
import { withoutSettledWork } from './settled-work'
import { frontierOf } from './frontier'
import { waitsOnHuman } from './human-answers'
import { interruptedLabel, interruptedSummaryLines, NO_INTERRUPTED_WORK } from './interrupted-work'
import type { InterruptedWork } from './interrupted-work'
import type { StoriesAndCheckout } from './pieces-of-work'
import { heldThingsFor, waitsForWords } from './shared-things'
import type { BoardFiles } from './store'
import { statusCountsInWords } from './status-words'
import { summarize } from './summary'
import { NO_TEAM_FACTS, theirsSummaryLines, withoutTheirs } from './team-work'
import type { TeamFacts } from './team-work'
import { idNumber, inIdOrder, oneLine, serializeStory, serializeTicket, TICKET_STATUSES } from './tickets'
import type { Story, Ticket } from './tickets'
import { ignoredFieldsNote, textOf } from './tool-input'
import type { JsonRecord, ToolAnswer } from './tool-input'
import { alsoOnBoardLines, withHowToSee } from './unnamed-work'
import { answeredOnTheBoardNames, waitingText } from './waiting-view'
import { whatCanMoveText } from './what-can-move'

export const BOARD_VIEWS = ['summary', 'waiting', 'now', 'closing', 'frontier', 'list', 'ticket', 'routing', 'planning', 'diagram'] as const
type BoardView = (typeof BOARD_VIEWS)[number]

const BOARD_FIELDS = ['view', 'status', 'id', 'of']

const isBoardView = (value: string | undefined): value is BoardView => BOARD_VIEWS.some(view => view === value)


const ticketLine = (ticket: Ticket): string => `${ticketHandle(ticket)} ${ticket.status} ${ticket.category} ${ticket.title}`

const interruptedNote = (ticket: Ticket, interrupted: InterruptedWork): string => {
  const words = interrupted.get(ticket.id)

  return words === undefined ? '' : ` (${interruptedLabel(words)})`
}

const droppedBlockerNote = (ticket: Ticket, tickets: readonly Ticket[]): string => {
  const dropped = droppedBlockerIds(ticket, tickets)

  return dropped.length === 0 ? '' : ` (blocked by dropped ${dropped.join(', ')})`
}

const listLine = (ticket: Ticket, tickets: readonly Ticket[], interrupted: InterruptedWork): string =>
  `${ticketLine(ticket)}${interruptedNote(ticket, interrupted)}${droppedBlockerNote(ticket, tickets)}`

const PROPOSED_NOTE = ' (proposed, waiting for the yes on its plan)'

// Filed at the playback, a plan's tickets are no open work until its yes: never counted, listed as open or started.
// A board whose tickets are all proposed is not empty, so it never says it found no ticket files.
const openWorkOf = (files: BoardFiles): BoardFiles => {
  const tickets = withoutProposedTickets(files.tickets, files.stories)
  const { folderRead, ...rest } = files

  return tickets.length === files.tickets.length ? files : { ...rest, tickets }
}

const proposedLines = (files: BoardFiles): string[] => {
  const proposed = inIdOrder(proposedTicketsAmong(files.tickets, files.stories))

  return proposed.length === 0 ? [] : [`Proposed, waiting for the yes on their plan, so not open work yet: ${proposed.map(ticket => ticket.id).join(', ')}.`]
}

const linesOr = (lines: string[], whenEmpty: string): string => (lines.length > 0 ? lines.join('\n') : whenEmpty)

// An empty board.json is taken as missing: the next write puts it back.
const boardProblemsOf = (files: BoardFiles): string[] =>
  files.configText === undefined || files.configText.trim() === '' ? [] : boardConfigProblems(files.configText)

const withFileLines = (text: string, files: BoardFiles, folder?: BoardFolder): string =>
  [text, ...unusableFileLines(files.unusableFiles, folder)].join('\n')

// A board that reads empty may be the wrong folder, so the answer names the one it read.
const emptyBoardLines = (files: BoardFiles): string[] =>
  files.tickets.length === 0 && files.folderRead !== undefined ? [`No ticket files in ${files.folderRead}.`] : []

const withProblems = (files: BoardFiles, text: string): string =>
  [...boardProblemsOf(files).map(problem => `board.json problem: ${problem}`), text].join('\n')

const waitingViewLine = (tickets: readonly Ticket[], projectName: string | undefined): string => {
  if (!tickets.some(waitsOnHuman)) return ''
  const inProject = projectName === undefined ? '' : ` in ${projectName}`

  return ` The waiting view writes what waits on the person${inProject}, ready to pass on, to answer in this chat.`
}

// The answer is on the board and in the file, but nothing has moved the ticket yet: the session reading this picks it up.
const answeredNotActedOnLines = (files: BoardFiles): string[] => {
  const names = answeredOnTheBoardNames(files.tickets, files.stories)

  if (names.length === 0) return []
  const them = names.length === 1 ? 'it' : 'them'

  return [`Answered on the board, nobody has acted on ${them} yet, so act on ${them} or ask again: ${names.join(', ')}.`]
}

// Measured on a board of 2,000 tickets: the summary named all 116 ready ids. Ten say what is next, the count the rest.
const MOST_READY_NAMED = 10

const readyToStartLine = (next: readonly string[], readyCount: number): string => {
  if (next.length === 0) return nothingStartsWords(readyCount)
  const more = next.length - MOST_READY_NAMED

  return `Ready to start: ${next.slice(0, MOST_READY_NAMED).join(', ')}${more > 0 ? `, and ${more} more` : ''}.`
}

const blockedLines = (files: BoardFiles, startable: readonly Ticket[]): string[] =>
  waitLines(readyWaits(files.tickets, startable.length > 0, files.config.settings.worktrees))

const summaryText = (files: BoardFiles, interrupted: InterruptedWork, team: TeamFacts, changes: SessionChanges, now: number): string => {
  const counts = summarize(files.tickets)
  const startable = frontierOf(inIdOrder(files.tickets), files.config.settings.worktrees)
  const nextLine = readyToStartLine(startable.map(ticket => ticket.id), counts.ready)
  const counted = `${statusCountsInWords(counts)}. ${nextLine}${waitingViewLine(files.tickets, files.projectName)}`
  const inboxCount = files.tickets.filter(ticket => ticket.status === 'inbox').length
  const unnamedWorkLines = withHowToSee(
    inboxLines(files.tickets, startable.length === 0, now),
    alsoOnBoardLines(files.tickets, new Set(changes.keys())),
    inboxCount,
  )
  const theirs = team.committedLastBySomeoneElse
  const lines = [
    ...finishNowLines(files.tickets),
    counted,
    ...answeredNotActedOnLines(files),
    ...blockedLines(files, startable),
    ...unnamedWorkLines,
    ...interruptedSummaryLines(files.tickets, withoutTheirs(interrupted, theirs), changes.size > 0),
    ...theirsSummaryLines(files.tickets, theirs),
    ...otherBranchLines(inIdOrder(files.tickets), files.checkedOutBranch),
    ...emptyBoardLines(files),
  ]

  return withProblems(files, withFileLines(lines.join('\n'), files))
}

const summaryWithProposed = (files: BoardFiles, interrupted: InterruptedWork, team: TeamFacts, changes: SessionChanges, now: number): string =>
  [summaryText(openWorkOf(files), interrupted, team, changes, now), ...proposedLines(files)].join('\n')

const heldNote = (ticket: Ticket, files: BoardFiles): string => {
  const held = heldThingsFor(ticket, files.tickets, files.config)

  return held.length === 0 ? '' : ` (${waitsForWords(held)})`
}

const frontierText = (files: BoardFiles): string => {
  const startable = frontierOf(inIdOrder(files.tickets), files.config.settings.worktrees)
  const lines = startable.map(ticket => `${ticketLine(ticket)}${heldNote(ticket, files)}`)

  return [linesOr(lines, 'Nothing is ready to start.'), ...blockedLines(files, startable)].join('\n')
}

const withNote = (answer: ToolAnswer, note: string): ToolAnswer =>
  'text' in answer && note !== '' ? { text: `${answer.text}${note}` } : answer

const isKnownStatus = (status: string | undefined): status is string => TICKET_STATUSES.some(known => known === status)

const LISTED_KINDS = ['tickets', 'stories']

const storyLine = (story: Story, files: BoardFiles): string => {
  const ticketCount = files.tickets.filter(ticket => ticket.story === story.id).length

  return `${story.id} ${story.title} (${ticketCount} ${ticketCount === 1 ? 'ticket' : 'tickets'})`
}

const storyListAnswer = (files: BoardFiles): ToolAnswer => {
  const lines = [...files.stories].sort((left, right) => idNumber(left.id) - idNumber(right.id)).map(story => storyLine(story, files))

  return { text: withFileLines(linesOr(lines, 'No stories on this board.'), files, 'stories') }
}

const unknownStatusNote = (status: string | undefined, isSettledWorkLeftOut: boolean): string =>
  status === undefined || isKnownStatus(status)
    ? ''
    : `\nstatus "${status}" is not one of ${TICKET_STATUSES.join(', ')}, so this is ${isSettledWorkLeftOut ? 'the list with no status' : 'every ticket'}.`

const proposedListLine = (files: BoardFiles, interrupted: InterruptedWork): ((ticket: Ticket) => string) => {
  const proposed = new Set(proposedTicketsAmong(files.tickets, files.stories).map(ticket => ticket.id))

  return ticket => `${listLine(ticket, files.tickets, interrupted)}${proposed.has(ticket.id) ? PROPOSED_NOTE : ''}`
}

const ticketListAnswer = (files: BoardFiles, status: string | undefined, interrupted: InterruptedWork): ToolAnswer => {
  const matching = inIdOrder(files.tickets).filter(ticket => !isKnownStatus(status) || ticket.status === status)
  const listed = isKnownStatus(status) ? { shown: matching, settledLine: [] } : withoutSettledWork(matching)
  const lines = [...listed.shown.map(proposedListLine(files, interrupted)), ...listed.settledLine]
  const emptyBoardNote = emptyBoardLines(files).map(line => `\n${line}`).join('')
  const note = unknownStatusNote(status, listed.settledLine.length > 0)

  return { text: `${withFileLines(linesOr(lines, 'No tickets match.'), files, 'tickets')}${emptyBoardNote}${note}` }
}

const unknownListedNote = (listed: string | undefined): string =>
  listed === undefined || LISTED_KINDS.includes(listed) ? '' : `\nof "${listed}" is not one of ${LISTED_KINDS.join(', ')}, so this lists tickets.`

const listAnswer = (files: BoardFiles, input: JsonRecord, interrupted: InterruptedWork): ToolAnswer => {
  const listed = textOf(input, 'of')
  const answer = listed === 'stories' ? storyListAnswer(files) : ticketListAnswer(files, textOf(input, 'status'), interrupted)

  return withNote(answer, unknownListedNote(listed))
}

// The handle leads only when it says more than the id, so a plain ticket still reads as its file.
const ticketViewText = (ticket: Ticket): string => {
  const handle = ticketHandle(ticket)

  return handle === ticket.id ? serializeTicket(ticket) : `${handle}\n${serializeTicket(ticket)}`
}

const fileTextOf = (files: BoardFiles, id: string | undefined): string | undefined => {
  const ticket = files.tickets.find(candidate => candidate.id === id)
  const story = files.stories.find(candidate => candidate.id === id)

  return ticket ? ticketViewText(ticket) : story && serializeStory(story)
}

const NO_ID_NOTE = '\nNo id was given, so this is the ticket list.'

const ticketAnswer = (files: BoardFiles, id: string | undefined, interrupted: InterruptedWork): ToolAnswer => {
  if (id === undefined) return withNote(ticketListAnswer(files, undefined, interrupted), NO_ID_NOTE)
  const text = fileTextOf(files, id)

  if (text !== undefined) return { text }

  return { refusal: unusableFileProblem(files.unusableFiles, id) ?? `No ticket or story ${id} on this board. The list view shows every ticket id.` }
}

const sharedLines = (shared: Record<string, SharedThing> | undefined): string[] =>
  Object.entries(shared ?? {}).map(([name, thing]) => `shared ${name}: ${oneLine(thing.what)} Picks up new code: ${thing.refresh}.`)

const beforeBuildingLines = (step: BeforeBuilding | undefined): string[] =>
  step === undefined ? [] : [`before building: ${oneLine(step.label)}. How: ${oneLine(step.how)}. Read back: ${step.readBack === undefined ? 'not set' : oneLine(step.readBack)}`]

const pullRequestDiagramLine = (setting: boolean | undefined): string =>
  `pullRequestDiagram: ${setting === undefined ? 'not asked yet' : setting ? 'yes' : 'no'}`

const diagramAnswer = (files: BoardFiles, id: string | undefined): ToolAnswer => {
  const story = files.stories.find(candidate => candidate.id === id)
  if (story === undefined) return { refusal: `No story ${id ?? ''} on this board. The list view with of stories shows every story id.` }

  return story.path.length === 0 ? { text: `${story.id} has no path, so there is no diagram to draw.` } : { text: pathAsMermaid(story.path) }
}

const routingText = (files: BoardFiles): string => {
  const { categories, tiers, settings } = files.config
  const { shared, checks, beforeBuilding, pullRequestDiagram, ...plainSettings } = settings
  const lines = Object.entries(categories).map(([name, category]) => {
    const tier = tiers[category.tier]
    const route = tier ? `${tier.model}/${tier.effort}` : 'no such tier'

    return `${name}: ${category.role}, tier ${category.tier}, ${route}. ${category.description}`
  })

  return withProblems(files, [...lines, `settings: ${JSON.stringify(plainSettings)}`, `checks: ${checks === undefined ? 'not written down' : oneLine(checks)}`, ...beforeBuildingLines(beforeBuilding), pullRequestDiagramLine(pullRequestDiagram), ...sharedLines(shared)].join('\n'))
}

const textOfAnswer = (answer: ToolAnswer): string => ('text' in answer ? answer.text : answer.refusal)

const LEFT_OUT_OF_PLANNING = ['done', 'dropped']

const leftOutLine = (leftOut: readonly Ticket[]): string => {
  const countOf = (status: string): number => leftOut.filter(ticket => ticket.status === status).length

  return `${countOf('done')} done and ${countOf('dropped')} dropped left out: list with a status to see them`
}

const openTicketsText = (files: BoardFiles, interrupted: InterruptedWork): string => {
  const ordered = inIdOrder(files.tickets)
  const open = ordered.filter(ticket => !LEFT_OUT_OF_PLANNING.includes(ticket.status))
  const leftOut = ordered.filter(ticket => LEFT_OUT_OF_PLANNING.includes(ticket.status))
  const lines = open.map(ticket => listLine(ticket, files.tickets, interrupted))

  return [...(lines.length > 0 ? lines : ['No open tickets.']), ...(leftOut.length > 0 ? [leftOutLine(leftOut)] : [])].join('\n')
}

const planningText = (files: BoardFiles, interrupted: InterruptedWork): string => {
  const stories = textOfAnswer(storyListAnswer(files))

  return [routingText(files), 'stories:', stories, 'open tickets:', openTicketsText(openWorkOf(files), interrupted), ...proposedLines(files)].join('\n')
}

const storiesAndCheckoutOf = (files: BoardFiles): StoriesAndCheckout => ({
  stories: files.stories,
  ...(files.checkedOutBranch === undefined ? {} : { checkedOutBranch: files.checkedOutBranch }),
  ...(files.projectName === undefined ? {} : { projectName: files.projectName }),
})

type ViewAnswer = (
  files: BoardFiles,
  input: JsonRecord,
  stamp: string,
  interrupted: InterruptedWork,
  team: TeamFacts,
  changes: SessionChanges,
  noAgentHere: InterruptedWork,
) => ToolAnswer

const VIEW_ANSWERS: Record<BoardView, ViewAnswer> = {
  summary: (files, input, stamp, interrupted, team, changes) => ({ text: summaryWithProposed(files, interrupted, team, changes, Date.parse(stamp)) }),
  waiting: (files, input, stamp, interrupted, team, changes) => ({
    text: waitingText(files.tickets, team.pullRequests, Date.parse(stamp), new Set(changes.keys()), storiesAndCheckoutOf(files)),
  }),
  now: (files, input, stamp, interrupted, team, changes, noAgentHere) => ({
    text: whatCanMoveText(openWorkOf(files).tickets, files.config, stamp, noAgentHere, team.committedLastBySomeoneElse, new Set(changes.keys()), storiesAndCheckoutOf(files)),
  }),
  closing: (files, input, stamp, interrupted, team, changes) => ({ text: closingReportText(files.tickets, changes, interrupted, storiesAndCheckoutOf(files)) }),
  frontier: files => ({ text: frontierText(openWorkOf(files)) }),
  list: (files, input, stamp, interrupted, team, changes, noAgentHere) => listAnswer(files, input, noAgentHere),
  ticket: (files, input, stamp, interrupted, team, changes, noAgentHere) => ticketAnswer(files, textOf(input, 'id'), noAgentHere),
  routing: files => ({ text: routingText(files) }),
  planning: (files, input, stamp, interrupted, team, changes, noAgentHere) => ({ text: planningText(files, noAgentHere) }),
  diagram: (files, input) => diagramAnswer(files, textOf(input, 'id')),
}

const unknownViewNote = (view: string | undefined): string => {
  const given = view === undefined ? 'No view was given' : `view "${view}" is not one of ${BOARD_VIEWS.join(', ')}`

  return isBoardView(view) ? '' : `\n${given}, so this is the summary.`
}

const ignoredNote = (input: JsonRecord): string => {
  const note = ignoredFieldsNote(input, BOARD_FIELDS).trim()

  return note === '' ? '' : `\n${note}`
}

export const boardViewOf = (input: JsonRecord): BoardView => {
  const view = textOf(input, 'view')

  return isBoardView(view) ? view : 'summary'
}

// These name a board.json problem on every read, so a line saying it once would only repeat it.
export const viewNamesBoardJsonProblems = (input: JsonRecord): boolean => ['summary', 'routing', 'planning'].includes(boardViewOf(input))

// Only an id that is not on the board is refused, since there is nothing to show. Anything else answers the nearest
// view and says what it left out.
export const answerBoardView = (
  input: JsonRecord,
  files: BoardFiles,
  stamp: string,
  interrupted: InterruptedWork = NO_INTERRUPTED_WORK,
  team: TeamFacts = NO_TEAM_FACTS,
  changes: SessionChanges = NO_SESSION_CHANGES,
  noAgentHere: InterruptedWork = interrupted,
): ToolAnswer => {
  const view = textOf(input, 'view')
  const answer = VIEW_ANSWERS[boardViewOf(input)](files, input, stamp, interrupted, team, changes, noAgentHere)

  return withNote(answer, `${unknownViewNote(view)}${ignoredNote(input)}`)
}
