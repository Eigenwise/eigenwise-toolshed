export type QuartermasterCandidateKind = 'script' | 'fix' | 'permission' | 'retire'

/**
 * A detector crossed its threshold. `fingerprint` is `<kind>:<target>` and is
 * what a proposal's evidence and rejected.md refer to.
 */
export type QuartermasterCandidate = {
  fingerprint: string
  kind: QuartermasterCandidateKind
  target: string
  count: number
  firstSeen: string
  lastSeen: string
  sentence: string
}

export type QuartermasterInbox = { waiting: number }

/** One proposal file as the inbox draws it. */
export type QuartermasterProposalCard = {
  id: string
  kind: string
  target: string
  status: string
  evidence: string[]
  expect: string
  baseline: number
  created: string
  body: string
  answered?: string
  reason?: string
}

/**
 * `handledWithinWindow` holds the fingerprints of proposals the person closed with Already handled while the
 * evidence window still covers what they were proposed for. `setAsideForNow` holds what the person pressed Later
 * on, while that wait lasts; `setAsideUntil` gives the day each wait ends.
 */
export type QuartermasterRecords = {
  proposals: QuartermasterProposalCard[]
  rejected: string[]
  handledWithinWindow?: string[]
  setAsideForNow?: string[]
  setAsideUntil?: Record<string, string>
}

/** Which detail the inbox pane shows; neither set means the list. */
export type QuartermasterInboxView = { proposal?: string; candidate?: string }

/** The one offer this session made, and whether /quartermaster was opened since. */
export type QuartermasterOffer = { fingerprint: string; isReviewed: boolean }

/**
 * Something Quartermaster may offer once the evidence allows it. A round waits for sessions and snags since the
 * last one (`since` is that round's day, absent when none is on record); a review waits for the sessions since an
 * applied change, and `more` counts the other changes due beside the one named.
 */
export type QuartermasterDue =
  | { kind: 'resupply'; sessions: number; snags: number; since?: string }
  | { kind: 'review'; change: string; proposalKind: string; target: string; sessions: number; more: number }

/** What the person has typed so far as the reason for rejecting the proposal on screen. */
export type QuartermasterRejectionReason = string

/** What went wrong with the last press, shown in the pane until the next press works or Back is pressed. */
export type QuartermasterPressProblem = string

declare module 'claude-code' {
  interface PluginState {
    quartermaster: {
      inbox: QuartermasterInbox
      candidates: QuartermasterCandidate[]
      records: QuartermasterRecords
      view: QuartermasterInboxView
      offer: QuartermasterOffer
      due: QuartermasterDue[]
      rejectionReason: QuartermasterRejectionReason
      pressProblem: QuartermasterPressProblem
    }
  }
}
