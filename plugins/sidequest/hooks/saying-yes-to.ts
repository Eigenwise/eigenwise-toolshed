import { fencedDiffOf } from './code-path'

// What the person says yes to before a commit, a push or a pull request, filled in two steps: once the proof has run
// (what changed, how it was checked, the hunks that carry the design), then once the review is back (what it found and
// the words that go out). Each part is kept exactly as written, so the words sent are the words the person read.
export type SayingYesTo = {
  changed: string
  checked: string
  hunks: string
  reviewFound: string
  commitMessage: string
  pullRequestTitle: string
  pullRequestDescription: string
}

export type SayingYesToPart = keyof SayingYesTo

export const SAYING_YES_TO_PARTS: readonly SayingYesToPart[] = [
  'changed',
  'checked',
  'hunks',
  'reviewFound',
  'commitMessage',
  'pullRequestTitle',
  'pullRequestDescription',
]

export const OUTGOING_WORDS: readonly SayingYesToPart[] = ['commitMessage', 'pullRequestTitle', 'pullRequestDescription']

const AFTER_THE_PROOF: readonly SayingYesToPart[] = ['changed', 'checked', 'hunks']

export const PART_NAMES: Record<SayingYesToPart, string> = {
  changed: 'What changed',
  checked: 'How it was checked',
  hunks: 'The hunks that carry the design',
  reviewFound: 'What the review found',
  commitMessage: 'Commit message',
  pullRequestTitle: 'Pull request title',
  pullRequestDescription: 'Pull request description',
}

export const NOTHING_TO_SAY_YES_TO: SayingYesTo = {
  changed: '',
  checked: '',
  hunks: '',
  reviewFound: '',
  commitMessage: '',
  pullRequestTitle: '',
  pullRequestDescription: '',
}

// In the ticket file each part is its name on a line and its text under it, indented four spaces. Indented, a line of
// the text never reads as another part's name or as a heading of the file, and a diff keeps its leading spaces.
const PART_INDENT = '    '

const partNamed = (name: string): SayingYesToPart | undefined =>
  SAYING_YES_TO_PARTS.find(part => PART_NAMES[part].toLowerCase() === name.trim().toLowerCase())

const PART_LINE = new RegExp(`^(${SAYING_YES_TO_PARTS.map(part => PART_NAMES[part]).join('|')}):\\s*(.*)$`, 'i')

export type PartStart = { part: SayingYesToPart; firstLine: string }

export const partStartOf = (line: string): PartStart | undefined => {
  const match = PART_LINE.exec(line.trim())
  const part = match === null ? undefined : partNamed(match[1] ?? '')

  return part === undefined ? undefined : { part, firstLine: match?.[2] ?? '' }
}

export const isPartLine = (line: string): boolean => line.startsWith(PART_INDENT)

export const partLineText = (line: string): string => line.slice(PART_INDENT.length)

const indentedText = (text: string): string => text.split('\n').map(line => (line.trim() === '' ? '' : `${PART_INDENT}${line}`)).join('\n')

const withoutOuterBlankLines = (text: string): string => text.replace(/^(\s*\n)+/, '').trimEnd()

export const sayingYesToText = (parts: SayingYesTo): string =>
  SAYING_YES_TO_PARTS.filter(part => parts[part].trim() !== '')
    .map(part => `${PART_NAMES[part]}:\n${indentedText(withoutOuterBlankLines(parts[part]))}`)
    .join('\n')

export const hasSayingYesTo = (parts: SayingYesTo): boolean => SAYING_YES_TO_PARTS.some(part => parts[part].trim() !== '')

export const hasAfterTheReview = (parts: SayingYesTo): boolean =>
  parts.reviewFound.trim() !== '' || OUTGOING_WORDS.some(part => parts[part].trim() !== '')

export const changedParts = (before: SayingYesTo, after: SayingYesTo): SayingYesToPart[] =>
  SAYING_YES_TO_PARTS.filter(part => withoutOuterBlankLines(before[part]) !== withoutOuterBlankLines(after[part]))

// The hunks come with or without their fence: what is kept is the diff, drawn as one.
export const diffOfHunks = (hunks: string): string => fencedDiffOf(hunks).diff || withoutOuterBlankLines(hunks)

const isText = (value: unknown): value is string => typeof value === 'string'

export const sayingYesToFromInput = (value: Record<string, unknown>): Partial<SayingYesTo> =>
  Object.fromEntries(SAYING_YES_TO_PARTS.flatMap(part => (isText(value[part]) ? [[part, withoutOuterBlankLines(value[part])]] : [])))

const partForTheChat = (parts: SayingYesTo, part: SayingYesToPart): string => {
  const text = part === 'hunks' ? `\`\`\`diff\n${diffOfHunks(parts.hunks)}\n\`\`\`` : withoutOuterBlankLines(parts[part])

  return `${PART_NAMES[part]}:\n${text}`
}

const chatText = (parts: SayingYesTo, which: readonly SayingYesToPart[]): string =>
  which.filter(part => parts[part].trim() !== '').map(part => partForTheChat(parts, part)).join('\n\n')

export const afterTheProofText = (parts: SayingYesTo): string => chatText(parts, AFTER_THE_PROOF)

export const afterTheReviewText = (parts: SayingYesTo): string => chatText(parts, ['reviewFound', ...OUTGOING_WORDS])

const LONGEST_WORDS_SHOWN = 80

const shortWords = (text: string): string => {
  const line = text.replace(/\s*\n\s*/g, ' ').trim()

  return line.length <= LONGEST_WORDS_SHOWN ? line : `${line.slice(0, LONGEST_WORDS_SHOWN - 3).trimEnd()}...`
}

// Logged on the ticket when words the person already said yes to change, so the closing message can say so.
export const WORDS_CHANGED_AFTER_THE_YES = 'words changed after the yes:'

export const wordsChangedAfterTheYesLine = (before: SayingYesTo, after: SayingYesTo): string | undefined => {
  const changed = changedParts(before, after).filter(part => OUTGOING_WORDS.includes(part) && before[part].trim() !== '')
  if (changed.length === 0) return undefined

  return `${WORDS_CHANGED_AFTER_THE_YES} ${changed.map(part => `${PART_NAMES[part].toLowerCase()} from ${JSON.stringify(shortWords(before[part]))} to ${JSON.stringify(shortWords(after[part]))}`).join('; ')}`
}
