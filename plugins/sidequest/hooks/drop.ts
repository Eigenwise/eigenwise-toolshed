import { isRecord } from './board-config'
import { runBranchOf } from './resume-facts'
import type { Ticket } from './tickets'
import { isTextList, textOf } from './tool-input'
import type { JsonRecord } from './tool-input'

// Drop takes a ticket off the board's open work for good, until a move brings it back. What its run left behind goes
// only when the worktrees script calls it safe: one verdict for the tidy skill and for drop, never a second one.

export const DROPPED = 'dropped'

const STATUSES_WITH_A_RUN = ['doing', 'review']

const NOT_OPEN = ['done', 'parked', DROPPED]

export type RunLeftovers = { ticketId: string; branch: string }

// The branch the ticket was filed on, or the one checked out now, is the person's own and never a run's leftover.
export const leftoversOf = (ticket: Ticket, checkedOutBranch: string | undefined): RunLeftovers | undefined => {
  const branch = runBranchOf(ticket)
  const isPersonsBranch = branch === ticket.branch || branch === checkedOutBranch

  return branch === undefined || isPersonsBranch ? undefined : { ticketId: ticket.id, branch }
}

// A run in the checked-out branch left nothing of its own. One on the ticket's own branch elsewhere did, under a
// name someone chose, so it is said and not removed.
export const noLeftoversNote = (ticket: Ticket, checkedOutBranch: string | undefined): string => {
  const runBranch = runBranchOf(ticket)
  const isOnItsOwnBranchElsewhere = runBranch !== undefined && runBranch === ticket.branch && runBranch !== checkedOutBranch

  return isOnItsOwnBranchElsewhere
    ? `${ticket.id} keeps its branch ${runBranch} and any worktree on it: it is not a host-named branch, so the tidy skill shows it before anything is removed.`
    : `${ticket.id} had no branch or worktree of its own.`
}

// Seen in a real run: the person did not know what Set aside and Drop would do. Said before the press, per ticket, the
// way drop and a move to parked really behave. Without the checked-out branch, a run branch reads as an agent's own,
// which drop still removes only when the worktrees script calls it safe.
export const SET_ASIDE_WORDS = 'Set aside: stays on the board and nothing starts it until you say so. Its files, branch and worktree stay as they are.'

const whatDropKeeps = (runBranch: string | undefined, ticketBranch: string | undefined): string => {
  if (runBranch === undefined) return 'It has no worktree or branch of its own, so nothing on disk changes.'
  if (runBranch === ticketBranch) return `Its branch ${runBranch} is kept with its files.`

  return `The agent's worktree and branch ${runBranch} go only if nothing in them exists nowhere else; otherwise they are kept.`
}

export const dropWordsFor = (ticket: Ticket): string => `Drop: off the board, never offered again. ${whatDropKeeps(runBranchOf(ticket), ticket.branch)}`

// What a person reads after pressing Drop: no tidy skill, no host-named branch.
export const noLeftoversWordsForThePerson = (ticket: Ticket, checkedOutBranch: string | undefined): string => {
  const runBranch = runBranchOf(ticket)
  const isOnItsOwnBranchElsewhere = runBranch !== undefined && runBranch === ticket.branch && runBranch !== checkedOutBranch

  return isOnItsOwnBranchElsewhere
    ? `${ticket.id} keeps its branch ${runBranch}: someone named it, so it is never removed without asking.`
    : `${ticket.id} had no branch or worktree of its own.`
}

const idList = (tickets: readonly Ticket[]): string => tickets.map(ticket => ticket.id).join(', ')

const ONE_OR_MANY = {
  one: { verb: 'is', their: 'its', they: 'it' },
  many: { verb: 'are', their: 'their', they: 'they' },
}

const openTicketsBlockedBy = (dropped: Ticket, tickets: readonly Ticket[]): Ticket[] =>
  tickets.filter(ticket => ticket.blockedBy.includes(dropped.id) && !NOT_OPEN.includes(ticket.status))

// The model's note says to patch blockedBy; the person who pressed Drop is told what that means for them.
export const blockedByDroppedWordsForThePerson = (dropped: Ticket, tickets: readonly Ticket[]): string[] => {
  const blocked = openTicketsBlockedBy(dropped, tickets)
  if (blocked.length === 0) return []
  const isOne = blocked.length === 1

  return [`${idList(blocked)} ${isOne ? 'was' : 'were'} waiting on ${dropped.id} and ${isOne ? 'is' : 'are'} now stuck. Tell the session if ${isOne ? 'it' : 'they'} should go on without it.`]
}

export const blockedByDroppedNote = (dropped: Ticket, tickets: readonly Ticket[]): string[] => {
  const blocked = openTicketsBlockedBy(dropped, tickets)
  if (blocked.length === 0) return []
  const words = blocked.length === 1 ? ONE_OR_MANY.one : ONE_OR_MANY.many

  return [`${idList(blocked)} ${words.verb} blocked by ${dropped.id}, which is now dropped: patch ${words.their} blockedBy if ${words.they} should go on without it.`]
}

// Setting aside keeps everything a run made, and the person should not have to ask where it went.
export const setAsideNote = (before: Ticket, status: string, checkedOutBranch: string | undefined): string[] => {
  if (status !== 'parked' || !STATUSES_WITH_A_RUN.includes(before.status)) return []
  const leftovers = leftoversOf(before, checkedOutBranch)
  const branch = leftovers === undefined ? 'its branch' : `its branch ${leftovers.branch}`

  return [`${before.id} is set aside: ${branch} and its worktree are kept.`]
}

export const droppedBlockerIds = (ticket: Ticket, tickets: readonly Ticket[]): string[] =>
  ticket.blockedBy.filter(id => tickets.some(other => other.id === id && other.status === DROPPED))

const recordsIn = (record: JsonRecord, key: string): JsonRecord[] => {
  const value = record[key]

  return Array.isArray(value) ? value.filter(isRecord) : []
}

const reasonsIn = (record: JsonRecord): string => {
  const reasons = record.reasons

  return isTextList(reasons) ? reasons.join(', ') : 'no reason given'
}

const hasSafeVerdict = (verdict: JsonRecord): boolean => verdict.verdict === 'safe'

const deletionOf = (removal: JsonRecord | undefined): JsonRecord => {
  const deletion = removal?.branchDeletion

  return isRecord(deletion) ? deletion : {}
}

const reasonOf = (record: JsonRecord | undefined, fallback: string): string => textOf(record ?? {}, 'reason') ?? fallback

const branchAfterWorktree = (removal: JsonRecord, branch: string): string => {
  const deletion = deletionOf(removal)

  return deletion.isDeleted === true ? ` and branch ${branch}` : `, kept branch ${branch}: ${reasonOf(deletion, 'git refused')}`
}

const worktreeWords = (removals: readonly JsonRecord[], branch: string) => (verdict: JsonRecord): string => {
  const path = textOf(verdict, 'path') ?? 'its worktree'
  if (!hasSafeVerdict(verdict)) return `kept its worktree ${path} and branch ${branch}: ${reasonsIn(verdict)}`
  const removal = removals.find(candidate => candidate.path === verdict.path)
  if (removal?.isRemoved !== true) return `kept its worktree ${path}: git refused, ${reasonOf(removal, 'no reason given')}`

  return `removed its worktree ${path}${branchAfterWorktree(removal, branch)}`
}

const branchWords = (removals: readonly JsonRecord[]) => (verdict: JsonRecord): string => {
  const branch = textOf(verdict, 'branch') ?? 'its branch'
  if (!hasSafeVerdict(verdict)) return `kept branch ${branch}: ${reasonsIn(verdict)}`
  const removal = removals.find(candidate => candidate.branch === branch)

  return removal?.isDeleted === true ? `removed branch ${branch}` : `kept branch ${branch}: ${reasonOf(removal, 'git refused')}`
}

const parsedReport = (output: string | undefined): JsonRecord | undefined => {
  try {
    const parsed: unknown = JSON.parse(output ?? '')

    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const leftoverPhrases = (report: JsonRecord, branch: string): string[] => [
  ...recordsIn(report, 'worktrees').map(worktreeWords(recordsIn(report, 'removals'), branch)),
  ...recordsIn(report, 'branches').map(branchWords(recordsIn(report, 'branchRemovals'))),
]

// What the worktrees script printed for one dropped run, in one line. Anything it did not answer plainly keeps both.
export const leftoversWords = (leftovers: RunLeftovers, output: string | undefined): string => {
  const report = parsedReport(output)
  if (report === undefined) return `${leftovers.ticketId}: its worktree and branch ${leftovers.branch} are kept, the worktree check did not answer.`
  const phrases = leftoverPhrases(report, leftovers.branch)
  if (phrases.length === 0) return `${leftovers.ticketId}: its branch ${leftovers.branch} is already gone, so nothing was left to remove.`

  return `${leftovers.ticketId}: ${phrases.join('; ')}.`
}
