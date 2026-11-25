import { hasStringFields, isJsonObject } from './tool-input'

export type TypedCommandEvent = { kind: 'typed'; at: string; prefix: string }
/**
 * A shell call's `signature` is the command that failed and `error` the words
 * of its error text. Events written before `error` existed carry the command
 * alone, and a failure of any other tool carries the error words as `signature`.
 */
export type FailureEvent = { kind: 'failure'; at: string; tool: string; signature: string; error?: string }
export type DenialEvent = { kind: 'denial'; at: string; tool: string; target: string }
export type TurnEvent = { kind: 'turn'; at: string; durationMs: number; toolCount: number }
export type SkillEvent = { kind: 'skill'; at: string; skill: string }
export type CompactionEvent = { kind: 'compaction'; at: string; trigger: string }

export type SensedEvent = TypedCommandEvent | FailureEvent | DenialEvent | TurnEvent | SkillEvent | CompactionEvent

const SHELL_SEPARATOR = /&&|\|\||[|;&\n]/
const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const PLAIN_WORD = /^[A-Za-z][A-Za-z0-9_:-]*$/
const LONGEST_PLAIN_WORD = 24
const PREFIX_WORDS = 2

const isPrefixWord = (word: string): boolean =>
  PLAIN_WORD.test(word) && word.length <= LONGEST_PLAIN_WORD && !looksLikeSecret(word)

const looksLikeSecret = (word: string): boolean => /\d/.test(word) && /[A-Za-z]/.test(word) && word.length >= 16

const QUOTED_STRING = /(["'`])(?:\\.|(?!\1).)*\1?/g

export const withoutQuotedStrings = (command: string): string => command.replace(QUOTED_STRING, ' ')

const firstCommandOf = (command: string): string => withoutQuotedStrings(command).split(SHELL_SEPARATOR)[0] ?? ''

/**
 * The first two plain words of the first command in a shell line. Paths, flags,
 * quoted strings, variable assignments and anything that looks like a token
 * are dropped, so an argument or a secret never reaches the event log.
 */
export const commandPrefix = (command: string): string =>
  firstCommandOf(command)
    .trim()
    .split(/\s+/)
    .filter(word => !ENVIRONMENT_ASSIGNMENT.test(word))
    .filter(isPrefixWord)
    .slice(0, PREFIX_WORDS)
    .join(' ')
    .toLowerCase()

const LONGEST_SIGNATURE = 60
const WORD_BEFORE_A_SECRET = /^(?:password|passwd|token|secret|bearer|key|authorization)\W*$/i
const HOST_NAME = /[A-Za-z0-9]\.[A-Za-z0-9]/

// A letters-only password or host name survives the word filter, so the word after a credential's name and anything dotted is dropped here.
const withoutKeptSecrets = (words: readonly string[]): string[] =>
  words.filter((word, index) => !HOST_NAME.test(word) && !WORD_BEFORE_A_SECRET.test(words[index - 1] ?? ''))

const wordsOfFirstLine = (errorText: string): string[] => withoutQuotedStrings(errorText.split('\n')[0] ?? '').split(/\s+/)

const plainWordsOf = (words: readonly string[]): string =>
  words
    .filter(word => /^[A-Za-z][A-Za-z,.:-]*$/.test(word) && word.length <= LONGEST_PLAIN_WORD)
    .join(' ')
    .replace(/[,.:]+$/, '')
    .slice(0, LONGEST_SIGNATURE)
    .toLowerCase()

/**
 * A failure's text reduced to its words: the first line, with quoted strings,
 * paths, numbers and long tokens taken out, so two runs of the same failure on
 * different files share one signature.
 */
export const failureSignature = (errorText: string): string => plainWordsOf(wordsOfFirstLine(errorText))

/**
 * One line of a shell error reduced the same way, with host names and the word
 * after a credential's name taken out too. Only shell errors get this: the
 * signatures of other tools stay spelled as they were, so a candidate the
 * person rejected earlier still matches its rejection.
 */
export const errorLineWords = (line: string): string => plainWordsOf(withoutKeptSecrets(wordsOfFirstLine(line)))

const SHELL_TOOLS: readonly string[] = ['Bash', 'PowerShell']

export const isShellTool = (tool: string): boolean => SHELL_TOOLS.includes(tool)

const errorWordsOf = (event: FailureEvent): string => (typeof event.error === 'string' ? event.error : '')

/** What a failure is counted as: the tool, what failed, and for a shell call the words of its error. */
export const failureLabel = (event: FailureEvent): string =>
  isShellTool(event.tool)
    ? [event.tool, event.signature, errorWordsOf(event)].filter(part => part !== '').join(': ')
    : `${event.tool}: ${event.signature}`.trim()

/** A shell failure written before the error words were kept cannot say what went wrong, so it never repeats an error. */
export const repeatsAnError = (event: FailureEvent): boolean => !isShellTool(event.tool) || errorWordsOf(event) !== ''

export const projectSlug = (cwd: string): string =>
  cwd
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

export const dayOf = (at: string): string => at.slice(0, 10)

export const eventLines = (events: readonly SensedEvent[]): string =>
  events.map(event => `${JSON.stringify(event)}\n`).join('')

const EVENT_KINDS: readonly string[] = ['typed', 'failure', 'denial', 'turn', 'skill', 'compaction']

const isSensedEvent = (value: unknown): value is SensedEvent =>
  isJsonObject(value) && hasStringFields(value, ['at']) && EVENT_KINDS.includes(String(value.kind))

const parsedLine = (line: string): unknown => {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/** Every line that parses; a torn last line from a crashed write is skipped. */
export const jsonLines = (text: string): unknown[] =>
  text
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(parsedLine)

export const parseEventLines = (text: string): SensedEvent[] => jsonLines(text).filter(isSensedEvent)
