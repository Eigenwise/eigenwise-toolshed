import { isRecord } from './board-config'
import type { BoardConfig } from './board-config'
import { boardFilePath, unusableFileProblem } from './board-folder'
import type { UnusableFile } from './board-folder'
import { boardIdsOf, idsOnBoard, nextNumberAfter, storyIdOn, ticketIdOn } from './board-ids'
import type { BoardIds, IdsOnBoard } from './board-ids'
import { choosePrefix, prefixChoiceNote, withMoreTrackerKeys } from './board-prefix'
import type { PrefixFacts } from './board-prefix'
import { trackerKeyAtTitleStart, trackerKeysInBranch, withBranchAndIssue } from './branch-and-issue'
import { withForYouInput } from './for-you'
import { awaitsHumanAnswer } from './human-answers'
import { NO_PAIRS_SAID, noticeOnItsOwnLine, sameKeyNotice } from './leftover-conflicts'
import type { ConflictNotice } from './leftover-conflicts'
import { blockedByDroppedNote, blockedByDroppedWordsForThePerson, DROPPED, leftoversOf, noLeftoversNote, noLeftoversWordsForThePerson, setAsideNote } from './drop'
import { statusWords } from './status-words'
import type { RunLeftovers } from './drop'
import { DEFAULT_CATEGORY, fallbackCategoryOf, hasRoute } from './routing'
import { unknownThingsOf } from './shared-things'
import type { BoardChange, BoardFiles, BriefFile } from './store'
import { repairedTicketCall } from './ticket-call-repair'
import { repairedTicketPatch } from './ticket-field-repair'
import {
  appendLogLine,
  applyStoryPatch,
  applyTicketPatch,
  inIdOrder,
  newStory,
  newTicket,
  oneLine,
  validateTicket,
  withoutEmptyOptionalFields,
  withoutPlaybackAnswer,
} from './tickets'
import type { Decision, Story, StoryPatch, Ticket, TicketPatch } from './tickets'
import { chatAfterPlan, chatAfterPlayback, longShortVersionNote } from './plan-in-the-chat'
import type { ChatEnding } from './chat-ending'
import { chatAfterSayingYesTo, commitQuestionAmong, commitQuestionOf, isPastTheYes } from './commit-question-in-the-chat'
import { parseForYou } from './for-you'
import { proposedTicketsOf } from './proposed-tickets'
import { wordsChangedAfterTheYesLine } from './saying-yes-to'
import type { OpenQuestion } from './decisions-for-you'
import type { Excerpt, PathStep } from '../types'
import { inputProblems, isTextList, refusalOf, textOf } from './tool-input'
import type { FieldTable, InputShape, JsonRecord, ToolAnswer } from './tool-input'
import { nowWaitingNote, waitingAroundWrite } from './waiting-view'
import type { WaitingAround } from './waiting-view'
import { planStopNote, planStopOf } from './plan-stop'
import { turnPhrase } from './whose-words'
import type { TurnWords } from './whose-words'

export const OPERATION_NAMES = ['create', 'story', 'patch', 'move', 'note', 'stop', 'drop'] as const
type OperationName = (typeof OPERATION_NAMES)[number]

export const TICKET_FIELDS: FieldTable = {
  title: 'text',
  what: 'text',
  doneWhen: 'text',
  status: 'text',
  kind: 'text',
  mode: 'text',
  category: 'text',
  story: 'text',
  branch: 'text',
  issue: 'text',
  pullRequest: 'text',
  startedBy: 'text',
  blockedBy: 'list',
  decisions: 'list',
  uses: 'list',
  forYou: 'forYou',
}

export const STORY_FIELDS: FieldTable = {
  title: 'text',
  destination: 'text',
  inShort: 'text',
  outOfScope: 'text',
  handOver: 'text',
  analysis: 'text',
  decisions: 'decisions',
  questions: 'questions',
  path: 'path',
  excerpts: 'excerpts',
  awaitsYes: 'yesNo',
}

const TICKET_TEXT_KEYS = ['title', 'what', 'doneWhen', 'status', 'kind', 'mode', 'category', 'story', 'branch', 'issue', 'pullRequest', 'startedBy'] as const
const TICKET_LIST_KEYS = ['blockedBy', 'decisions', 'uses'] as const
const STORY_TEXT_KEYS = ['title', 'destination', 'inShort', 'outOfScope', 'handOver', 'analysis'] as const

const textOr = (record: JsonRecord, key: string, fallback: string): string => textOf(record, key) ?? fallback

const patchShapeFor = (operation: JsonRecord, ids: IdsOnBoard): InputShape => {
  const id = textOr(operation, 'id', '')

  return { fields: { id: 'text', ...(ids.isStoryId(id) ? STORY_FIELDS : TICKET_FIELDS) }, required: ['id'] }
}

const OPERATION_SHAPES: Record<OperationName, (operation: JsonRecord, ids: IdsOnBoard) => InputShape> = {
  create: () => ({ fields: TICKET_FIELDS, required: ['title'] }),
  story: () => ({ fields: STORY_FIELDS, required: ['title'] }),
  patch: patchShapeFor,
  move: () => ({ fields: { id: 'text', status: 'text' }, required: ['id', 'status'] }),
  note: () => ({ fields: { id: 'text', text: 'text' }, required: ['id', 'text'] }),
  stop: () => ({ fields: { story: 'text' }, required: [] }),
  drop: () => ({ fields: { id: 'text' }, required: ['id'] }),
}

const isOperationName = (value: unknown): value is OperationName => OPERATION_NAMES.some(name => name === value)

const operationProblems = (operation: unknown, index: number, ids: IdsOnBoard): string[] => {
  const label = `operation ${index + 1}`
  if (!isRecord(operation)) return [`${label}: is not an object`]
  const name = operation.op
  if (!isOperationName(name)) return [`${label}: op "${String(name)}" is not one of ${OPERATION_NAMES.join(', ')}`]

  return inputProblems(operation, OPERATION_SHAPES[name](operation, ids), ['op']).map(problem => `${label} (${name}): ${problem}`)
}

export const ticketPatchFrom = (operation: JsonRecord): TicketPatch => {
  const patch: TicketPatch = {}
  for (const key of TICKET_TEXT_KEYS) {
    const value = operation[key]
    if (typeof value === 'string') patch[key] = value
  }
  for (const key of TICKET_LIST_KEYS) {
    const value = operation[key]
    if (isTextList(value)) patch[key] = value
  }

  return patch
}

const decisionFrom = (value: unknown): Decision => {
  const record = isRecord(value) ? value : {}

  return {
    question: textOr(record, 'question', ''),
    answer: textOr(record, 'answer', ''),
    decidedBy: textOr(record, 'decidedBy', 'human'),
  }
}

// Each part is one line, so the story file reads back the same questions; a recommended answer given as a list keeps
// one line per part.
const recommendedFrom = (record: JsonRecord): string => {
  const value = record.recommended

  return isTextList(value) ? value.map(oneLine).join('\n') : oneLine(textOr(record, 'recommended', ''))
}

const openQuestionFrom = (value: unknown): OpenQuestion => {
  const record = isRecord(value) ? value : {}

  return {
    question: oneLine(textOr(record, 'question', '')),
    recommended: recommendedFrom(record),
    otherCosts: oneLine(textOr(record, 'otherCosts', '')),
  }
}

const numberOr = (record: JsonRecord, key: string): number => {
  const value = record[key]

  return typeof value === 'number' ? value : 0
}

const pathStepFrom = (value: unknown): PathStep => {
  const record = isRecord(value) ? value : {}

  const step = { what: oneLine(textOr(record, 'what', '')), file: textOr(record, 'file', ''), line: numberOr(record, 'line'), note: oneLine(textOr(record, 'note', '')) }

  return record.changed === true ? { ...step, changed: true } : step
}

const excerptFrom = (value: unknown): Excerpt => {
  const record = isRecord(value) ? value : {}

  return { file: textOr(record, 'file', ''), firstLine: numberOr(record, 'firstLine'), lines: textOr(record, 'lines', '').replace(/\n+$/, '') }
}

const storyListsFrom = (operation: JsonRecord): StoryPatch => {
  const { decisions, questions, path, excerpts } = operation

  return {
    ...(Array.isArray(decisions) ? { decisions: decisions.map(decisionFrom) } : {}),
    ...(Array.isArray(questions) ? { questions: questions.map(openQuestionFrom) } : {}),
    ...(Array.isArray(path) ? { path: path.map(pathStepFrom) } : {}),
    ...(Array.isArray(excerpts) ? { excerpts: excerpts.map(excerptFrom) } : {}),
  }
}

const storyPatchFrom = (operation: JsonRecord): StoryPatch => {
  const patch: StoryPatch = storyListsFrom(operation)
  if (typeof operation.awaitsYes === 'boolean') patch.awaitsYes = operation.awaitsYes
  for (const key of STORY_TEXT_KEYS) {
    const value = operation[key]
    if (typeof value === 'string') patch[key] = value
  }

  return patch
}

// What the board knows about the turn a write happens in. The model never supplies it. A press on the pane happens
// outside any turn, so it is the person's by the press itself.
export type SessionTurn = {
  words: TurnWords | undefined
  ticketsThisSessionCreated: ReadonlySet<string>
  ticketsThisSessionTouched?: ReadonlySet<string>
  isPressOnTheBoard?: true
}

const NO_TURN_SEEN: SessionTurn = { words: undefined, ticketsThisSessionCreated: new Set() }

export const PRESS_ON_THE_BOARD: SessionTurn = { words: undefined, ticketsThisSessionCreated: new Set(), isPressOnTheBoard: true }

const PRESSED_BY_THE_PERSON = 'pressed on the board by the person'

// `forThePerson` is what a press on the board toasts in place of the words written for the model.
type DoneWrite = { id: string; words: string; forThePerson?: string }

type Working = {
  config: BoardConfig
  tickets: Map<string, Ticket>
  stories: Map<string, Story>
  changedTickets: Set<string>
  // Only created and patched tickets are checked whole: a move or note goes through however the file was hand-edited.
  editedTickets: Set<string>
  changedStories: Set<string>
  isConfigChanged: boolean
  createdTickets: string[]
  // What each write did, by the id it did it to, so an id whose write was skipped is never named as done.
  done: DoneWrite[]
  repairs: string[]
  notes: string[]
  personNotes: string[]
  problems: string[]
  stamp: string
  checkedOutBranch: string | undefined
  turn: SessionTurn
  leftovers: RunLeftovers[]
  // Only for a board with no prefix and nothing on it yet: what its first id needs to choose one.
  prefixFacts: PrefixFacts | undefined
  // Files on disk that are no ticket: a write that names one says why instead of saying it is not on the board.
  unusableFiles: readonly UnusableFile[]
  idsOnDisk: { tickets: readonly string[]; stories: readonly string[] }
  storyWithAnalysis?: string
  storyWithQuestions?: string
  storyGivenAPath?: string
  // The plan whose playback this write filed or corrected, and the proposed tickets whose words a correction changed.
  storyAwaitingYes?: string
  proposedChanged: Set<string>
}

// Seen on 2026-11-20: a create beside a ticket file that could not be read took that file's number. A file's name
// counts for new ids whether it was read or not.
const nextNumber = (counter: number, idsRead: Iterable<string>, idsOnDisk: readonly string[]): number =>
  nextNumberAfter(counter, [...idsRead, ...idsOnDisk])

const notOnBoardProblem = (working: Working, id: string): string =>
  unusableFileProblem(working.unusableFiles, id) ?? `no ticket ${id} on this board`

const putTicket = (working: Working, ticket: Ticket, done: string, forThePerson?: string): void => {
  working.tickets.set(ticket.id, ticket)
  working.changedTickets.add(ticket.id)
  working.done.push({ id: ticket.id, words: done, ...(forThePerson === undefined ? {} : { forThePerson }) })
}

const putStory = (working: Working, story: Story, done: string): void => {
  working.stories.set(story.id, story)
  working.changedStories.add(story.id)
  working.done.push({ id: story.id, words: done })
}

const changeTicket = (working: Working, id: string, change: (ticket: Ticket) => Ticket, done: string): void => {
  const ticket = working.tickets.get(id)
  if (ticket) putTicket(working, change(ticket), done)
  else working.problems.push(notOnBoardProblem(working, id))
}

const idsNow = (working: Working): BoardIds => boardIdsOf(working.config.prefix)

const idsOnThisBoard = (working: Working): IdsOnBoard => idsOnBoard(idsNow(working), working.tickets, working.stories)

// Chosen once, by the first id a new board gives out, and kept in board.json. A board that already had tickets gets no
// facts, so it stays on the ids it has.
const idsForNewId = (working: Working): BoardIds => {
  const facts = working.prefixFacts
  if (working.config.prefix !== undefined || facts === undefined) return idsNow(working)
  const choice = choosePrefix(facts)
  working.config = { ...working.config, prefix: choice.prefix }
  working.isConfigChanged = true
  working.notes.push(prefixChoiceNote(choice))

  return idsNow(working)
}

const repairedPatchFor = (working: Working, ticket: Ticket, patch: TicketPatch): TicketPatch => {
  const repaired = repairedTicketPatch(ticket, patch, idsOnThisBoard(working))
  working.repairs.push(...repaired.notes)

  return repaired.patch
}

const createTicket = (working: Working, operation: JsonRecord): void => {
  const number = nextNumber(working.config.nextTicket, working.tickets.keys(), working.idsOnDisk.tickets)
  const id = ticketIdOn(idsForNewId(working), number)
  working.config = { ...working.config, nextTicket: number + 1 }
  working.isConfigChanged = true
  working.editedTickets.add(id)
  working.createdTickets.push(id)
  const patch = repairedPatchFor(working, newTicket(id, {}, working.stamp), ticketPatchFrom(operation))
  const created = withForYouInput(newTicket(id, patch, working.stamp), operation.forYou)
  const ticket = withoutEmptyOptionalFields(withBranchAndIssue(created, working.checkedOutBranch, idsOnThisBoard(working).isTicketId))
  putTicket(working, ticket, `created ${id}`)
  noteProposedWrite(working, ticket, undefined)
}

const hasNewWords = (before: Ticket, after: Ticket): boolean =>
  before.title !== after.title || before.what !== after.what || before.doneWhen !== after.doneWhen

// A write on a plan's proposed tickets shows the plan again, with what a correction changed marked.
const noteProposedWrite = (working: Working, after: Ticket, before: Ticket | undefined): void => {
  const story = after.story === undefined ? undefined : working.stories.get(after.story)
  if (story?.awaitsYes !== true) return
  working.storyAwaitingYes = story.id
  if (story.playbackAnswerSent !== undefined) takeUpPlaybackAnswer(working, story)
  if (before !== undefined && hasNewWords(before, after)) working.proposedChanged.add(after.id)
}

// Tickets filed or corrected after the person's yes or correction ask for their yes anew. Kept off the answer's done
// list: the call wrote tickets, and the story only drops what the person sent.
const takeUpPlaybackAnswer = (working: Working, story: Story): void => {
  working.stories.set(story.id, withoutPlaybackAnswer(story))
  working.changedStories.add(story.id)
}

// What was shown is what is sent, so words that change after the person's yes are kept on the log for the closing message.
const withWordsChangeLogged = (working: Working, before: Ticket, after: Ticket): Ticket => {
  if (!isPastTheYes(after)) return after
  const line = wordsChangedAfterTheYesLine(parseForYou(before.forYou).sayingYesTo, parseForYou(after.forYou).sayingYesTo)

  return line === undefined ? after : appendLogLine(after, working.stamp, line)
}

const pressSuffix = (working: Working): string => (working.turn.isPressOnTheBoard ? `, ${PRESSED_BY_THE_PERSON}` : '')

const quoted = (text: string): string => JSON.stringify(oneLine(text))

const replacedValues = (before: Ticket, after: Ticket): string[] => [
  ...(before.status === after.status ? [] : [`status ${before.status} to ${after.status}`]),
  ...(before.title === after.title ? [] : [`title ${quoted(before.title)} to ${quoted(after.title)}`]),
]

// A bulk edit by patch once left no trace of what it replaced, so only the moves could be walked back from the files.
const withReplacedValuesLogged = (working: Working, before: Ticket, after: Ticket): Ticket => {
  const replaced = replacedValues(before, after)

  return replaced.length === 0 ? after : appendLogLine(after, working.stamp, `patched ${replaced.join(', ')}${pressSuffix(working)}`)
}

const patchedTicket = (working: Working, ticket: Ticket, operation: JsonRecord): Ticket => {
  const patch = repairedPatchFor(working, ticket, ticketPatchFrom(operation))
  const patched = withoutEmptyOptionalFields(withForYouInput(applyTicketPatch(ticket, patch, working.stamp), operation.forYou))
  const logged = withWordsChangeLogged(working, ticket, withReplacedValuesLogged(working, ticket, patched))
  noteProposedWrite(working, logged, ticket)

  return logged
}

const patchTicket = (working: Working, id: string, operation: JsonRecord): void => {
  working.editedTickets.add(id)
  changeTicket(working, id, ticket => patchedTicket(working, ticket, operation), `patched ${id}`)
}

const createStory = (working: Working, operation: JsonRecord): void => {
  const number = nextNumber(working.config.nextStory, working.stories.keys(), working.idsOnDisk.stories)
  const id = storyIdOn(idsForNewId(working), number)
  working.config = { ...working.config, nextStory: number + 1 }
  working.isConfigChanged = true
  putWrittenStory(working, newStory(id, '', working.stamp), operation, `created ${id}`)
}

const putWrittenStory = (working: Working, story: Story, operation: JsonRecord, done: string): void => {
  const patch = storyPatchFrom(operation)
  const written = applyStoryPatch(story, patch, working.stamp)
  putStory(working, written, done)
  if (patch.inShort) working.notes.push(...longShortVersionNote(written))
  if (patch.analysis) working.storyWithAnalysis = story.id
  if (patch.questions?.length) working.storyWithQuestions = story.id
  if (patch.awaitsYes === true) working.storyAwaitingYes = story.id
  if (isFirstPath(story, patch)) working.storyGivenAPath = story.id
}

const isFirstPath = (story: Story, patch: StoryPatch): boolean => story.path.length === 0 && (patch.path ?? []).length > 0

const patchStory = (working: Working, id: string, operation: JsonRecord): void => {
  const story = working.stories.get(id)
  if (story) putWrittenStory(working, story, operation, `patched ${id}`)
  else working.problems.push(`no story ${id} on this board`)
}

const patchTicketOrStory = (working: Working, operation: JsonRecord): void => {
  const id = textOr(operation, 'id', '')
  if (idsOnThisBoard(working).isStoryId(id)) patchStory(working, id, operation)
  else patchTicket(working, id, operation)
}

const whoDropped = (working: Working): string =>
  working.turn.isPressOnTheBoard ? `, ${PRESSED_BY_THE_PERSON}` : ` ${turnPhrase(working.turn.words)}`

const noteNoLeftovers = (working: Working, ticket: Ticket): void => {
  working.notes.push(noLeftoversNote(ticket, working.checkedOutBranch))
  working.personNotes.push(noLeftoversWordsForThePerson(ticket, working.checkedOutBranch))
}

const movedWordsForThePerson = (id: string, status: string): string => (status === 'parked' ? `${id} set aside` : `${id} now ${statusWords(status)}`)

// Only what the worktree verdict calls safe is removed, and that happens after the write: the reply then says what
// was removed and what was kept.
const dropOne = (working: Working, ticket: Ticket): void => {
  const dropped = appendLogLine(applyTicketPatch(ticket, { status: DROPPED }, working.stamp), working.stamp, `dropped${whoDropped(working)}`)
  putTicket(working, dropped, `dropped ${ticket.id}`, `${ticket.id} dropped`)
  const leftovers = leftoversOf(ticket, working.checkedOutBranch)
  if (leftovers === undefined) noteNoLeftovers(working, ticket)
  else working.leftovers.push(leftovers)
  working.notes.push(...blockedByDroppedNote(ticket, [...working.tickets.values()]))
  working.personNotes.push(...blockedByDroppedWordsForThePerson(ticket, [...working.tickets.values()]))
}

const dropTicket = (working: Working, operation: JsonRecord): void => {
  const id = textOr(operation, 'id', '')
  const ticket = working.tickets.get(id)
  if (ticket) dropOne(working, ticket)
  else working.problems.push(notOnBoardProblem(working, id))
}

const moveTicket = (working: Working, operation: JsonRecord): void => {
  const id = textOr(operation, 'id', '')
  const ticket = working.tickets.get(id)
  if (!ticket) {
    working.problems.push(notOnBoardProblem(working, id))
    return
  }
  const status = repairedPatchFor(working, ticket, { status: textOr(operation, 'status', '') }).status
  if (status === undefined) return
  if (status === DROPPED) return dropOne(working, ticket)
  const moved = appendLogLine(applyTicketPatch(ticket, { status }, working.stamp), working.stamp, `moved ${ticket.status} to ${status}${pressSuffix(working)}`)
  putTicket(working, moved, `moved ${id} to ${status}`, movedWordsForThePerson(id, status))
  const setAside = setAsideNote(ticket, status, working.checkedOutBranch)
  working.notes.push(...setAside)
  working.personNotes.push(...setAside)
}

const noteTicket = (working: Working, operation: JsonRecord): void => {
  const id = textOr(operation, 'id', '')
  const text = textOr(operation, 'text', '')
  changeTicket(working, id, ticket => appendLogLine(ticket, working.stamp, `note ${text}`), `noted ${id}`)
}

const parkedByStop = (working: Working, ticket: Ticket): Ticket =>
  appendLogLine(applyTicketPatch(ticket, { status: 'parked' }, working.stamp), working.stamp, `parked by a stop ${turnPhrase(working.turn.words)}`)

const stopPlan = (working: Working, operation: JsonRecord): void => {
  const storyId = textOf(operation, 'story') || undefined
  if (storyId !== undefined && !working.stories.has(storyId)) {
    working.problems.push(`no story ${storyId} on this board`)
    return
  }
  const stop = planStopOf([...working.tickets.values()], storyId, working.turn.ticketsThisSessionCreated, Date.parse(working.stamp))
  for (const ticket of stop.toPark) putTicket(working, parkedByStop(working, ticket), `parked ${ticket.id}`)
  working.notes.push(planStopNote(stop))
  if (storyId !== undefined) clearYesWaitAfterStop(working, storyId)
}

// The proposed tickets are parked with their story, so nothing waits for a yes on that plan any more.
const clearYesWaitAfterStop = (working: Working, storyId: string): void => {
  const story = working.stories.get(storyId)
  if (story?.awaitsYes === true) putStory(working, applyStoryPatch(story, { awaitsYes: false }, working.stamp), `patched ${storyId}`)
}

const OPERATION_APPLIERS: Record<OperationName, (working: Working, operation: JsonRecord) => void> = {
  create: createTicket,
  story: createStory,
  patch: patchTicketOrStory,
  move: moveTicket,
  note: noteTicket,
  stop: stopPlan,
  drop: dropTicket,
}

const applyOperation = (working: Working, operation: unknown): void => {
  if (isRecord(operation) && isOperationName(operation.op)) OPERATION_APPLIERS[operation.op](working, operation)
}

const NO_IDS_ON_DISK = { tickets: [], stories: [] }

const workingFrom = (files: BoardFiles, stamp: string, turn: SessionTurn, prefixFacts: PrefixFacts | undefined): Working => ({
  config: files.config,
  tickets: new Map(files.tickets.map(ticket => [ticket.id, ticket])),
  stories: new Map(files.stories.map(story => [story.id, story])),
  changedTickets: new Set(),
  editedTickets: new Set(),
  changedStories: new Set(),
  isConfigChanged: false,
  createdTickets: [],
  done: [],
  repairs: [],
  notes: [],
  personNotes: [],
  problems: [],
  stamp,
  checkedOutBranch: files.checkedOutBranch,
  turn,
  leftovers: [],
  prefixFacts,
  unusableFiles: files.unusableFiles ?? [],
  idsOnDisk: files.idsOnDisk ?? NO_IDS_ON_DISK,
  proposedChanged: new Set(),
})

const pickChanged = <T>(items: Map<string, T>, ids: Set<string>): T[] =>
  [...ids].flatMap(id => {
    const item = items.get(id)

    return item === undefined ? [] : [item]
  })

const changeFrom = (working: Working): BoardChange => ({
  tickets: pickChanged(working.tickets, working.changedTickets),
  stories: pickChanged(working.stories, working.changedStories),
  ...(working.isConfigChanged ? { config: working.config } : {}),
})

const changedTicketProblems = (working: Working): string[] => {
  const ids = idsOnThisBoard(working)

  return pickChanged(working.tickets, working.editedTickets).flatMap(ticket => validateTicket(ticket, ids))
}

// A category with no route is bookkeeping, not a reason to lose the ticket: it is written, and start runs it on the
// fallback category and logs why.
const unroutedCategoryNotes = (working: Working): string[] => {
  const fallback = fallbackCategoryOf(working.config) ?? DEFAULT_CATEGORY

  return pickChanged(working.tickets, working.editedTickets)
    .filter(ticket => !hasRoute(ticket.category, working.config))
    .map(ticket => `${ticket.id} has category "${ticket.category}", which has no route on this board, so start runs it as ${fallback}.`)
}

// A blocker naming a ticket that is not there gates nothing, silently, so the reply says so and the write still lands.
const missingBlockerNotes = (working: Working): string[] =>
  pickChanged(working.tickets, working.editedTickets).flatMap(ticket =>
    ticket.blockedBy
      .filter(id => !working.tickets.has(id))
      .map(id => `${ticket.id} is blocked by ${id}, which is not on this board: patch blockedBy to the id you meant.`),
  )

// A name the board file does not know is still held by the ticket, so two tickets naming it still take turns.
const unknownSharedNotes = (working: Working): string[] =>
  pickChanged(working.tickets, working.editedTickets).flatMap(ticket => {
    const unknown = unknownThingsOf(ticket, working.config)

    return unknown.length === 0
      ? []
      : [`${ticket.id} uses ${unknown.map(name => `"${name}"`).join(', ')}, which settings.shared in .sidequest/board.json does not name. It is held all the same: add it there, or patch uses to the name you meant.`]
  })

const wasWaiting = (ticket: Ticket | undefined): boolean => ticket !== undefined && awaitsHumanAnswer(ticket)

const startedWaiting = (working: Working, files: BoardFiles): Ticket[] => {
  const before = new Map(files.tickets.map(ticket => [ticket.id, ticket]))

  return pickChanged(working.tickets, working.changedTickets).filter(ticket => awaitsHumanAnswer(ticket) && !wasWaiting(before.get(ticket.id)))
}

// sessionWork names the tickets this call created, started or finished, so the line after a compaction can speak of
// this conversation's work alone. createdTickets is what a stop with no story parks. conflictPairs are the pairs of
// tickets this answer told the model about, so the same pair is not said again this session. leftovers are the runs of
// dropped tickets whose worktree and branch are removed after the write, where the verdict calls them safe.
export type TicketToolResult = {
  answer: ToolAnswer
  change?: BoardChange
  sessionWork?: string[]
  createdTickets?: string[]
  conflictPairs?: string[]
  leftovers?: RunLeftovers[]
  briefFile?: BriefFile
  // Set by a start that returned a call asking the host for a worktree, so the folder it goes in is kept out of git.
  madeWorktree?: boolean
  // The story whose analysis this write carried, so the pane can show it while the person answers.
  storyWithAnalysis?: string
  // The story whose questions this write carried: the pane shows it too, since the chat then points there.
  storyWithQuestions?: string
  // The plan whose playback this write filed or corrected: the pane shows it, with the proposed tickets a correction changed.
  storyAwaitingYes?: string
  proposedChanged?: string[]
  // The ticket whose commit question this write filled in a step of: the pane shows it, above its question.
  ticketWithCommitQuestion?: string
  // What to say in the chat after a write at a stop where the person reads and decides (a plan's questions, its
  // playback, the commit question), one ending for a board that shows it and one for none. It goes after every other
  // note the write adds, so the reply ends with it.
  chatEnding?: (notWritten: readonly string[]) => ChatEnding | undefined
  // The story this write gave its first path, so that path is placed once in the transcript.
  storyGivenAPath?: string
  // The answer again, for when the write found some of its tickets changed on disk twice and left them alone.
  answerWithout?: (notWritten: ReadonlySet<string>) => ToolAnswer
  // What a press on the board toasts: the same writes in a person's words, with none of the model's instructions.
  forThePerson?: (notWritten: ReadonlySet<string>) => string
}

// Seen on a scratch board on 2026-11-20: a note on a ticket that kept changing on disk answered "noted PA-1." and then
// that nothing was written to PA-1. The first two words were false.
const doneLine = (working: Working, notWritten: ReadonlySet<string>): string => {
  const done = working.done.filter(write => !notWritten.has(write.id)).map(write => write.words)

  return done.length === 0 ? 'Nothing changed.' : `${done.join(', ')}.`
}

// Tickets made in the same call are one plan, so only the tickets already on the board count as another open ticket.
const sameKeyAsCreated = (working: Working, files: BoardFiles, saidPairs: ReadonlySet<string>): ConflictNotice =>
  sameKeyNotice(pickChanged(working.tickets, new Set(working.createdTickets)), files.tickets, saidPairs)

const waitingAroundOf = (working: Working): WaitingAround =>
  waitingAroundWrite(
    { stories: [...working.stories.values()], checkedOutBranch: working.checkedOutBranch },
    working.turn.ticketsThisSessionTouched ?? new Set(),
    working.changedTickets,
    working.stamp,
  )

const storyFilePath = (files: BoardFiles, id: string): string =>
  files.folderRead === undefined ? boardFilePath('stories', id) : `${files.folderRead}/stories/${id}.md`

const whereTheAnalysisIsRead = (working: Working, files: BoardFiles): string[] => {
  const id = working.storyWithAnalysis

  return id === undefined ? [] : [`The person reads the analysis of ${id} beside the conversation: its row in the board pane, or ${storyFilePath(files, id)}.`]
}

const replyText = (working: Working, files: BoardFiles, notWritten: ReadonlySet<string>): string => {
  const notes = [
    doneLine(working, notWritten),
    ...whereTheAnalysisIsRead(working, files),
    ...working.notes,
    ...working.repairs,
    ...missingBlockerNotes(working),
    ...unroutedCategoryNotes(working),
    ...unknownSharedNotes(working),
  ].join(' ')

  // The commit question's block goes in its own chat ending, beside what the person says yes to.
  const commitQuestion = commitQuestionWritten(working, files)
  const waiting = startedWaiting(working, files).filter(ticket => ticket !== commitQuestion)

  return `${notes}${nowWaitingNote(waiting, [...working.tickets.values()], waitingAroundOf(working))}`
}

const commitQuestionWritten = (working: Working, files: BoardFiles): Ticket | undefined =>
  commitQuestionAmong(pickChanged(working.tickets, working.changedTickets), new Map(files.tickets.map(ticket => [ticket.id, ticket])))

const personText = (working: Working, notWritten: ReadonlySet<string>): string => {
  const done = working.done.filter(write => !notWritten.has(write.id)).map(write => write.forThePerson ?? write.words)
  const doneLine = done.length === 0 ? 'Nothing changed.' : `${done.join(', ')}.`

  return [doneLine, ...working.personNotes].join(' ')
}

const NOTHING_SKIPPED: ReadonlySet<string> = new Set()

export const answerLeavingOut = (result: TicketToolResult, notWritten: readonly string[]): ToolAnswer =>
  notWritten.length > 0 && result.answerWithout ? result.answerWithout(new Set(notWritten)) : result.answer

// Made from the story as it now stands, so what the chat shows and what the plan view shows are the same words.
const chatAfterPlanWritten = (working: Working, notWritten: ReadonlySet<string>): ChatEnding | undefined => {
  const id = working.storyWithQuestions
  const story = id === undefined || notWritten.has(id) ? undefined : working.stories.get(id)

  return story === undefined ? undefined : chatAfterPlan(story)
}

const chatAfterPlaybackWritten = (working: Working, notWritten: ReadonlySet<string>): ChatEnding | undefined => {
  const id = working.storyAwaitingYes
  const story = id === undefined || notWritten.has(id) ? undefined : working.stories.get(id)

  return story === undefined ? undefined : chatAfterPlayback(inIdOrder(proposedTicketsOf(story, [...working.tickets.values()])))
}

const chatAfterCommitQuestion = (working: Working, files: BoardFiles, notWritten: ReadonlySet<string>): ChatEnding | undefined => {
  const ticket = commitQuestionWritten(working, files)
  if (ticket === undefined || notWritten.has(ticket.id)) return undefined

  return chatAfterSayingYesTo(commitQuestionOf(ticket, [...working.tickets.values()], waitingAroundOf(working)))
}

const chatEndingWritten = (working: Working, files: BoardFiles, notWritten: ReadonlySet<string>): ChatEnding | undefined =>
  chatAfterPlanWritten(working, notWritten) ?? chatAfterPlaybackWritten(working, notWritten) ?? chatAfterCommitQuestion(working, files, notWritten)

const pointedAtByTheChat = (working: Working, files: BoardFiles): Pick<TicketToolResult, 'storyAwaitingYes' | 'proposedChanged' | 'ticketWithCommitQuestion'> => {
  const commitQuestion = commitQuestionWritten(working, files)

  return {
    ...(working.storyAwaitingYes === undefined ? {} : { storyAwaitingYes: working.storyAwaitingYes, proposedChanged: [...working.proposedChanged] }),
    ...(commitQuestion === undefined ? {} : { ticketWithCommitQuestion: commitQuestion.id }),
  }
}

const writtenResult = (working: Working, files: BoardFiles, saidPairs: ReadonlySet<string>): TicketToolResult => {
  const sameKey = sameKeyAsCreated(working, files, saidPairs)
  const answerWithout = (notWritten: ReadonlySet<string>): ToolAnswer => ({ text: `${replyText(working, files, notWritten)}${noticeOnItsOwnLine(sameKey)}` })

  return {
    answer: answerWithout(NOTHING_SKIPPED),
    answerWithout,
    forThePerson: notWritten => personText(working, notWritten),
    change: changeFrom(working),
    sessionWork: working.createdTickets,
    createdTickets: working.createdTickets,
    conflictPairs: sameKey.pairs,
    leftovers: working.leftovers,
    chatEnding: notWritten => chatEndingWritten(working, files, new Set(notWritten)),
    ...pointedAtByTheChat(working, files),
    ...(working.storyWithQuestions === undefined ? {} : { storyWithQuestions: working.storyWithQuestions }),
    ...(working.storyGivenAPath === undefined ? {} : { storyGivenAPath: working.storyGivenAPath }),
    ...(working.storyWithAnalysis === undefined ? {} : { storyWithAnalysis: working.storyWithAnalysis }),
  }
}

const idsOnBoardRead = (files: BoardFiles): IdsOnBoard =>
  idsOnBoard(boardIdsOf(files.config.prefix), new Set(files.tickets.map(ticket => ticket.id)), new Set(files.stories.map(story => story.id)))

// The prefix a new board chooses must not be a tracker's, and the work filed in this very call may name one.
const trackerKeysCreatedWith = (operation: unknown): string[] => {
  if (!isRecord(operation) || operation.op !== 'create') return []
  const fromTitle = trackerKeyAtTitleStart(textOr(operation, 'title', ''))
  const fromFields = trackerKeysInBranch(`${textOr(operation, 'branch', '')} ${textOr(operation, 'issue', '')}`)

  return fromTitle === undefined ? fromFields : [fromTitle, ...fromFields]
}

type BoardRead = { files: BoardFiles; stamp: string; turn: SessionTurn; saidPairs: ReadonlySet<string>; prefixFacts: PrefixFacts | undefined }

const applyCheckedOperations = (operations: readonly unknown[], callNotes: readonly string[], read: BoardRead): TicketToolResult => {
  const { files, stamp, turn, saidPairs } = read
  const ids = idsOnBoardRead(files)
  const shapeProblems = operations.flatMap((operation, index) => operationProblems(operation, index, ids))
  if (shapeProblems.length > 0) return { answer: refusalOf(shapeProblems) }
  const prefixFacts = read.prefixFacts && withMoreTrackerKeys(read.prefixFacts, operations.flatMap(trackerKeysCreatedWith))
  const working = workingFrom(files, stamp, turn, prefixFacts)
  working.repairs.push(...callNotes)
  operations.forEach(operation => applyOperation(working, operation))
  const problems = [...working.problems, ...changedTicketProblems(working)]
  if (problems.length > 0) return { answer: refusalOf(problems) }

  return writtenResult(working, files, saidPairs)
}

// prefixFacts is given only for a board with no prefix and nothing on it yet. Without it a board with no prefix gives
// out SQ and ST ids, as every board did before prefixes.
export const applyTicketOperations = (
  input: JsonRecord,
  files: BoardFiles,
  stamp: string,
  turn: SessionTurn = NO_TURN_SEEN,
  saidPairs: ReadonlySet<string> = NO_PAIRS_SAID,
  prefixFacts?: PrefixFacts,
): TicketToolResult => {
  const { operations, notes } = repairedTicketCall(input)
  if (!Array.isArray(operations) || operations.length === 0) {
    return { answer: refusalOf(['"operations" must be a non-empty array of operations', ...notes]) }
  }

  return applyCheckedOperations(operations, notes, { files, stamp, turn, saidPairs, prefixFacts })
}
