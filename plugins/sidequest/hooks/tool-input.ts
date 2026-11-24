import { isRecord } from './board-config'
import { isForYouInput } from './for-you'

export type JsonRecord = Record<string, unknown>

export type ToolAnswer = { text: string } | { refusal: string }

export type FieldKind = 'text' | 'list' | 'number' | 'yesNo' | 'decisions' | 'questions' | 'path' | 'excerpts' | 'forYou'
export type FieldTable = Record<string, FieldKind>

export type InputShape = { fields: FieldTable; required: readonly string[] }

export const ENGINE_KEYS =['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent']

export const isTextList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string')

export const textOf = (record: JsonRecord, key: string): string | undefined => {
  const value = record[key]

  return typeof value === 'string' ? value : undefined
}

const isDecisionInput = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && 'question' in value && 'answer' in value

const isOptionalText = (value: unknown): boolean => value === undefined || typeof value === 'string'

const isTextOrTextList = (value: unknown): boolean => typeof value === 'string' || isTextList(value)

const isOpenQuestionInput = (value: unknown): boolean =>
  isRecord(value) && typeof value.question === 'string' && isTextOrTextList(value.recommended) && isOptionalText(value.otherCosts)

const namesAFileLine = (value: JsonRecord): boolean => typeof value.file === 'string' && Number.isInteger(value.line)

const isPathStepInput = (value: unknown): boolean =>
  isRecord(value) && typeof value.what === 'string' && namesAFileLine(value) && isOptionalText(value.note)

const isExcerptInput = (value: unknown): boolean =>
  isRecord(value) && typeof value.file === 'string' && Number.isInteger(value.firstLine) && typeof value.lines === 'string'

const FIELD_KIND_CHECKS: Record<FieldKind, (value: unknown) => boolean> = {
  text: value => typeof value === 'string',
  list: isTextList,
  number: value => Number.isInteger(value),
  yesNo: value => typeof value === 'boolean',
  decisions: value => Array.isArray(value) && value.every(isDecisionInput),
  questions: value => Array.isArray(value) && value.every(isOpenQuestionInput),
  path: value => Array.isArray(value) && value.every(isPathStepInput),
  excerpts: value => Array.isArray(value) && value.every(isExcerptInput),
  forYou: isForYouInput,
}

const FIELD_KIND_WORDS: Record<FieldKind, string> = {
  text: 'a string',
  list: 'an array of strings',
  number: 'a whole number',
  yesNo: 'true or false',
  decisions: 'an array of { question, answer, decidedBy }',
  questions: 'an array of { question, recommended, otherCosts }, each a string, recommended also a list of strings',
  path: 'an array of { what, file, line, note }, line a whole number',
  excerpts: 'an array of { file, firstLine, lines }, firstLine a whole number',
  forYou: 'an object { question, whyNow, options: [{ label, gets, costs } or "Label: what it gets"], recommended, ifUnanswered, steps, alsoYours: [{ what, doneByDefault }], sayingYesTo: { changed, checked, hunks, reviewFound, commitMessage, pullRequestTitle, pullRequestDescription } }',
}

export const unknownFields = (record: JsonRecord, accepted: readonly string[]): string[] =>
  Object.keys(record).filter(key => !accepted.includes(key) && !ENGINE_KEYS.includes(key))

const unknownFieldProblems = (record: JsonRecord, accepted: readonly string[]): string[] =>
  unknownFields(record, accepted).map(key => `unknown field "${key}". Accepted: ${accepted.join(', ')}`)

// For a tool that answers what it can instead of refusing: the fields it left out, said in one sentence.
export const ignoredFieldsNote = (record: JsonRecord, accepted: readonly string[]): string => {
  const ignored = unknownFields(record, accepted)

  return ignored.length === 0
    ? ''
    : ` Ignored ${ignored.map(key => `"${key}"`).join(', ')}: this tool takes ${accepted.join(', ')}.`
}

const missingFieldProblems = (record: JsonRecord, required: readonly string[]): string[] =>
  required.filter(key => record[key] === undefined).map(key => `missing "${key}"`)

const wrongKindProblems = (record: JsonRecord, fields: FieldTable): string[] =>
  Object.entries(fields)
    .filter(([key, kind]) => record[key] !== undefined && !FIELD_KIND_CHECKS[kind](record[key]))
    .map(([key, kind]) => `"${key}" must be ${FIELD_KIND_WORDS[kind]}`)

export const inputProblems = (record: JsonRecord, shape: InputShape, extraAccepted: readonly string[] = []): string[] => [
  ...unknownFieldProblems(record, [...extraAccepted, ...Object.keys(shape.fields)]),
  ...missingFieldProblems(record, shape.required),
  ...wrongKindProblems(record, shape.fields),
]

export const refusalOf = (problems: readonly string[]): ToolAnswer => ({
  refusal: `${problems.join('\n')}\nNothing was written.`,
})
