import { counted } from '../evidence'
import { mayOfferNow } from '../impressions'
import type { Impression } from '../impressions'
import { UNUSED_SKILL_DAYS } from '../detectors'
import { isOwnSkill } from '../standing-due'
import type { Due } from '../standing-due'
import { proposalInWords } from './inbox'
import type { Candidate } from './inbox'

export type TurnEnd = { agentId?: string; reason: string }

const BUSY_AGENT_STATUSES: readonly string[] = ['pending', 'running', 'waiting']

/**
 * An offer at the end of a turn that only paused for a subagent would land
 * mid-work, so a pause counts only when the main loop answered and no agent
 * is still going.
 */
export const isRealPause = (turn: TurnEnd, agentStatuses: readonly string[]): boolean =>
  turn.agentId === undefined &&
  turn.reason === 'answer' &&
  !agentStatuses.some(status => BUSY_AGENT_STATUSES.includes(status))

export const candidateToOffer = (
  noticed: readonly Candidate[],
  impressions: readonly Impression[],
  now: number,
): Candidate | undefined => noticed.find(candidate => mayOfferNow(candidate.fingerprint, impressions, now))

export const offerToast = (candidate: Candidate): string => `Quartermaster: ${candidate.sentence}. Type /quartermaster to see a fix.`

export const RESUPPLY_OFFER = 'offer:resupply'
export const REVIEW_OFFER = 'offer:review'

export const isStandingOffer = (fingerprint: string): boolean => fingerprint.startsWith('offer:')

export const standingFingerprint = (due: Due): string => (due.kind === 'resupply' ? RESUPPLY_OFFER : REVIEW_OFFER)

/** An offer only names the skill: the person types it, and nothing runs until they do. */
export const skillAnswersOffer = (skill: string, fingerprint: string): boolean =>
  (fingerprint === RESUPPLY_OFFER && isOwnSkill(skill, 'resupply')) || (fingerprint === REVIEW_OFFER && isOwnSkill(skill, 'review'))

const roundHistory = (due: Extract<Due, { kind: 'resupply' }>): string =>
  due.since === undefined ? `in the last ${UNUSED_SKILL_DAYS} days` : 'since the last resupply round'

const reviewToast = (due: Extract<Due, { kind: 'review' }>): string => {
  const change = `change ${due.change} (${proposalInWords({ kind: due.proposalKind, target: due.target })})`

  return due.more === 0
    ? `Quartermaster: ${change} has had ${counted(due.sessions, 'session')} to show whether it helps. Type /quartermaster:review to judge it.`
    : `Quartermaster: ${change} and ${due.more} more have had enough sessions to show whether they help. Type /quartermaster:review to judge them.`
}

export const standingToast = (due: Due): string =>
  due.kind === 'resupply'
    ? `Quartermaster: ${counted(due.sessions, 'session')} and ${counted(due.snags, 'snag')} ${roundHistory(due)}. Type /quartermaster:resupply to see what would make this easier.`
    : reviewToast(due)

// A round that ran starts the wait over, so pushbacks from before it are forgotten.
const pushbacksSinceRound = (due: Due, impressions: readonly Impression[]): readonly Impression[] => {
  const roundDay = due.kind === 'resupply' ? due.since : undefined

  return roundDay === undefined ? impressions : impressions.filter(impression => impression.at.slice(0, 10) > roundDay)
}

export const standingToOffer = (due: readonly Due[], impressions: readonly Impression[], now: number): Due | undefined =>
  due.find(each => mayOfferNow(standingFingerprint(each), pushbacksSinceRound(each, impressions), now))
