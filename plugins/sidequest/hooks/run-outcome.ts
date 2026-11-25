import type { Ticket } from './tickets'

export const FINISH_OUTCOMES = ['done', 'failed', 'needs-you'] as const
export type FinishOutcome = (typeof FINISH_OUTCOMES)[number]

export const NOT_RECORDED = 'not recorded'

// "nothing needed", "Nothing, all done", "none", "n/a", a lone dash: each says there is no need.
const NO_NEED = new RegExp(`^(?:(?:nothing|none|no|n/a|${NOT_RECORDED})(?![a-z])|-*$)`)

export const isFinishOutcome = (value: string | undefined): value is FinishOutcome =>
  FINISH_OUTCOMES.some(outcome => outcome === value)

const plainWords = (text: string | undefined): string =>
  (text ?? '').trim().toLowerCase().replace(/[`*_.]/g, '').trim()

export const namesANeed = (needs: string | undefined): boolean => !NO_NEED.test(plainWords(needs))

const isFailureWord = (word: string): boolean => /^(fail|error)/.test(word)

const isWaitingWord = (word: string): boolean => /need|^block|^wait/.test(word)

// Two of three baseline sessions on 2026-11-19 finished a build with "review", meaning it is ready for one. Read as a
// need, it parked the ticket at needs-you and no review ran.
const isReadyForReviewWord = (word: string): boolean => /^(?:ready for )?review(?:ed)?$/.test(word)

const outcomeTheWordSays = (word: string): FinishOutcome | undefined => {
  if (isReadyForReviewWord(word)) return 'done'

  return isFailureWord(word) ? 'failed' : undefined
}

// A run's own outcome word wins when it is one of the three. Anything else is read, never refused: a weaker model
// writes "success" or "blocked" as readily as "done".
export const readOutcome = (outcomeWord: string | undefined, needs: string | undefined): FinishOutcome => {
  if (isFinishOutcome(outcomeWord)) return outcomeWord
  const word = plainWords(outcomeWord)
  const said = outcomeTheWordSays(word)
  if (said !== undefined) return said

  return isWaitingWord(word) || namesANeed(needs) ? 'needs-you' : 'done'
}

type FinishWords = { outcome?: string; result?: string; needs?: string }

// A finish that carries no outcome and no result is a run that returned nothing. Read as done it went to review and
// the land step collected it as ready.
export const readFinishOutcome = (words: FinishWords): FinishOutcome =>
  words.outcome === undefined && words.result === undefined ? 'failed' : readOutcome(words.outcome, words.needs)

export const statusAfter = (outcome: FinishOutcome, ticket: Ticket): string => {
  const doneStatus = ticket.kind === 'build' ? 'review' : 'done'
  const statuses: Record<FinishOutcome, string> = { done: doneStatus, failed: 'needs-you', 'needs-you': 'needs-you' }

  return statuses[outcome]
}
