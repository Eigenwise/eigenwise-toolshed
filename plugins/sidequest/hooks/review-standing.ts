import type { Ticket } from './tickets'

export type ReviewStandingKind = 'none' | 'skipped' | 'passed' | 'passed-on-second-read' | 'failed' | 'fixed-without-second-read'

export type ReviewStanding = { kind: ReviewStandingKind; finding: string }

type EventKind = 'fail' | 'pass' | 'skipped' | 'fixed' | 'reviewer-returned'
type Event = { kind: EventKind; finding: string }

type Reading = {
  outcome: 'none' | 'skipped' | 'passed' | 'failed'
  finding: string | undefined
  fixedSinceFail: boolean
  reviewerSinceFail: boolean
  reviewerBeforePass: boolean
}

const NOTE_KIND: Record<string, EventKind> = { pass: 'pass', fail: 'fail', failed: 'fail', failure: 'fail', skipped: 'skipped', fixed: 'fixed' }

const REVIEW_NOTE = /^\S+ note review (pass|fail|failed|failure|skipped|fixed)\b:?\s*(.*)$/
// A cut-off, errored or refused run says nothing about the work, so only a run that ended with an answer counts.
const REVIEWER_RETURN = /^\S+ returned review run after /

const eventOf = (line: string): Event | undefined => {
  const note = REVIEW_NOTE.exec(line)
  const kind = NOTE_KIND[note?.[1] ?? '']
  if (note !== null && kind !== undefined) return { kind, finding: note[2] ?? '' }

  return REVIEWER_RETURN.test(line) ? { kind: 'reviewer-returned', finding: '' } : undefined
}

const START: Reading = { outcome: 'none', finding: undefined, fixedSinceFail: false, reviewerSinceFail: false, reviewerBeforePass: false }

// A reviewer that returned before this fix did not read it.
const afterFix = (reading: Reading): Reading => (reading.outcome === 'failed' ? { ...reading, fixedSinceFail: true, reviewerSinceFail: false } : reading)

const READINGS: Record<EventKind, (reading: Reading, event: Event) => Reading> = {
  fail: (_reading, event) => ({ ...START, outcome: 'failed', finding: event.finding }),
  pass: reading => ({ ...reading, outcome: 'passed', reviewerBeforePass: reading.reviewerSinceFail }),
  skipped: reading => ({ ...reading, outcome: 'skipped' }),
  fixed: afterFix,
  'reviewer-returned': reading => ({ ...reading, reviewerSinceFail: true }),
}

const readLog = (log: readonly string[]): Reading =>
  log.reduce<Reading>((reading, line) => {
    const event = eventOf(line)

    return event === undefined ? reading : READINGS[event.kind](reading, event)
  }, START)

const passedStanding = (reading: Reading): ReviewStanding => {
  if (reading.finding === undefined) return { kind: 'passed', finding: '' }
  if (reading.reviewerBeforePass) return { kind: 'passed-on-second-read', finding: reading.finding }

  return { kind: 'fixed-without-second-read', finding: reading.finding }
}

const failedStanding = (reading: Reading): ReviewStanding => ({
  kind: reading.fixedSinceFail ? 'fixed-without-second-read' : 'failed',
  finding: reading.finding ?? '',
})

const STANDING_OF: Record<Reading['outcome'], (reading: Reading) => ReviewStanding> = {
  none: () => ({ kind: 'none', finding: '' }),
  skipped: () => ({ kind: 'skipped', finding: '' }),
  passed: passedStanding,
  failed: failedStanding,
}

// A pass after a fail counts as a second read only when a reviewer's return is on the log after that fail: the
// session's own `review pass:` note after its own fix is not a reviewer reading the fix.
export const reviewStandingOf = (ticket: Ticket): ReviewStanding => {
  const reading = readLog(ticket.log)

  return STANDING_OF[reading.outcome](reading)
}

const LONGEST_FINDING = 90
// Real fail notes also read `review fail, from reading ...`, `review fail - ...` and `review fail (second): ...`.
const BEFORE_THE_FINDING = /^(?:[\s,:;.]+|-\s|\([^)]*\))+/
const TRAILING_PUNCTUATION = /[\s.:;,]+$/
const LAST_WORD_BEGUN = /\s+\S*$/

const cutToFit = (oneLine: string): string =>
  oneLine.length <= LONGEST_FINDING ? oneLine : `${oneLine.slice(0, LONGEST_FINDING + 1).replace(LAST_WORD_BEGUN, '').replace(TRAILING_PUNCTUATION, '')}...`

const findingOnOneLine = (finding: string): string =>
  cutToFit(finding.replace(/\s+/g, ' ').replace(BEFORE_THE_FINDING, '').trim().replace(TRAILING_PUNCTUATION, ''))

const ENDS_AS_A_SENTENCE = /(?:\.\.\.|[?!])$/

const endedAsSentence = (text: string): string => (ENDS_AS_A_SENTENCE.test(text) ? text : `${text}.`)

// A colon and the finding as it was written: findings are whole sentences as often as they are a thing to fail on.
const failedLine = (finding: string): string => {
  const found = findingOnOneLine(finding)

  return endedAsSentence(found === '' ? 'The review failed' : `The review failed: ${found}`)
}

const SAYING: Record<ReviewStandingKind, (finding: string) => string> = {
  none: () => '',
  skipped: () => 'The review was skipped.',
  passed: () => 'The review passed.',
  'passed-on-second-read': () => 'The review passed on a second read, after a fix.',
  failed: failedLine,
  'fixed-without-second-read': finding => `${failedLine(finding)} Fixed after, not reviewed again.`,
}

export const reviewStandingLine = (ticket: Ticket): string => {
  const standing = reviewStandingOf(ticket)

  return SAYING[standing.kind](standing.finding)
}

export const reviewReadsAsPassed = (ticket: Ticket): boolean => {
  const { kind } = reviewStandingOf(ticket)

  return kind === 'passed' || kind === 'passed-on-second-read'
}
