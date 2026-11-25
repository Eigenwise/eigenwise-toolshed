import type { Ticket } from './tickets'

export type EarlierRun = { branch?: string; failure?: string; earlierFailures?: string[] }

const FINISHED_LINE = /^\S+ finished /
const FINISHED_BRANCH = /^\S+ finished \S+ branch (\S+)/
const STARTED_LINE = /^\S+ started /
const RETURN_RECORD_BRANCH = /^\S+ branch (.+)$/
const OUTCOME_NOTE = /^\S+ note ((?:review (?:pass|fail|skipped)|verify fail|ci fail)\b.*)$/
const FAILURE_KIND = /^(review|verify|ci) fail\b/
const ANSWER_LINE = /^\S+ answered by human in the board: (.*)$/
const BRANCH_NAME = /^\w[\w./-]*$/
const FAILURE_CHARACTER_CAP = 2000
const PROSE_WORDS = ['none', 'not', 'n/a', 'nothing']

// The board writes the agent's own words, so the value may be "`worktree-x` (2 commits)" or prose like "not recorded".
export const branchNameIn = (recorded: string): string | undefined => {
  const plain = recorded.replace(/`/g, '')
  const firstWord = plain.split(/\s+/)[0] ?? ''
  const isProse = PROSE_WORDS.includes(firstWord.toLowerCase()) || /^main checkout/i.test(plain)

  return BRANCH_NAME.test(firstWord) && !isProse ? firstWord : undefined
}

const HOST_NAMED_BRANCH = /^worktree-agent-/

// The value a finish may name as a branch: one token once backticks and surrounding space are off, and not a branch
// the host named. Whether a local branch of that name exists is for git to say.
export const finishBranchToken = (given: string): string | undefined => {
  const token = given.replace(/`/g, '').trim()

  return token === '' || /\s/.test(token) || HOST_NAMED_BRANCH.test(token) ? undefined : token
}

const returnedBranchOf = (log: readonly string[]): string | undefined => {
  const lastStart = log.findLastIndex(line => STARTED_LINE.test(line))
  const recorded = log.slice(lastStart + 1).flatMap(line => RETURN_RECORD_BRANCH.exec(line)?.[1] ?? [])

  return recorded.map(branchNameIn).findLast(name => name !== undefined)
}

// The last finish decides; only when it names no branch is the agent's own return record read.
const branchOf = (log: readonly string[]): string | undefined => {
  const lastFinish = log.findLast(line => FINISHED_LINE.test(line))
  const finished = lastFinish === undefined ? undefined : FINISHED_BRANCH.exec(lastFinish)?.[1]

  return finished ?? returnedBranchOf(log)
}

const failureKindOf = (note: string): string | undefined => FAILURE_KIND.exec(note)?.[1]

// Only the newest outcome counts: a fail that a later review pass answered was already dealt with.
const failuresOf = (log: readonly string[]): { failure?: string; earlierFailures: string[] } => {
  const notes = log.flatMap(line => OUTCOME_NOTE.exec(line)?.[1] ?? [])
  const newest = notes.at(-1)
  if (newest === undefined || failureKindOf(newest) === undefined) return { earlierFailures: [] }

  return { failure: newest, earlierFailures: notes.slice(0, -1).filter(note => failureKindOf(note) !== undefined) }
}

export const earlierRunOf = (ticket: Ticket): EarlierRun | undefined => {
  const branch = branchOf(ticket.log)
  const { failure, earlierFailures } = failuresOf(ticket.log)

  return branch === undefined && failure === undefined ? undefined : { branch, failure, earlierFailures }
}

const instructionFor = (branch: string | undefined): string =>
  branch
    ? `The last run committed on branch ${branch}. Merge it into your worktree first and build on it instead of starting over.`
    : 'No branch was recorded for the last run.'

const FAILURE_HEADINGS: Record<string, string> = {
  review: 'The review that sent it back',
  verify: 'The verify that sent it back',
  ci: 'The CI run that sent it back',
}

const failureHeading = (failure: string): string => FAILURE_HEADINGS[failureKindOf(failure) ?? 'review'] ?? 'What sent it back'

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

// The agent starts fresh and a log can run long, so only the newest answers travel, each cut at a length, and the
// newest failure note is cut too. The ticket's own log still holds every word.
export const ANSWER_COUNT_CAP = 5
export const ANSWER_CHARACTER_CAP = 800

const capped = (text: string, limit: number): string => (text.length > limit ? `${text.slice(0, limit)} ...(cut)` : text)

const earlierFailuresLine = (earlierFailures: readonly string[]): string => {
  if (earlierFailures.length === 0) return ''
  const kinds = [...new Set(earlierFailures.map(note => `${failureKindOf(note)} fail`))]

  return `\n\nIt failed ${plural(earlierFailures.length, 'time')} before this (${kinds.join(', ')}).`
}

const failureText = (failure: string | undefined, earlierFailures: readonly string[] | undefined): string => {
  if (failure === undefined) return ''

  return `\n\n${failureHeading(failure)}:\n${capped(failure, FAILURE_CHARACTER_CAP)}${earlierFailuresLine(earlierFailures ?? [])}`
}

export const earlierRunSection = (earlier: EarlierRun | undefined): string[] => {
  if (!earlier) return []

  return [`## Earlier run\n${instructionFor(earlier.branch)}${failureText(earlier.failure, earlier.earlierFailures)}`]
}

const humanAnswersOf = (log: readonly string[]): string[] => log.flatMap(line => ANSWER_LINE.exec(line)?.[1] ?? [])

const leftOutLine = (leftOut: number): string =>
  leftOut > 0 ? `\n(The ${plural(leftOut, 'oldest answer')} left out to keep this brief short. The ticket's log has them.)` : ''

export const humanAnswersSection = (ticket: Ticket): string[] => {
  const answers = humanAnswersOf(ticket.log)
  if (answers.length === 0) return []
  const shown = answers.slice(-ANSWER_COUNT_CAP)
  const lines = shown.map(answer => `- ${capped(answer, ANSWER_CHARACTER_CAP)}`).join('\n')

  return [`## What the person answered\nTheir words, as logged, oldest first. They settle what they answer.\n${lines}${leftOutLine(answers.length - shown.length)}`]
}
