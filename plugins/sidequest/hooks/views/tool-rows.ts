import type { SidequestRun } from '../../types'
import { isRecord } from '../board-config'
import { isStoryIdOn } from '../board-ids'
import type { BoardIds } from '../board-ids'
import { routeRequestIn, shortModelName } from '../routing'
import { readFinishOutcome } from '../run-outcome'
import { statusWords } from '../status-words'
import { textOf } from '../tool-input'
import type { JsonRecord } from '../tool-input'
import { withTicketRef } from './running-agents'

export type ToolRowCall = { tool: string; input: unknown; output?: unknown; isErrored: boolean }

type RowWriter = (input: JsonRecord, answer: string | undefined, run: SidequestRun | undefined, ids: BoardIds) => string | undefined

const textBlockOf = (block: unknown): string => (isRecord(block) ? (textOf(block, 'text') ?? '') : '')

// A plugin tool's stored result is its text, or the same text as content blocks, depending on the surface.
export const answerTextOf = (output: unknown): string | undefined => {
  if (typeof output === 'string') return output
  const joined = Array.isArray(output) ? output.map(textBlockOf).join('') : ''

  return joined === '' ? undefined : joined
}

const present = (parts: readonly (string | undefined)[]): string[] => parts.filter((part): part is string => part !== undefined)

// A view's name (planning, routing, now) is a word for the model, so the row names only a ticket or story that was asked for.
const boardReadRow: RowWriter = input => present(['read', textOf(input, 'id')]).join(' ')

export type OpenWork = { needsYou: number; ready: number; doing: number; review: number }

const counted = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

// What a person sees under a board read, in place of the text the model read (the routing table, hints for the model).
export const boardReadLine = (openWork: OpenWork): string => {
  const open = openWork.needsYou + openWork.ready + openWork.doing + openWork.review
  if (open === 0) return 'nothing open'
  const waiting = openWork.needsYou === 0 ? [] : [`${counted(openWork.needsYou, 'waits', 'wait')} on you`]

  return [counted(open, 'open ticket', 'open tickets'), ...waiting].join(', ')
}

// Seen on 2026-11-24: a session that polled the board drew nine `board read / 2 open tickets` rows in a row. A read
// whose line is the one the read before it drew says nothing new, so its result line is left empty.
// Each read keeps the line it drew when it ran, so an older row does not change when the board does.
export type BoardReads = { lastLine?: string; linesById: Readonly<Record<string, string>>; repeatedIds: readonly string[] }

export const NO_BOARD_READS: BoardReads = { linesById: {}, repeatedIds: [] }

export const withBoardRead = (reads: BoardReads, toolUseId: string, line: string): BoardReads => ({
  lastLine: line,
  linesById: { ...reads.linesById, [toolUseId]: line },
  repeatedIds: line === reads.lastLine ? [...reads.repeatedIds, toolUseId] : reads.repeatedIds,
})

// Read from the ticket tool's own answer ("created TN-3, created TN-S1"), whatever the board's prefix.
const WRITTEN = /^(\w+) ([A-Z]+-S?\d+)(.*)$/

const storyWord = (ids: BoardIds, id: string): string => (isStoryIdOn(ids, id) ? 'story ' : '')

const MOVED_TO = /^ to (\S+)$/

// The answer says "moved SQ-4 to needs-you" for the model; a person reads where it is now.
const whatWasDone = (verb: string, rest: string): string => {
  const status = verb === 'moved' ? MOVED_TO.exec(rest)?.[1] : undefined

  return status === undefined ? `${verb}${rest}` : `now ${statusWords(status)}`
}

const subjectFirst = (written: string, ids: BoardIds): string =>
  written.replace(WRITTEN, (_whole, verb: string, id: string, rest: string) => `${storyWord(ids, id)}${id} ${whatWasDone(verb, rest)}`)

const firstSentence = (answer: string): string => answer.split(/\.(?:\s|$)/)[0] ?? answer

const operationCount = (input: JsonRecord): number => (Array.isArray(input.operations) ? input.operations.length : 0)

const ticketWriteRow: RowWriter = (input, answer, _run, ids) => {
  if (answer === undefined) return `writing ${operationCount(input)} board changes`

  return firstSentence(answer).split(', ').map(written => subjectFirst(written, ids)).join(', ')
}

const jsonTextField = (answer: string, field: string): string | undefined =>
  new RegExp(`"${field}": "([^"]+)"`).exec(answer)?.[1]

type Route = { model: string | undefined; effort: string | undefined }

const routeWords = (role: string, route: Route): string =>
  present([role, route.model === undefined ? undefined : `on ${route.model}`]).join(' ') + (route.effort === undefined ? '' : `, ${route.effort} effort`)

const startedRoute = (answer: string): string => {
  const role = jsonTextField(answer, 'subagent_type')?.replace(/^sidequest:/, '') ?? 'agent'
  const model = jsonTextField(answer, 'model') ?? /sets model (\S+)/.exec(answer)?.[1]

  return routeWords(`${role} agent`, { model, effort: jsonTextField(answer, 'effort') })
}

const startRow: RowWriter = (input, answer) => {
  const id = textOf(input, 'id') ?? 'ticket'

  return answer === undefined ? `${id} starting` : `${id} started: ${startedRoute(answer)}`
}

// The outcome is read the way finish reads it, so a model's own word ("blocked", "success") shows as what it became.
const finishedOutcomeWords = (input: JsonRecord): string => {
  const outcome = readFinishOutcome({ outcome: textOf(input, 'outcome'), result: textOf(input, 'result'), needs: textOf(input, 'needs') })

  return statusWords(outcome)
}

const finishRow: RowWriter = (input, answer) => {
  const duration = /after ([^.]+)\./.exec(answer ?? '')?.[1]

  return `${textOf(input, 'id') ?? 'ticket'} ${present([finishedOutcomeWords(input), duration]).join(', ')}`
}

const spawnedRoute = (input: JsonRecord, run: SidequestRun | undefined): Route =>
  run ? { model: shortModelName(run.model), effort: run.effort } : { model: textOf(input, 'model'), effort: textOf(input, 'effort') }

const spawnRow: RowWriter = (input, _answer, run, ids) => {
  const description = textOf(input, 'description') ?? ''
  const request = routeRequestIn(textOf(input, 'prompt') ?? '', description, ids)
  if (!request) return undefined
  const role = (textOf(input, 'subagent_type') ?? 'agent').replace(/^sidequest:/, '')

  return `${withTicketRef(description, request.ticket)}: ${routeWords(role, spawnedRoute(input, run))}`
}

const ROW_WRITERS: Record<string, RowWriter> = {
  mcp__sidequest__board: boardReadRow,
  mcp__sidequest__ticket: ticketWriteRow,
  mcp__sidequest__start: startRow,
  mcp__sidequest__finish: finishRow,
  Agent: spawnRow,
}

export const toolRowLabel = (tool: string): string => (tool === 'Agent' ? 'agent' : 'board')

// Undefined leaves the row to the host: a tool that is not ours, an unrouted spawn, or a call that failed and must show why.
export const boardToolRow = (call: ToolRowCall, run: SidequestRun | undefined, ids: BoardIds): string | undefined => {
  const write = ROW_WRITERS[call.tool]
  if (!write || call.isErrored || !isRecord(call.input)) return undefined

  return write(call.input, answerTextOf(call.output), run, ids)
}

export const runOfToolUse = (runs: Record<string, SidequestRun>, toolUseId: string): SidequestRun | undefined =>
  Object.values(runs).find(run => run.toolUseId === toolUseId)
