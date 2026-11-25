import { fingerprintOf } from '../detectors'
import { isHandledPastItsWindow } from '../proposals'
import type { Proposal } from '../proposals'
import type { QuartermasterCandidate, QuartermasterProposalCard, QuartermasterRecords } from '../../types'

export type ProposalCard = QuartermasterProposalCard
export type Records = QuartermasterRecords
export type Candidate = QuartermasterCandidate

const WAITING_STATUSES: readonly string[] = ['offered', 'draft']

export const isWaiting = (card: Pick<ProposalCard, 'status'>): boolean => WAITING_STATUSES.includes(card.status)

export const WAITING_HEADING = 'Waiting on you'
export const SET_ASIDE_HEADING = 'Set aside with Later'
export const NOTICED_HEADING = 'Noticed in this project'
export const NOTICED_HINT = 'Press one to have a fix drafted, or to stop hearing about it.'
export const NOTHING_TO_SHOW =
  'Nothing here. When something keeps going wrong or keeps being done by hand, it shows up here with a fix you can approve.'
export const WHAT_EACH_PRESS_DOES =
  'Draft a fix writes a proposal you approve before anything changes. Later: no reminder about it for a while. ' +
  'Ignore in this project: it is never brought up here again.'

export const WHAT_EACH_ANSWER_DOES =
  'Approve makes the change now, and it can be undone. Reject is remembered for this project. ' +
  'Already handled closes it without that, so it may come back if the same thing keeps happening. Later hides it for a few days.'
export const REASON_LABEL = 'Your reason (optional)'
export const REASON_HINT =
  'Type it in the field below. Enter keeps the words; Reject or Already handled sends them with your answer.'

export const EMPTY_RECORDS: Records = { proposals: [], rejected: [] }

export const proposalCard = (proposal: Proposal): ProposalCard => ({
  ...(proposal.answered === undefined ? {} : { answered: proposal.answered }),
  ...(proposal.reason === undefined ? {} : { reason: proposal.reason }),
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
  records.proposals.filter(isWaiting)

export const proposalFingerprint = (card: Pick<ProposalCard, 'kind' | 'target'>): string => fingerprintOf(card.kind, card.target)

const isSetAside = (records: Records, card: ProposalCard): boolean =>
  (records.setAsideForNow ?? []).includes(proposalFingerprint(card))

/** What is waiting and in sight: a proposal set aside with Later is not waiting until its wait is over. */
export const proposalsInSight = (records: Records): ProposalCard[] =>
  waitingProposals(records).filter(card => !isSetAside(records, card))

export const proposalsSetAside = (records: Records): ProposalCard[] =>
  waitingProposals(records).filter(card => isSetAside(records, card))

export const setAsideLine = (card: ProposalCard, records: Records): string => {
  const until = records.setAsideUntil?.[proposalFingerprint(card)]

  return `${proposalInWords(card)}: set aside${until === undefined ? ' for now' : ` until ${until}`}`
}

const fingerprintsOf = (card: ProposalCard): string[] => [proposalFingerprint(card), ...card.evidence]

const proposedFingerprints = (records: Records): Set<string> =>
  new Set([
    ...records.proposals.filter(card => card.status !== 'handled').flatMap(fingerprintsOf),
    ...(records.handledWithinWindow ?? []),
  ])

/** The fingerprints a proposal closed as already handled still settles: those whose window has not passed. */
export const handledWithinWindow = (cards: readonly ProposalCard[], now: number): string[] =>
  cards
    .filter(card => card.status === 'handled' && !isHandledPastItsWindow(card, now))
    .flatMap(fingerprintsOf)

// A repeated failure names no fix a person could approve, so it stays evidence for a resupply round and off the list.
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

// The status line is one row of the terminal beside other entries, and a proposal's target can be a whole command.
// The cut counts whole characters, so it never leaves half an emoji.
const STATUS_TITLE_MAX_LENGTH = 60

const cutForStatus = (title: string): string => {
  const characters = Array.from(title)

  return characters.length <= STATUS_TITLE_MAX_LENGTH
    ? title
    : `${characters.slice(0, STATUS_TITLE_MAX_LENGTH - 3).join('').trimEnd()}...`
}

const reviewStatus = ([first, ...others]: readonly ProposalCard[]): string => {
  if (first === undefined) return ''
  const title = cutForStatus(proposalInWords(first))
  const named = others.length === 0 ? title : `${title} and ${others.length} more`

  return `Quartermaster: ${others.length + 1} to review: ${named} (/quartermaster)`
}

export const statusLine = (records: Records, writeProblem?: string): string | undefined => {
  const parts = [reviewStatus(proposalsInSight(records)), writeProblem ?? ''].filter(part => part !== '')

  return parts.length === 0 ? undefined : parts.join(' | ')
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** What the open session is told after the person answered, so the agent hears why in their words. */
export const answerLine = (answer: 'rejected' | 'already handled', card: ProposalCard, reason: string): string =>
  `Quartermaster: the person answered "${oneLine(proposalInWords(card))}" (${card.id}) as ${answer}: ${oneLine(reason)}`

export type SkillRun = { command: string; args: string }

export const applySkillRun = (id: string): SkillRun => ({ command: 'quartermaster:apply', args: id })

export const draftSkillRun = (fingerprint: string): SkillRun => ({ command: 'quartermaster:resupply', args: fingerprint })

export const typedLine = (run: SkillRun): string => `/${run.command} ${run.args}`

const section = (title: string, lines: readonly string[]): string[] =>
  lines.length === 0 ? [] : [`${title}:`, ...lines.map(line => `- ${line}`)]

const FOLDER_SEPARATORS = /[\\/]+/

// Sessions work in worktrees under .claude/worktrees, and the project is the checkout that holds them.
const WORKTREES_FOLDER = /[\\/]\.claude[\\/]worktrees[\\/].*$/

export const UNNAMED_PROJECT = 'this folder'

export const projectNameOf = (folder: string): string =>
  folder.replace(WORKTREES_FOLDER, '').split(FOLDER_SEPARATORS).filter(part => part !== '').pop() ?? UNNAMED_PROJECT

const answerInThisChat = (exampleId: string): string =>
  `Answer in this chat, by id: say "approve ${exampleId}", "reject ${exampleId}", "already handled ${exampleId}" or "later ${exampleId}".`

/** The inbox where nothing draws a pane: what waits in which project, and how to answer in words. */
export const inboxText = (records: Records, candidates: readonly Candidate[], projectName: string): string => {
  const [firstCardInSight] = proposalsInSight(records)
  const waiting = proposalsInSight(records).map(card => `${proposalLine(card)}. ${expectationLine(card)}`)
  const setAside = proposalsSetAside(records).map(card => `${card.id} ${setAsideLine(card, records)}`)
  const noticed = noticedCandidates(candidates, records).map(candidate => candidate.sentence)
  const lines = [
    ...section(WAITING_HEADING, waiting),
    ...section(SET_ASIDE_HEADING, setAside),
    ...section(NOTICED_HEADING, noticed),
  ]
  if (lines.length === 0) return `Quartermaster has nothing for you in ${projectName}.`
  const answer = firstCardInSight === undefined ? [] : ['', answerInThisChat(firstCardInSight.id)]

  return [`Quartermaster inbox in ${projectName}:`, ...lines, ...answer].join('\n')
}
