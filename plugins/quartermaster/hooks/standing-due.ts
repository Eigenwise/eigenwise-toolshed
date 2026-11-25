import { fingerprintOf } from './detectors'
import type { Candidate } from './detectors'
import { dayOf } from './events'
import type { SensedEvent } from './events'
import { isHandledPastItsWindow } from './proposals'
import type { Proposal } from './proposals'
import type { QuartermasterDue } from '../types'

export const ROUND_MIN_SESSIONS = 15
export const ROUND_MIN_DAYS = 7
export const ROUND_MIN_SNAGS = 30
export const REVIEW_MIN_SESSIONS = 3

export type Due = QuartermasterDue

/** What an applied change records about itself: when it landed, which is where its check window starts. */
export type AppliedChange = { id: string; proposal: string; kind: string; target: string; created: string }

const SNAG_KINDS: readonly string[] = ['failure', 'denial', 'typed']

const isAfterDay = (day: string, since: string | undefined): boolean => since === undefined || day > since

/** Only this plugin's own skill counts: another plugin's `review` is not an answer to ours. */
export const isOwnSkill = (skill: string, name: string): boolean => skill === name || skill === `quartermaster:${name}`

/** A hand-written change record may hold anything where its time should be. */
export const hasUsableCreated = (created: unknown): created is string =>
  typeof created === 'string' && !Number.isNaN(Date.parse(created))

const skillRunDays = (events: readonly SensedEvent[], name: string): string[] =>
  events.flatMap(event => (event.kind === 'skill' && isOwnSkill(event.skill, name) ? [dayOf(event.at)] : []))

/** One day per session file, in order: a session that spans midnight counts on each day it wrote. */
export const sessionDaysAfter = (sessionFiles: readonly string[], since: string | undefined): string[] =>
  [...new Set(sessionFiles)]
    .map(name => name.slice(0, 10))
    .filter(day => isAfterDay(day, since))
    .sort()

/**
 * A round is known by the resupply skill having run or by a proposal's date,
 * whichever is later. Both only have a day to say, so a day is the clock.
 */
export const lastRoundDay = (events: readonly SensedEvent[], proposals: readonly Proposal[]): string | undefined =>
  [...skillRunDays(events, 'resupply'), ...proposals.map(proposal => proposal.created)].sort().pop()

const hasOpenCandidate = (candidates: readonly Candidate[], proposals: readonly Proposal[], now: number): boolean => {
  const settled = new Set(proposals.filter(proposal => !isHandledPastItsWindow(proposal, now)).flatMap(proposal => [fingerprintOf(proposal.kind, proposal.target), ...proposal.evidence]))

  return candidates.some(candidate => !settled.has(candidate.fingerprint))
}

const snagsSince = (events: readonly SensedEvent[], since: string | undefined): number =>
  events.filter(event => SNAG_KINDS.includes(event.kind) && isAfterDay(dayOf(event.at), since)).length

export type EvidenceSoFar = {
  events: readonly SensedEvent[]
  sessionFiles: readonly string[]
  candidates: readonly Candidate[]
  proposals: readonly Proposal[]
  changes: readonly AppliedChange[]
  now: number
}

type Pile = { sessions: number; days: number; snags: number }

const isPileEnough = (pile: Pile): boolean =>
  pile.sessions >= ROUND_MIN_SESSIONS && pile.days >= ROUND_MIN_DAYS && pile.snags >= ROUND_MIN_SNAGS

const roundDue = (evidence: EvidenceSoFar): Due[] => {
  const since = lastRoundDay(evidence.events, evidence.proposals)
  const sessionDays = sessionDaysAfter(evidence.sessionFiles, since)
  const pile = { sessions: sessionDays.length, days: new Set(sessionDays).size, snags: snagsSince(evidence.events, since) }
  if (!isPileEnough(pile) || !hasOpenCandidate(evidence.candidates, evidence.proposals, evidence.now)) return []

  return [{ kind: 'resupply', sessions: pile.sessions, snags: pile.snags, ...(since === undefined ? {} : { since }) }]
}

const TRIAL_STATUSES: readonly string[] = ['applied', 'loaded', 'exercised']

/** A change is on trial from the day it is applied until a review moves it to useful or rolls it back. */
export const isInTrial = (proposal: Proposal | undefined): boolean =>
  proposal !== undefined && TRIAL_STATUSES.includes(proposal.status)

/**
 * The check window is the one the review skill reads: three sessions after the
 * day the change landed. A review run on or after the day that window closed
 * has judged it; one run earlier only said it was too early.
 */
const reviewDue = (change: AppliedChange, evidence: EvidenceSoFar): Due[] => {
  const proposal = evidence.proposals.find(each => each.id === change.proposal)
  const sessionDays = sessionDaysAfter(evidence.sessionFiles, dayOf(change.created))
  const windowClosedOn = sessionDays[REVIEW_MIN_SESSIONS - 1]
  if (!isInTrial(proposal) || windowClosedOn === undefined) return []
  if (skillRunDays(evidence.events, 'review').some(day => day >= windowClosedOn)) return []

  return [{ kind: 'review', change: change.id, proposalKind: change.kind, target: change.target, sessions: sessionDays.length, more: 0 }]
}

const reviewsDue = (evidence: EvidenceSoFar): Due[] => {
  const [first, ...others] = evidence.changes.flatMap(change => reviewDue(change, evidence))

  return first === undefined || first.kind !== 'review' ? [] : [{ ...first, more: others.length }]
}

/** Reviews first: a change that can be judged is a smaller, more concrete ask than a whole round. One review offer covers every change due. */
export const dueOffers = (evidence: EvidenceSoFar): Due[] => [...reviewsDue(evidence), ...roundDue(evidence)]

/** Whatever goes wrong while working out what is due means nothing is due: an offer is never worth the session's memory. */
export const dueOffersOrNone = (evidence: EvidenceSoFar): Due[] => {
  try {
    return dueOffers(evidence)
  } catch {
    return []
  }
}
