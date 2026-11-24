import { fingerprintOf } from './detectors'
import {
  STATUS_TRANSITIONS,
  canMove,
  changeIdFor,
  isAuthority,
  isProposalKind,
  isProposalStatus,
  nextProposalId,
  proposalProblems,
  serializeProposal,
} from './proposals'
import type { Proposal, ProposalStatus } from './proposals'
import { rejectedFingerprints } from './rejections'
import {
  addRejections,
  applyRollback,
  hasChangeRecord,
  proposalFileNames,
  readChange,
  readProposal,
  readProposals,
  readRejections,
  recordImpression,
  recordWrittenFiles,
  snapshotChange,
  writeProposal,
} from './store'
import type { FileSystem, RollbackOutcome } from './store'
import { numberOr, stringField, stringListField, stringListOr, stringOr } from './tool-input'
import { counted } from './evidence'
import type { ToolInput } from './tool-input'

export type Workspace = { files: FileSystem; cwd: string; impressionsPath: string; now: number }

export type ToolAnswer = { deny: string } | { text: string }

const refuse = (text: string): ToolAnswer => ({ deny: `quartermaster: ${text}` })

const answer = (text: string): ToolAnswer => ({ text })

const today = (workspace: Workspace): string => new Date(workspace.now).toISOString().slice(0, 10)

const proposalFingerprints = (proposal: Pick<Proposal, 'kind' | 'target' | 'evidence'>): string[] => [
  fingerprintOf(proposal.kind, proposal.target),
  ...proposal.evidence,
]

const loadProposal = async (workspace: Workspace, id: string | undefined): Promise<Proposal | string> => {
  if (id === undefined) return 'id is required, like P-0007'
  const parsed = await readProposal(workspace.files, workspace.cwd, id)
  if (parsed === undefined) return `there is no proposal ${id}`

  return 'proposal' in parsed ? parsed.proposal : `${id} does not parse: ${parsed.problems.join('; ')}`
}

const moveProblem = (proposal: Proposal, to: ProposalStatus): string | undefined =>
  canMove(proposal.status, to)
    ? undefined
    : `${proposal.id} is ${proposal.status} and cannot become ${to}; from ${proposal.status} it can become ${STATUS_TRANSITIONS[proposal.status].join(', ') || 'nothing'}`

const saved = async (workspace: Workspace, proposal: Proposal, what: string): Promise<ToolAnswer> => {
  const problems = proposalProblems(proposal)
  if (problems.length > 0) return refuse(problems.join('; '))
  await writeProposal(workspace.files, workspace.cwd, proposal)

  return answer(`${proposal.id} ${what}, status ${proposal.status}.`)
}

const editedFields = (proposal: Proposal, input: ToolInput): Proposal => ({
  ...proposal,
  target: stringOr(input, 'target', proposal.target),
  expect: stringOr(input, 'expect', proposal.expect),
  baseline: numberOr(input, 'baseline', proposal.baseline),
  evidence: stringListOr(input, 'evidence', proposal.evidence),
  body: stringOr(input, 'body', proposal.body),
})

const draftFrom = (input: ToolInput, id: string, created: string): Proposal | string => {
  const kind = stringField(input, 'kind')
  const authority = stringOr(input, 'authority', 'ask')
  if (!isProposalKind(kind)) return 'kind is required and must be one of the listed kinds'
  if (!isAuthority(authority)) return 'authority must be quiet or ask'
  const blank: Proposal = {
    id,
    kind,
    target: '',
    status: 'draft',
    authority,
    evidence: [],
    expect: '',
    baseline: Number.NaN,
    created,
    body: '',
  }

  return editedFields(blank, input)
}

const rejectedAmong = async (workspace: Workspace, proposal: Proposal): Promise<string[]> => {
  const rejected = rejectedFingerprints(await readRejections(workspace.files, workspace.cwd))

  return proposalFingerprints(proposal).filter(fingerprint => rejected.has(fingerprint))
}

const create = async (input: ToolInput, workspace: Workspace): Promise<ToolAnswer> => {
  const id = nextProposalId(await proposalFileNames(workspace.files, workspace.cwd))
  const draft = draftFrom(input, id, today(workspace))
  if (typeof draft === 'string') return refuse(draft)
  const rejected = await rejectedAmong(workspace, draft)
  if (rejected.length > 0) return refuse(`the human already rejected ${rejected.join(', ')}; see rejected.md`)

  return saved(workspace, draft, 'created')
}

/** These moves carry a contract (a reason kept in rejected.md, restored files), so update cannot make them. */
const OPERATION_FOR_STATUS: Partial<Record<ProposalStatus, string>> = {
  accepted: 'decide',
  declined: 'decide',
  'rolled-back': 'rollback',
}

const statusChangeProblem = (proposal: Proposal, status: unknown): string | undefined => {
  if (status === undefined) return undefined
  if (!isProposalStatus(status)) return 'status must be one of the listed statuses'
  const operation = OPERATION_FOR_STATUS[status]

  return operation === undefined ? moveProblem(proposal, status) : `use operation: ${operation} to make ${proposal.id} ${status}`
}

const update = async (input: ToolInput, workspace: Workspace): Promise<ToolAnswer> => {
  const proposal = await loadProposal(workspace, stringField(input, 'id'))
  if (typeof proposal === 'string') return refuse(proposal)
  const status = stringField(input, 'status')
  const problem = statusChangeProblem(proposal, status)
  if (problem !== undefined) return refuse(problem)
  const next = editedFields(proposal, input)
  if (status === 'applied') await recordWrittenFiles(workspace.files, workspace.cwd, proposal.id)

  return saved(workspace, isProposalStatus(status) ? { ...next, status } : next, 'updated')
}

const approve = async (proposal: Proposal, workspace: Workspace): Promise<ToolAnswer> => {
  const problem = moveProblem(proposal, 'accepted')

  return problem === undefined ? saved(workspace, { ...proposal, status: 'accepted' }, 'approved') : refuse(problem)
}

const reject = async (proposal: Proposal, reason: string | undefined, workspace: Workspace): Promise<ToolAnswer> => {
  const problem = reason?.trim() ? moveProblem(proposal, 'declined') : 'a rejection needs the reason the human gave'
  if (problem !== undefined) return refuse(problem)
  const date = today(workspace)
  const rejections = proposalFingerprints(proposal).map(fingerprint => ({ fingerprint, reason: reason ?? '', date }))
  await addRejections(workspace.files, workspace.cwd, rejections)

  return saved(workspace, { ...proposal, status: 'declined' }, 'rejected and kept in rejected.md')
}

const later = async (proposal: Proposal, workspace: Workspace): Promise<ToolAnswer> => {
  const at = new Date(workspace.now).toISOString()
  for (const fingerprint of proposalFingerprints(proposal)) {
    await recordImpression(workspace.files, workspace.cwd, workspace.impressionsPath, { at, fingerprint, kind: 'not-now' })
  }

  return answer(`${proposal.id} stays ${proposal.status}; asked again later.`)
}

const decide = async (input: ToolInput, workspace: Workspace): Promise<ToolAnswer> => {
  const proposal = await loadProposal(workspace, stringField(input, 'id'))
  if (typeof proposal === 'string') return refuse(proposal)
  const decision = stringField(input, 'decision')
  if (decision === 'approve') return approve(proposal, workspace)
  if (decision === 'reject') return reject(proposal, stringField(input, 'reason'), workspace)

  return decision === 'later' ? later(proposal, workspace) : refuse('decision must be approve, reject or later')
}

const changeProblem = (proposal: Proposal, paths: readonly string[]): string | undefined => {
  if (proposal.status !== 'accepted') return `${proposal.id} is ${proposal.status}; only an accepted proposal is applied`

  return paths.length === 0 ? 'files must list every file the change will touch' : undefined
}

const recordChange = async (input: ToolInput, workspace: Workspace): Promise<ToolAnswer> => {
  const proposal = await loadProposal(workspace, stringField(input, 'id'))
  if (typeof proposal === 'string') return refuse(proposal)
  const paths = stringListField(input, 'files') ?? []
  const problem = changeProblem(proposal, paths)
  if (problem !== undefined) return refuse(problem)
  if (await hasChangeRecord(workspace.files, workspace.cwd, proposal.id)) {
    return refuse(
      `${changeIdFor(proposal.id)} is already recorded for ${proposal.id}; recording again would save the edited files over the originals`,
    )
  }
  const created = new Date(workspace.now).toISOString()
  const record = await snapshotChange(workspace.files, workspace.cwd, proposal.id, paths, created)

  return answer(
    `${record.id} saved ${counted(paths.length, 'file')} as they are now. Make the change, then update ${proposal.id} to applied.`,
  )
}

const restoredLine = (restored: readonly string[]): string => (restored.length === 0 ? '' : ` (${restored.join(', ')})`)

const deletionLine = (toDelete: readonly string[]): string =>
  toDelete.length === 0 ? '' : ` Delete these files the change created: ${toDelete.join(', ')}.`

const restoredSummary = (outcome: RollbackOutcome): string =>
  `${counted(outcome.restored.length, 'file')} restored${restoredLine(outcome.restored)}.${deletionLine(outcome.toDelete)}`

const rollbackAnswer = (proposal: Proposal, outcome: RollbackOutcome): string =>
  outcome.leftAlone.length === 0
    ? `${proposal.id} rolled back, ${restoredSummary(outcome)}`
    : [
        `${proposal.id} is only partly rolled back and stays ${proposal.status}. ${restoredSummary(outcome)}`,
        `Left alone, ${counted(outcome.leftAlone.length, 'file')}:`,
        ...outcome.leftAlone,
      ].join('\n\n')

const rollBack = async (proposal: Proposal, workspace: Workspace): Promise<ToolAnswer> => {
  const record = await readChange(workspace.files, workspace.cwd, proposal.id)
  if (record === undefined) return refuse(`${proposal.id} has no change record to roll back`)
  const outcome = await applyRollback(workspace.files, workspace.cwd, record)
  if (outcome.leftAlone.length === 0) await writeProposal(workspace.files, workspace.cwd, { ...proposal, status: 'rolled-back' })

  return answer(rollbackAnswer(proposal, outcome))
}

const rollback = async (input: ToolInput, workspace: Workspace): Promise<ToolAnswer> => {
  const proposal = await loadProposal(workspace, stringField(input, 'id'))
  if (typeof proposal === 'string') return refuse(proposal)
  const problem = moveProblem(proposal, 'rolled-back')

  return problem === undefined ? rollBack(proposal, workspace) : refuse(problem)
}

const show = async (id: string, workspace: Workspace): Promise<ToolAnswer> => {
  const proposal = await loadProposal(workspace, id)

  return typeof proposal === 'string' ? refuse(proposal) : answer(serializeProposal(proposal))
}

const list = async (input: ToolInput, workspace: Workspace): Promise<ToolAnswer> => {
  const id = stringField(input, 'id')
  if (id !== undefined) return show(id, workspace)
  const status = stringField(input, 'status')
  const stored = await readProposals(workspace.files, workspace.cwd)
  const shown = stored.proposals.filter(proposal => status === undefined || proposal.status === status)
  const lines = shown.map(proposal => `${proposal.id} ${proposal.status} ${proposal.kind}: ${proposal.target}`)

  const unreadable = stored.unreadable.map(entry => `${entry.file} does not parse: ${entry.problems.join('; ')}`)
  const text = [...lines, ...unreadable].join('\n')

  return answer(text === '' ? 'No proposals.' : text)
}

const OPERATIONS: Readonly<Record<string, (input: ToolInput, workspace: Workspace) => Promise<ToolAnswer>>> = {
  create,
  update,
  decide,
  'record-change': recordChange,
  rollback,
  list,
}

export const runProposalOperation = async (input: ToolInput, workspace: Workspace): Promise<ToolAnswer> => {
  const operation = OPERATIONS[stringField(input, 'operation') ?? '']

  return operation === undefined
    ? refuse(`operation must be one of ${Object.keys(OPERATIONS).join(', ')}`)
    : operation(input, workspace)
}
