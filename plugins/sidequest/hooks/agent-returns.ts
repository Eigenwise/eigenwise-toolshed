import { NOT_RECORDED, readOutcome, statusAfter } from './run-outcome'
import type { FinishOutcome } from './run-outcome'
import { appendLogLine, applyTicketPatch, oneLine, spokenMinutes } from './tickets'
import type { Ticket } from './tickets'

export const RESULT_FIELDS = ['result', 'checked', 'uncertain', 'needs', 'branch', 'commits', 'changedFiles'] as const
export type ResultField = (typeof RESULT_FIELDS)[number]
export type ResultFields = Partial<Record<ResultField, string>>

export type AgentEnding = 'answer' | 'aborted' | 'refusal' | 'error'
export type AgentReturn = { category: string; ending: AgentEnding; durationMs: number; answer: string; agentId?: string }

// The log names changedFiles "changed", the way finish has always written it, so a finish after a return can tell
// the line is already there.
export const LOG_NAMES: Record<ResultField, string> = {
  result: 'result',
  checked: 'checked',
  uncertain: 'uncertain',
  needs: 'needs',
  branch: 'branch',
  commits: 'commits',
  changedFiles: 'changed',
}

const LONGEST_FIELD = 400

const FIELD_BY_PLAIN_KEY: Record<string, ResultField> = {
  result: 'result',
  checked: 'checked',
  uncertain: 'uncertain',
  needs: 'needs',
  branch: 'branch',
  commits: 'commits',
  changedfiles: 'changedFiles',
}

// The shapes a field opens in, tried in order: a table row with the name in its first cell, a bold name
// (`**Result**`, `**result:** x`), a name before a colon (`` - `checked`: x ``, `"needs": "x"`), and a heading.
// The name may list several fields, as the scout's own contract line does: `` `branch`, `commits`, `changedFiles` ``.
const TABLE_ROW = /^\s*\|([^|]*)\|(.*)$/
const BOLD_NAME = /^\s*(?:[-*+]\s+)?(?:\*\*|__)([^*_]+?)(?:\*\*|__)\s*[:\-–]?\s*(.*)$/
const NAME_BEFORE_COLON = /^\s*(?:#+\s*|[-*+]\s+)?([^:|]{1,60}?)\s*:(?:\*\*|__)?\s*(.*)$/
const HEADING = /^\s*#+\s*(.+?)\s*$/
const LINE_SHAPES = [TABLE_ROW, BOLD_NAME, NAME_BEFORE_COLON, HEADING]
const FIELD_NAME_SEPARATORS = /,|\band\b|\//
const LIST_MARKER = /^[-*+]\s+/
// A JSON bracket, a table row or a heading that names no field ends the field before it.
const ENDS_A_FIELD = /^(?:[{}[\],]+|[|#].*)$/

type FieldStart = { fields: ResultField[]; value: string }
type Reading = { collected: Map<ResultField, string[]>; open?: string[] }

const isResultField = (field: ResultField | undefined): field is ResultField => field !== undefined

const fieldsNamedBy = (names: string): ResultField[] => {
  const fields = names.split(FIELD_NAME_SEPARATORS).map(name => FIELD_BY_PLAIN_KEY[name.toLowerCase().replace(/[^a-z]/g, '')])

  return fields.every(isResultField) ? fields : []
}

const cellsAsText = (cells: string): string => cells.replace(/\|\s*$/, '').replace(/\|/g, ' ')

const fieldStartOf = (line: string): FieldStart | undefined => {
  const match = LINE_SHAPES.map(shape => shape.exec(line)).find(found => found !== null)
  const fields = fieldsNamedBy(match?.[1] ?? '')

  return fields.length > 0 ? { fields, value: cellsAsText(match?.[2] ?? '') } : undefined
}

// The first time a field appears is the one kept; a later mention only stops the field before it from growing.
const startFields = (reading: Reading, start: FieldStart): void => {
  const pieces = [start.value.trim()]
  for (const field of start.fields) if (!reading.collected.has(field)) reading.collected.set(field, pieces)
  reading.open = pieces
}

// A blank line after some text ends the field too, so what follows the last field is not swallowed into it.
const continueField = (reading: Reading, line: string): void => {
  const piece = line.trim().replace(LIST_MARKER, '')
  if (!reading.open || ENDS_A_FIELD.test(piece)) {
    reading.open = undefined
    return
  }
  if (piece !== '') reading.open.push(piece)
  else if (reading.open.some(existing => existing !== '')) reading.open = undefined
}

export const cutToLength = (text: string, length: number = LONGEST_FIELD): string =>
  text.length <= length ? text : `${text.slice(0, length - 3)}...`

// A JSON-shaped answer leaves its quotes and comma on the value.
const JSON_QUOTED = /^"(.*)",?$/

const fieldValueOf = (field: ResultField, pieces: readonly string[]): string => {
  const joined = pieces.filter(piece => piece !== '').join(field === 'changedFiles' ? ', ' : ' ')

  return cutToLength(oneLine(joined).replace(JSON_QUOTED, '$1'))
}

const collectedFields = (answer: string): Map<ResultField, string[]> => {
  const reading: Reading = { collected: new Map() }
  for (const line of answer.split(/\r?\n/)) {
    const start = fieldStartOf(line)
    if (start) startFields(reading, start)
    else continueField(reading, line)
  }

  return reading.collected
}

// An answer in none of the contract's shape is still what the agent said, so it is kept as the result.
export const readResultFields = (answer: string): ResultFields => {
  const fields: ResultFields = {}
  for (const [field, pieces] of collectedFields(answer)) {
    const value = fieldValueOf(field, pieces)
    if (value !== '') fields[field] = value
  }
  const wholeAnswer = cutToLength(oneLine(answer))

  return Object.keys(fields).length === 0 && wholeAnswer !== '' ? { result: wholeAnswer } : fields
}

const ENDING_WORDS: Record<AgentEnding, string> = {
  answer: '',
  aborted: ', interrupted',
  error: ', on an error',
  refusal: ', on a refusal',
}

export const spokenDuration = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))

  return seconds < 60 ? `${seconds}s` : spokenMinutes(Math.round(seconds / 60))
}

// The head names the run's category, as the spawn line does, so a review run's return is never taken for the work's,
// and the agent's id, so a later stop of the same agent finds its own block among other agents' lines.
export const returnLogLines = (agentReturn: AgentReturn): string[] => {
  const fields = readResultFields(agentReturn.answer)
  const ending = ENDING_WORDS[agentReturn.ending]
  const owner = agentReturn.agentId === undefined ? '' : `, agent ${agentReturn.agentId}`
  const head = `returned ${agentReturn.category} run${ending} after ${spokenDuration(agentReturn.durationMs)}${owner}`

  return [head, ...RESULT_FIELDS.map(field => `${LOG_NAMES[field]} ${fields[field] ?? NOT_RECORDED}`)]
}

export const logTextOf = (line: string): string => line.slice(line.indexOf(' ') + 1)

const SPAWN_LINE = /^\S+ agent (\S+) /
const RETURN_BLOCK_LENGTH = RESULT_FIELDS.length + 1

const isSpawnLineOf = (line: string, agentId: string): boolean => SPAWN_LINE.exec(line)?.[1] === agentId

const isWholeBlockAt = (texts: readonly string[], at: number): boolean =>
  RESULT_FIELDS.every((field, offset) => texts[at + 1 + offset]?.startsWith(`${LOG_NAMES[field]} `) === true)

const RETURN_OWNER = /, agent (\S+)$/

const isReturnBlockOf = (text: string, agentId: string, category: string): boolean =>
  RETURN_HEAD.exec(text)?.[1] === category && RETURN_OWNER.exec(text)?.[1] === agentId

// Where the return block this agent wrote after it was spawned starts, whatever other agents' lines lie between. A
// block with no agent id, from a log written before blocks named theirs, belongs to nobody and is never taken.
const earlierBlockOf = (log: readonly string[], agentId: string, category: string): number | undefined => {
  const spawned = log.findLastIndex(line => isSpawnLineOf(line, agentId))
  const texts = log.map(logTextOf)
  const at = spawned === -1 ? -1 : texts.findIndex((text, index) => index > spawned && isReturnBlockOf(text, agentId, category))

  return at !== -1 && isWholeBlockAt(texts, at) ? at : undefined
}

const holdsMoreThanResult = (fieldLines: readonly string[]): boolean => fieldLines.some(line => !line.endsWith(` ${NOT_RECORDED}`))

const carriesContractFields = (fields: ResultFields): boolean => RESULT_FIELDS.some(field => field !== 'result' && fields[field] !== undefined)

const resultTextOf = (resultLine: string | undefined): string => (resultLine ?? '').slice('result '.length)

// Only a stop that carries the contract's fields, or says more than a prose stop before it, takes the place of the
// earlier one. A short text after a real result is the agent waking again, not another result.
const replacesEarlierBlock = (agentReturn: AgentReturn, earlier: readonly string[]): boolean => {
  const fields = readResultFields(agentReturn.answer)
  if (carriesContractFields(fields)) return true

  return !holdsMoreThanResult(earlier.slice(2)) && (fields.result ?? '').length > resultTextOf(earlier[1]).length
}

const appendedBlock = (ticket: Ticket, stamp: string, agentReturn: AgentReturn): Ticket =>
  returnLogLines(agentReturn).reduce((current, line) => appendLogLine(current, stamp, line), ticket)

const replacedBlock = (ticket: Ticket, stamp: string, agentReturn: AgentReturn, at: number): Ticket => {
  const rewritten = appendedBlock({ ...ticket, log: ticket.log.slice(0, at) }, stamp, agentReturn)

  return { ...rewritten, log: [...rewritten.log, ...ticket.log.slice(at + RETURN_BLOCK_LENGTH)] }
}

// One run of one agent has one block on the log. The host's stop event does not say whether the agent still has
// background work or will be continued, so a later stop of the same agent is judged by what it says.
export const withReturnRecord = (ticket: Ticket, stamp: string, agentReturn: AgentReturn): Ticket => {
  const { agentId } = agentReturn
  const at = agentId === undefined || agentReturn.ending !== 'answer' ? undefined : earlierBlockOf(ticket.log, agentId, agentReturn.category)
  if (at === undefined) return appendedBlock(ticket, stamp, agentReturn)
  const earlier = ticket.log.slice(at, at + RETURN_BLOCK_LENGTH).map(logTextOf)

  return replacesEarlierBlock(agentReturn, earlier) ? replacedBlock(ticket, stamp, agentReturn, at) : ticket
}

const RETURN_HEAD = /^returned (\S+) run(, (?:interrupted|on an error|on a refusal))? after /
// start writes this when the ticket's own category has no route, and the work then runs on the named one.
const FALLBACK_CATEGORY = /so it runs as ([^\s.]+)/

const isStartLine = (text: string): boolean => text.startsWith('started ')
const isFinishLine = (text: string): boolean => text.startsWith('finished ')

export const logTextsSinceLastStart = (log: readonly string[]): string[] => {
  const texts = log.map(logTextOf)

  return texts.slice(texts.findLastIndex(isStartLine) + 1)
}

const workCategoryOf = (ticket: Ticket): string => {
  const lastStart = ticket.log.map(logTextOf).findLast(isStartLine) ?? ''

  return FALLBACK_CATEGORY.exec(lastStart)?.[1] ?? ticket.category
}

const lastWorkReturnIndex = (ticket: Ticket, texts: readonly string[]): number => {
  const category = workCategoryOf(ticket)

  return texts.findLastIndex(text => RETURN_HEAD.exec(text)?.[1] === category)
}

const isInterruptedReturn = (text: string | undefined): boolean => RETURN_HEAD.exec(text ?? '')?.[2] === ENDING_WORDS.aborted

// A run the person cut off has nothing to record and nothing to ask: its ticket stays doing, started and not running,
// and its return line already says it was interrupted and when. Moved to needs-you, it asked the person about nothing.
export const isReturnedNotRecorded = (ticket: Ticket): boolean => {
  const texts = logTextsSinceLastStart(ticket.log)
  const lastReturn = lastWorkReturnIndex(ticket, texts)

  return ticket.status === 'doing' && lastReturn > texts.findLastIndex(isFinishLine) && !isInterruptedReturn(texts[lastReturn])
}

const BACK_WORDS: Record<'one' | 'several', (ids: string) => string> = {
  one: ids => `${ids}'s agent is back and its result is not recorded: call mcp__sidequest__finish for ${ids} now. Nothing else moves it`,
  several: ids => `The agents of ${ids} are back and their results are not recorded: call mcp__sidequest__finish for each now. Nothing else moves them`,
}

// Seen on 2026-11-24: a session slept and read the board eighteen times over seven minutes, waiting for a return that
// had already arrived. A session asleep in its own loop is never handed a return, and only finish ends the wait.
export const finishNowLines = (tickets: readonly Ticket[]): string[] => {
  const returned = tickets.filter(isReturnedNotRecorded).map(ticket => ticket.id).sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))
  if (returned.length === 0) return []

  return [`${BACK_WORDS[returned.length === 1 ? 'one' : 'several'](returned.join(', '))} out of doing while your turn lasts.`]
}

export const END_YOUR_TURN_LINE = 'Its return comes to you as a new turn: end your turn, do not sleep or read the board again to wait.'

const recordedNeeds =(texts: readonly string[]): string | undefined =>
  texts.find(text => text.startsWith('needs '))?.slice('needs '.length)

type WorkReturn = { endingWord?: 'failed'; needs: string }

// The return's own field lines follow its head, so the first needs line after it is that run's.
const workReturnOf = (ticket: Ticket): WorkReturn => {
  const texts = logTextsSinceLastStart(ticket.log)
  const fromWorkReturn = texts.slice(lastWorkReturnIndex(ticket, texts))
  const needs = recordedNeeds(fromWorkReturn) ?? NOT_RECORDED

  return RETURN_HEAD.exec(fromWorkReturn[0] ?? '')?.[2] === undefined ? { needs } : { endingWord: 'failed', needs }
}

export const BOARD_RECORDED = 'recorded by the board because finish was not called'

// Parking every prose answer at needs-you would be the bookkeeping gate the human ruled out, so a needs the board
// could not find is read as none, and the line says that was assumed.
const NEEDS_ASSUMED = '; needs not recorded, read as none'

export type BoardRecording = { ticket: Ticket; outcome: FinishOutcome }

export const recordedByBoard = (ticket: Ticket, stamp: string): BoardRecording => {
  const workReturn = workReturnOf(ticket)
  const outcome = readOutcome(workReturn.endingWord, workReturn.needs)
  const moved = applyTicketPatch(ticket, { status: statusAfter(outcome, ticket) }, stamp)
  const assumption = workReturn.needs === NOT_RECORDED ? NEEDS_ASSUMED : ''

  return { ticket: appendLogLine(moved, stamp, `finished ${outcome}, ${BOARD_RECORDED}${assumption}`), outcome }
}
