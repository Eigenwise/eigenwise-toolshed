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
}

/** `setAsideForNow` holds what the person pressed Later on, while that wait lasts. */
export type QuartermasterRecords = { proposals: QuartermasterProposalCard[]; rejected: string[]; setAsideForNow?: string[] }

/** Which detail the inbox pane shows; neither set means the list. */
export type QuartermasterInboxView = { proposal?: string; candidate?: string }

/** The one offer this session made, and whether /qm was opened since. */
export type QuartermasterOffer = { fingerprint: string; isReviewed: boolean }

/** What the person has typed so far as the reason for rejecting the proposal on screen. */
export type QuartermasterRejectionReason = string

declare module 'claude-code' {
  interface PluginState {
    quartermaster: {
      inbox: QuartermasterInbox
      candidates: QuartermasterCandidate[]
      records: QuartermasterRecords
      view: QuartermasterInboxView
      offer: QuartermasterOffer
      rejectionReason: QuartermasterRejectionReason
    }
  }
}
