import { mayOfferNow } from '../impressions'
import type { Impression } from '../impressions'
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

export const offerToast = (candidate: Candidate): string => `Quartermaster: ${candidate.sentence}. Type /qm to see a fix.`
