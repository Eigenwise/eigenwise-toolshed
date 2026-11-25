import { isRecord } from './board-config'
import { isPartLine, NOTHING_TO_SAY_YES_TO, partLineText, partStartOf, sayingYesToFromInput, sayingYesToText } from './saying-yes-to'
import type { SayingYesTo, SayingYesToPart } from './saying-yes-to'
import { oneLine, withoutSentAnswer } from './tickets'
import type { Ticket } from './tickets'

// What waits on the person, written so someone who was not in the room can answer it from a phone. Stored in the
// ticket file as the `## For you` section, one labelled line per part.
export type ForYouOption = { label: string; gets: string; costs: string }

// Something the session left for the person to choose beside the question (a review note it did not act on, an
// offer): what it is, and what happens if they say nothing.
export type AlsoYours = { what: string; doneByDefault: string }

export type ForYou = {
  question: string
  whyNow: string
  options: ForYouOption[]
  recommended: string
  ifUnanswered: string
  steps: string
  alsoYours: AlsoYours[]
  sayingYesTo: SayingYesTo
}

type TextPart = 'question' | 'whyNow' | 'recommended' | 'ifUnanswered' | 'steps'
type ListPart = 'options' | 'alsoYours'
type ForYouPart = TextPart | ListPart

const TEXT_PARTS: readonly TextPart[] = ['question', 'whyNow', 'recommended', 'ifUnanswered', 'steps']

const LINE_NAMES: Record<ForYouPart, string> = {
  question: 'Question',
  whyNow: 'Why now',
  options: 'Options',
  recommended: 'Recommended',
  ifUnanswered: 'If you never answer',
  steps: 'Steps',
  alsoYours: 'Also yours',
}

const LABELLED_LINE = /^(Question|Why now|Options|Recommended|If you never answer|Steps|Also yours):\s*(.*)$/i
const OPTION_TEXT = /^(.+?):\s*(.*?)(?:\s*Costs:\s*(.*))?$/i
const ALSO_YOURS_TEXT = /^(.*?)\s*\(if you say nothing: (.*)\)$/i
const IF_YOU_SAY_NOTHING = 'if you say nothing'

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

export const optionLetter = (index: number): string => LETTERS[index] ?? String(index + 1)

const emptyForYou = (): ForYou => ({
  question: '',
  whyNow: '',
  options: [],
  recommended: '',
  ifUnanswered: '',
  steps: '',
  alsoYours: [],
  sayingYesTo: { ...NOTHING_TO_SAY_YES_TO },
})

const hasText = (text: string): boolean => text.trim() !== ''

const EVERY_PART: readonly ForYouPart[] = [...TEXT_PARTS, 'options', 'alsoYours']

const partNamed = (name: string): ForYouPart =>
  EVERY_PART.find(part => LINE_NAMES[part].toLowerCase() === name.toLowerCase()) ?? 'question'

const withoutFinalStop = (text: string): string => text.trim().replace(/\.+$/, '')

const optionOf = (text: string): ForYouOption => {
  const match = OPTION_TEXT.exec(text)
  if (!match) return { label: text.trim(), gets: '', costs: '' }

  return { label: (match[1] ?? '').trim(), gets: withoutFinalStop(match[2] ?? ''), costs: withoutFinalStop(match[3] ?? '') }
}

const appendText = (forYou: ForYou, part: TextPart, line: string): void => {
  if (line === '') return
  forYou[part] = forYou[part] === '' ? line : `${forYou[part]}\n${line}`
}

const alsoYoursOf = (text: string): AlsoYours => {
  const match = ALSO_YOURS_TEXT.exec(text)

  return match ? { what: (match[1] ?? '').trim(), doneByDefault: (match[2] ?? '').trim() } : { what: text.trim(), doneByDefault: '' }
}

const LIST_LINE_READERS: Record<ListPart, (forYou: ForYou, text: string) => void> = {
  options: (forYou, text) => forYou.options.push(optionOf(text)),
  alsoYours: (forYou, text) => forYou.alsoYours.push(alsoYoursOf(text)),
}

const isListPart = (part: ForYouPart): part is ListPart => part === 'options' || part === 'alsoYours'

const addListLine = (forYou: ForYou, part: ListPart, line: string): void => {
  if (line.startsWith('- ')) LIST_LINE_READERS[part](forYou, line.slice(2))
}

const startPart = (forYou: ForYou, part: ForYouPart, rest: string): ForYouPart => {
  if (isListPart(part)) addListLine(forYou, part, rest.trim())
  else appendText(forYou, part, rest.trim())

  return part
}

const startLabelledPart = (forYou: ForYou, labelled: RegExpExecArray): ForYouPart =>
  startPart(forYou, partNamed(labelled[1] ?? ''), labelled[2] ?? '')

const readLine = (forYou: ForYou, current: ForYouPart | undefined, line: string): ForYouPart | undefined => {
  const labelled = LABELLED_LINE.exec(line)
  if (labelled) return startLabelledPart(forYou, labelled)
  if (current === undefined) return current
  if (isListPart(current)) addListLine(forYou, current, line)
  else appendText(forYou, current, line)

  return current
}

// The parts the person says yes to are read whole, blank lines and leading spaces kept, up to a line that is not theirs.
type Reading = { forYou: ForYou; current: ForYouPart | undefined; yesToPart: SayingYesToPart | undefined; blankLines: number }

const appendToYesToPart = (reading: Reading, part: SayingYesToPart, text: string): void => {
  const before = reading.forYou.sayingYesTo[part]
  const gap = '\n'.repeat(reading.blankLines)
  reading.forYou.sayingYesTo[part] = before === '' ? text : `${before}\n${gap}${text}`
  reading.blankLines = 0
}

const readYesToLine = (reading: Reading, part: SayingYesToPart, line: string): boolean => {
  if (isPartLine(line)) appendToYesToPart(reading, part, partLineText(line))
  else if (line.trim() === '') reading.blankLines += 1
  else return false

  return true
}

const startYesToPart = (reading: Reading, line: string): boolean => {
  const start = partStartOf(line)
  if (start === undefined) return false
  reading.yesToPart = start.part
  reading.current = undefined
  reading.blankLines = 0
  if (start.firstLine !== '') appendToYesToPart(reading, start.part, start.firstLine)

  return true
}

const readAnyLine = (reading: Reading, line: string): void => {
  if (reading.yesToPart !== undefined && readYesToLine(reading, reading.yesToPart, line)) return
  reading.yesToPart = undefined
  if (!startYesToPart(reading, line)) reading.current = readLine(reading.forYou, reading.current, line.trim())
}

export const parseForYou = (text: string): ForYou => {
  const reading: Reading = { forYou: emptyForYou(), current: undefined, yesToPart: undefined, blankLines: 0 }
  for (const line of text.split('\n')) readAnyLine(reading, line.replace(/\r$/, ''))

  return reading.forYou
}

const sentence = (text: string): string => (hasText(text) ? `${withoutFinalStop(oneLine(text))}.` : '')

export const optionText = (option: ForYouOption): string => {
  const costs = hasText(option.costs) ? `Costs: ${sentence(option.costs)}` : ''
  const said = [sentence(option.gets), costs].filter(hasText).join(' ')

  return said === '' ? oneLine(option.label) : `${oneLine(option.label)}: ${said}`
}

const labelledLine = (part: TextPart, text: string): string => (hasText(text) ? `${LINE_NAMES[part]}: ${text.trim()}` : '')

const optionsLines = (options: readonly ForYouOption[]): string[] =>
  options.length === 0 ? [] : [`${LINE_NAMES.options}:`, ...options.map(option => `- ${optionText(option)}`)]

export const alsoYoursText = (item: AlsoYours): string =>
  hasText(item.doneByDefault) ? `${oneLine(item.what)} (${IF_YOU_SAY_NOTHING}: ${oneLine(item.doneByDefault)})` : oneLine(item.what)

const alsoYoursLines = (items: readonly AlsoYours[]): string[] =>
  items.length === 0 ? [] : [`${LINE_NAMES.alsoYours}:`, ...items.map(item => `- ${alsoYoursText(item)}`)]

export const forYouText = (forYou: ForYou): string =>
  [
    labelledLine('question', forYou.question),
    labelledLine('whyNow', forYou.whyNow),
    ...optionsLines(forYou.options),
    labelledLine('recommended', forYou.recommended),
    labelledLine('ifUnanswered', forYou.ifUnanswered),
    labelledLine('steps', forYou.steps),
    ...alsoYoursLines(forYou.alsoYours),
    sayingYesToText(forYou.sayingYesTo),
  ]
    .filter(hasText)
    .join('\n')

const textOrEmpty = (record: Record<string, unknown>, key: string): string => {
  const value = record[key]

  return typeof value === 'string' ? value : ''
}

// Seen in a real run: each option sent as one string `Label: what it does` was refused, and the red refusal stayed in
// the transcript. A string reads as the label before the first colon and what it gets after it.
const optionFromInput = (value: unknown): ForYouOption => {
  if (typeof value === 'string') return optionOf(value)
  const record = isRecord(value) ? value : {}

  return { label: textOrEmpty(record, 'label'), gets: textOrEmpty(record, 'gets'), costs: textOrEmpty(record, 'costs') }
}

const alsoYoursFromInput = (value: unknown): AlsoYours => {
  if (typeof value === 'string') return alsoYoursOf(value)
  const record = isRecord(value) ? value : {}

  return { what: textOrEmpty(record, 'what'), doneByDefault: textOrEmpty(record, 'doneByDefault') }
}

const listsFromInput = (value: Record<string, unknown>): Partial<ForYou> => ({
  ...(Array.isArray(value.options) ? { options: value.options.map(optionFromInput) } : {}),
  ...(Array.isArray(value.alsoYours) ? { alsoYours: value.alsoYours.map(alsoYoursFromInput) } : {}),
})

export const forYouFromInput = (value: Record<string, unknown>): Partial<ForYou> => {
  const given: Partial<ForYou> = listsFromInput(value)
  for (const part of TEXT_PARTS) {
    const text = value[part]
    if (typeof text === 'string') given[part] = text
  }

  return given
}

const isRecordOrText = (value: unknown): boolean => isRecord(value) || typeof value === 'string'

const isListInput = (value: unknown): boolean => value === undefined || (Array.isArray(value) && value.every(isRecordOrText))

const isSayingYesToInput = (value: unknown): boolean => value === undefined || isRecord(value)

export const isForYouInput = (value: unknown): boolean =>
  isRecord(value) && isListInput(value.options) && isListInput(value.alsoYours) && isSayingYesToInput(value.sayingYesTo)

const sayingYesToGiven = (value: Record<string, unknown>): Partial<SayingYesTo> =>
  isRecord(value.sayingYesTo) ? sayingYesToFromInput(value.sayingYesTo) : {}

// Only the parts given change, so a session can fill in what the answer said was missing without repeating the rest,
// and the second step of what the person says yes to keeps the first.
export const withForYouInput = (ticket: Ticket, value: unknown): Ticket => {
  if (!isRecord(value)) return ticket
  const before = parseForYou(ticket.forYou)
  const merged = { ...before, ...forYouFromInput(value), sayingYesTo: { ...before.sayingYesTo, ...sayingYesToGiven(value) } }

  return { ...withoutSentAnswer(ticket), forYou: forYouText(merged) }
}

const isTask = (forYou: ForYou): boolean => hasText(forYou.steps)

type PartCheck = { name: string; isMissing: (forYou: ForYou) => boolean }

const PART_CHECKS: readonly PartCheck[] = [
  { name: 'Question (question)', isMissing: forYou => !hasText(forYou.question) },
  { name: 'Why now (whyNow)', isMissing: forYou => !hasText(forYou.whyNow) },
  { name: 'Options (options)', isMissing: forYou => !isTask(forYou) && forYou.options.length === 0 },
  { name: 'Recommended (recommended)', isMissing: forYou => !isTask(forYou) && !hasText(forYou.recommended) },
  { name: 'If you never answer (ifUnanswered)', isMissing: forYou => !hasText(forYou.ifUnanswered) },
]

const isOptionHalfWritten = (option: ForYouOption): boolean => !hasText(option.gets) || !hasText(option.costs)

export const missingForYouParts = (forYou: ForYou): string[] => [
  ...PART_CHECKS.filter(check => check.isMissing(forYou)).map(check => check.name),
  ...forYou.options.filter(isOptionHalfWritten).map(option => `what "${oneLine(option.label)}" gets and what it costs`),
]

export const WHAT_REACHES_THE_PERSON =
  'Keep it waiting only if it cannot be undone, spends money or reaches outside the project, or is taste or product direction only the person has. Otherwise take the recommended answer now, note on the ticket what you chose and how to undo it, and move the ticket on.'

const gapLine = (ticket: Ticket): string => {
  const missing = missingForYouParts(parseForYou(ticket.forYou))

  return missing.length === 0 ? '' : `${ticket.id} For you section is missing: ${missing.join(', ')}.`
}

export const forYouGapLines = (tickets: readonly Ticket[]): string[] => {
  const gaps = tickets.map(gapLine).filter(hasText)

  return gaps.length === 0 ? [] : [...gaps, 'Patch forYou so someone who was not here can answer it from a phone.']
}
