import { fingerprintOf } from '../detectors'
import type { Proposal } from '../proposals'
import type { QuartermasterCandidate, QuartermasterProposalCard, QuartermasterRecords } from '../../types'

export type ProposalCard = QuartermasterProposalCard
export type Records = QuartermasterRecords
export type Candidate = QuartermasterCandidate

const WAITING_STATUSES: readonly string[] = ['offered', 'draft']

export const WAITING_HEADING = 'Waiting on you'
export const NOTICED_HEADING = 'Noticed in this project'
export const NOTICED_HINT = 'Press one to have a fix drafted, or to stop hearing about it.'
export const NOTHING_TO_SHOW =
  'Nothing here. When something keeps going wrong or keeps being done by hand, it shows up here with a fix you can approve.'
export const WHAT_EACH_PRESS_DOES =
  'Draft a fix writes a proposal you approve before anything changes. Later: no reminder about it for a while. ' +
  'Ignore in this project: it is never brought up here again.'

export const WHAT_EACH_ANSWER_DOES =
  'Approve makes the change now, and it can be undone. Reject is remembered for this project. Later hides it for a few days.'
export const REASON_LABEL = 'Why not? (optional)'

export const EMPTY_RECORDS: Records = { proposals: [], rejected: [] }

export const proposalCard = (proposal: Proposal): ProposalCard => ({
  id: proposal.id,
  kind: proposal.kind,
  target: proposal.target,
  status: proposal.status,
  evidence: [...proposal.evidence],
  expect: proposal.expect,
  baseline: proposal.baseline,
  created: proposal.created,
  body: proposal.body,
})

export const waitingProposals = (records: Records): ProposalCard[] =>
  records.proposals.filter(card => WAITING_STATUSES.includes(card.status))

export const proposalFingerprint = (card: Pick<ProposalCard, 'kind' | 'target'>): string => fingerprintOf(card.kind, card.target)

/** Later on a proposal hides it from the pane until its wait is over, as Later does on a noticed line. It still counts as waiting. */
export const proposalsInSight = (records: Records): ProposalCard[] => {
  const setAside = new Set(records.setAsideForNow ?? [])

  return waitingProposals(records).filter(card => !setAside.has(proposalFingerprint(card)))
}

const proposedFingerprints = (records: Records): Set<string> =>
  new Set(records.proposals.flatMap(card => [proposalFingerprint(card), ...card.evidence]))

// A repeated failure names no fix a person could approve, so it stays evidence for an improvement round and off the list.
const KINDS_WITH_A_FIX_TO_OFFER: readonly string[] = ['script', 'permission', 'retire']

/** Candidates with a fix to offer that nobody has proposed anything for, turned down or set aside for now. */
export const noticedCandidates = (candidates: readonly Candidate[], records: Records): Candidate[] => {
  const settled = new Set([...proposedFingerprints(records), ...records.rejected, ...(records.setAsideForNow ?? [])])

  return candidates.filter(candidate => KINDS_WITH_A_FIX_TO_OFFER.includes(candidate.kind) && !settled.has(candidate.fingerprint))
}

// What was noticed may have stopped happening since: then there is no sentence, and a bare fingerprint says nothing.
export const whyItWasProposed = (card: ProposalCard, candidates: readonly Candidate[]): string[] =>
  card.evidence.flatMap(fingerprint => {
    const sentence = candidates.find(candidate => candidate.fingerprint === fingerprint)?.sentence

    return sentence === undefined ? [] : [`Why: ${sentence}`]
  })

export const expectationLine = (card: ProposalCard): string =>
  `Quartermaster checks later whether this helped: ${card.expect}. Today: ${card.baseline}.`

const VERB_BEFORE_TARGET: Record<string, string> = {
  rule: 'Add a rule:',
  skill: 'Add a skill:',
  'skill-improvement': 'Improve skill:',
  setting: 'Change setting:',
  plugin: 'Install plugin:',
  routing: 'Change which model does:',
  script: 'Add a script for:',
  retire: 'Remove unused:',
  upstream: 'Report a problem in:',
  docs: 'Write down:',
}

export const proposalInWords = (card: Pick<ProposalCard, 'kind' | 'target'>): string =>
  card.kind === 'permission'
    ? `Let Claude run ${card.target} without asking`
    : `${VERB_BEFORE_TARGET[card.kind] ?? `${card.kind}:`} ${card.target}`

// Only where a person answers in words: there the id is what they type.
export const proposalLine = (card: ProposalCard): string => `${card.id} ${proposalInWords(card)}`

const SAYS_IT_WAS_ANSWERED = /cannot become|use operation/
const SAYS_THE_FILE_IS_BAD = /there is no proposal|does not parse/
const PROPOSAL_ID = /P-\d+/

const proposalFileIn = (refusal: string): string => {
  const id = PROPOSAL_ID.exec(refusal)?.[0]

  return id === undefined ? '.claude/quartermaster/proposals/' : `.claude/quartermaster/proposals/${id}.md`
}

/** A refusal is written for the session. What a press in the pane toasts says the same in a person's words. */
export const refusalInWords = (refusal: string): string => {
  if (SAYS_IT_WAS_ANSWERED.test(refusal)) return 'That one was already answered.'
  if (SAYS_THE_FILE_IS_BAD.test(refusal)) return `That suggestion's file is missing or broken: ${proposalFileIn(refusal)}`

  return `Quartermaster could not do that: ${refusal.replace(/^quartermaster: /, '')}`
}

const dayOf = (moment: string): string => moment.slice(0, 10)

// A skill nobody used has no sightings to count, only the stretch that was watched.
export const seenBetween = (candidate: Candidate): string =>
  candidate.count === 0
    ? `Watched from ${dayOf(candidate.firstSeen)} to ${dayOf(candidate.lastSeen)}.`
    : `Seen ${candidate.count} times, first on ${dayOf(candidate.firstSeen)}, last on ${dayOf(candidate.lastSeen)}.`

export const statusLine = (records: Records, writeProblem?: string): string | undefined => {
  const waiting = waitingProposals(records).length
  const parts = [waiting === 0 ? '' : `Quartermaster: ${waiting} to review`, writeProblem ?? ''].filter(part => part !== '')

  return parts.length === 0 ? undefined : parts.join(' | ')
}

export type SkillRun = { command: string; args: string }

export const applySkillRun = (id: string): SkillRun => ({ command: 'quartermaster:apply', args: id })

export const draftSkillRun = (fingerprint: string): SkillRun => ({ command: 'quartermaster:resupply', args: fingerprint })

export const typedLine = (run: SkillRun): string => `/${run.command} ${run.args}`

const section = (title: string, lines: readonly string[]): string[] =>
  lines.length === 0 ? [] : [`${title}:`, ...lines.map(line => `- ${line}`)]

/** The inbox where nothing draws a pane: what waits, and how to answer in words. */
export const inboxText = (records: Records, candidates: readonly Candidate[]): string => {
  const waiting = waitingProposals(records).map(card => `${proposalLine(card)}. ${expectationLine(card)}`)
  const noticed = noticedCandidates(candidates, records).map(candidate => candidate.sentence)
  const lines = [
    ...section(WAITING_HEADING, waiting),
    ...section(NOTICED_HEADING, noticed),
  ]
  if (lines.length === 0) return 'Quartermaster has nothing for you.'
  const answer = waiting.length === 0 ? [] : ['', 'Answer by id, like "approve P-0001", "reject P-0001" or "later P-0001".']

  return [...lines, ...answer].join('\n')
}
