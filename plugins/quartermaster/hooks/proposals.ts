import { EVIDENCE_WINDOW_DAYS } from './detectors'

export const PROPOSAL_KINDS = [
  'skill',
  'skill-improvement',
  'rule',
  'permission',
  'setting',
  'plugin',
  'routing',
  'script',
  'retire',
  'upstream',
  'docs',
] as const

export const PROPOSAL_STATUSES = [
  'draft',
  'offered',
  'accepted',
  'declined',
  'handled',
  'applied',
  'loaded',
  'exercised',
  'useful',
  'rolled-back',
  'expired',
] as const

export const AUTHORITIES = ['quiet', 'ask'] as const

export type ProposalKind = (typeof PROPOSAL_KINDS)[number]
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]
export type Authority = (typeof AUTHORITIES)[number]

export type Proposal = {
  id: string
  kind: ProposalKind
  target: string
  status: ProposalStatus
  authority: Authority
  evidence: string[]
  expect: string
  baseline: number
  created: string
  body: string
  answered?: string
  reason?: string
}

/**
 * Every move the ladder allows. The status a person sets by hand in the file
 * is read as written; this table only binds the tools.
 */
export const STATUS_TRANSITIONS: Readonly<Record<ProposalStatus, readonly ProposalStatus[]>> = {
  draft: ['offered', 'accepted', 'declined', 'handled', 'expired'],
  offered: ['accepted', 'declined', 'handled', 'expired'],
  accepted: ['applied', 'declined', 'handled', 'expired'],
  applied: ['loaded', 'rolled-back'],
  loaded: ['exercised', 'rolled-back'],
  exercised: ['useful', 'rolled-back'],
  useful: ['rolled-back'],
  declined: [],
  handled: [],
  'rolled-back': [],
  expired: [],
}

export const canMove = (from: ProposalStatus, to: ProposalStatus): boolean => STATUS_TRANSITIONS[from].includes(to)

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * A proposal closed as already handled settles its evidence only while the events it came from are still counted,
 * which is the evidence window. A hand-written file with no answered day counts from the day it was made, so it
 * cannot settle for ever.
 */
export const isHandledPastItsWindow = (proposal: Pick<Proposal, 'answered' | 'created'> & { status: string }, now: number): boolean =>
  proposal.status === 'handled' && Date.parse(proposal.answered ?? proposal.created) <= now - EVIDENCE_WINDOW_DAYS * DAY_MS

const ID_DIGITS = 4

export const proposalId = (number: number): string => `P-${String(number).padStart(ID_DIGITS, '0')}`

export const changeIdFor = (id: string): string => id.replace(/^P-/, 'C-')

export const proposalNumber = (fileName: string): number | undefined => {
  const match = /^P-(\d+)\.md$/.exec(fileName)

  return match?.[1] === undefined ? undefined : Number(match[1])
}

export const nextProposalId = (fileNames: readonly string[]): string => {
  const numbers = fileNames.map(proposalNumber).filter((number): number is number => number !== undefined)

  return proposalId(Math.max(0, ...numbers) + 1)
}

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && values.some(member => member === value)

export const isProposalKind = (value: unknown): value is ProposalKind => isOneOf(PROPOSAL_KINDS, value)
export const isProposalStatus = (value: unknown): value is ProposalStatus => isOneOf(PROPOSAL_STATUSES, value)
export const isAuthority = (value: unknown): value is Authority => isOneOf(AUTHORITIES, value)

const UNSAFE_SCALAR = /[\n\r]/
const UNSAFE_LIST_ITEM = /[\n\r,[\]]/

const scalarProblem = (name: string, value: string): string[] =>
  value.trim() === '' || UNSAFE_SCALAR.test(value) ? [`${name} must be one non-empty line`] : []

const evidenceProblems = (evidence: readonly string[]): string[] =>
  evidence.some(item => item.trim() === '' || UNSAFE_LIST_ITEM.test(item))
    ? ['evidence items are fingerprints: no commas, brackets or line breaks']
    : []

const baselineProblem = (baseline: number): string[] =>
  Number.isFinite(baseline) && baseline >= 0 ? [] : ['baseline must be a count, zero or more']

/**
 * What is wrong with a proposal, in words a model can act on; empty when it
 * is valid.
 */
export const proposalProblems = (proposal: Proposal): string[] => [
  ...(/^P-\d{4,}$/.test(proposal.id) ? [] : ['id must look like P-0007']),
  ...scalarProblem('target', proposal.target),
  ...scalarProblem('expect', proposal.expect),
  ...evidenceProblems(proposal.evidence),
  ...baselineProblem(proposal.baseline),
  ...(/^\d{4}-\d{2}-\d{2}$/.test(proposal.created) ? [] : ['created must be a date like 2026-11-16']),
]

const answerLines = (proposal: Proposal): string[] => [
  ...(proposal.answered === undefined ? [] : [`answered: ${proposal.answered}`]),
  ...(proposal.reason === undefined ? [] : [`reason: ${proposal.reason.replace(/\s+/g, ' ').trim()}`]),
]

export const serializeProposal = (proposal: Proposal): string =>
  [
    '---',
    `id: ${proposal.id}`,
    `kind: ${proposal.kind}`,
    `target: ${proposal.target}`,
    `status: ${proposal.status}`,
    `authority: ${proposal.authority}`,
    `evidence: [${proposal.evidence.join(', ')}]`,
    `expect: ${proposal.expect}`,
    `baseline: ${proposal.baseline}`,
    `created: ${proposal.created}`,
    ...answerLines(proposal),
    '---',
    '',
    proposal.body.trim(),
    '',
  ].join('\n')

type Frontmatter = Record<string, string>

const frontmatterEntry = (line: string): [string, string] | undefined => {
  const separator = line.indexOf(':')

  return separator <= 0 ? undefined : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()]
}

const FENCE = '---'

const splitDocument = (text: string): { frontmatter: Frontmatter; body: string } | undefined => {
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  const closingFence = lines.indexOf(FENCE, 1)
  if (lines[0] !== FENCE || closingFence < 0) return undefined
  const entries = lines.slice(1, closingFence).map(frontmatterEntry)

  return {
    frontmatter: Object.fromEntries(entries.filter(entry => entry !== undefined)),
    body: lines.slice(closingFence + 1).join('\n').trim(),
  }
}

const inlineList = (value: string): string[] =>
  value
    .replaceAll('[', '')
    .replaceAll(']', '')
    .split(',')
    .map(item => item.trim())
    .filter(item => item !== '')

type ParsedProposal = { proposal: Proposal } | { problems: string[] }

const enumProblems = (frontmatter: Frontmatter): string[] => [
  ...(isProposalKind(frontmatter.kind) ? [] : [`kind must be one of ${PROPOSAL_KINDS.join(', ')}`]),
  ...(isProposalStatus(frontmatter.status) ? [] : [`status must be one of ${PROPOSAL_STATUSES.join(', ')}`]),
  ...(isAuthority(frontmatter.authority) ? [] : ['authority must be quiet or ask']),
]

const countFrom = (text: string): number => (text.trim() === '' ? Number.NaN : Number(text))

const answerOn = (frontmatter: Frontmatter): Pick<Proposal, 'answered' | 'reason'> => ({
  ...(frontmatter.answered === undefined ? {} : { answered: frontmatter.answered }),
  ...(frontmatter.reason === undefined ? {} : { reason: frontmatter.reason }),
})

const proposalFrom = (frontmatter: Frontmatter, body: string): Proposal | undefined => {
  const { id = '', kind, target = '', status, authority, evidence = '', expect = '', baseline = '', created = '' } =
    frontmatter
  if (!isProposalKind(kind) || !isProposalStatus(status) || !isAuthority(authority)) return undefined

  return { id, kind, target, status, authority, evidence: inlineList(evidence), expect, baseline: countFrom(baseline), created, body, ...answerOn(frontmatter) }
}

const validated = (proposal: Proposal): ParsedProposal => {
  const problems = proposalProblems(proposal)

  return problems.length === 0 ? { proposal } : { problems }
}

export const parseProposal = (text: string): ParsedProposal => {
  const document = splitDocument(text)
  if (document === undefined) return { problems: ['the file has no frontmatter between --- lines'] }
  const proposal = proposalFrom(document.frontmatter, document.body)

  return proposal === undefined ? { problems: enumProblems(document.frontmatter) } : validated(proposal)
}
