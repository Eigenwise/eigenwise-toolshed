import type { EngineInterface } from 'claude-code'

import { boardLocation } from './board-session'
import { branchNameIn, finishBranchToken } from './earlier-run'
import { branchesToCompare, overlapsFrom, reportedChangedFiles, withoutIgnored } from './leftover-conflicts'
import type { BranchOverlap } from './leftover-conflicts'
import { baseBranchOf, git } from './register-interrupted'
import { linesOf, runBranchOf } from './resume-facts'
import { readBoard } from './store'
import type { Ticket } from './tickets'
import { textOf } from './tool-input'
import type { JsonRecord } from './tool-input'

// Kept in the module, never in state or a file: a reload forgets which pairs were said, and a pair may then be said
// once more.
const pairsSaid = new Set<string>()

export const conflictPairsSaid = (): ReadonlySet<string> => pairsSaid

export const rememberConflictPairs = (pairs: readonly string[]): void => {
  for (const pair of pairs) pairsSaid.add(pair)
}

// The three dots diff from where the branch left the base, so a merged branch changes nothing. What the repository
// marks generated is left out by git itself.
async function changedOnBranch($: EngineInterface, root: string, base: string, branch: string): Promise<string | undefined> {
  return git($, root, ['diff', '--name-only', `${base}...${branch}`, '--', '.', ':(exclude,attr:linguist-generated)'])
}

const ownBranchOf = (input: JsonRecord, ticket: Ticket): string | undefined => {
  const given = textOf(input, 'branch')

  return (given === undefined ? undefined : branchNameIn(given)) ?? runBranchOf(ticket)
}

type FinishingTicket = { root: string; input: JsonRecord; ticket: Ticket; base: string; ownBranch: string | undefined }

async function filesOfFinishingTicket($: EngineInterface, finishing: FinishingTicket): Promise<string[]> {
  const reported = reportedChangedFiles(finishing.input.changedFiles, finishing.ticket)
  if (reported.length > 0 || finishing.ownBranch === undefined) return reported

  return linesOf(await changedOnBranch($, finishing.root, finishing.base, finishing.ownBranch))
}

async function ignoredAmong($: EngineInterface, root: string, overlaps: readonly BranchOverlap[]): Promise<string | undefined> {
  const paths = [...new Set(overlaps.flatMap(overlap => overlap.sharedFiles))]

  return paths.length === 0 ? undefined : git($, root, ['check-ignore', '--no-index', '--', ...paths])
}

// One git process, and only when a finish carries a value that could be a branch: the name is handed on only when a
// local branch of that name exists.
export async function existingBranchIn($: EngineInterface, root: string, given: string): Promise<string | undefined> {
  const name = finishBranchToken(given)
  if (name === undefined) return undefined
  const found = await git($, root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])

  return found === undefined ? undefined : name
}

export async function existingBranchForFinish($: EngineInterface, input: JsonRecord): Promise<string | undefined> {
  const given = textOf(input, 'branch')

  return given === undefined || finishBranchToken(given) === undefined ? undefined : existingBranchIn($, (await boardLocation($)).root, given)
}

// Git runs only here, and only when another open ticket has a branch: one read-only diff per such ticket, never a
// fetch. A board where no other open ticket has a branch starts no process.
export async function branchOverlapsForFinish($: EngineInterface, input: JsonRecord): Promise<BranchOverlap[]> {
  const location = await boardLocation($)
  const files = await readBoard($, location)
  const ticket = files.tickets.find(one => one.id === textOf(input, 'id'))
  if (ticket === undefined) return []
  const finishing = { root: location.root, input, ticket, base: baseBranchOf(ticket, files), ownBranch: ownBranchOf(input, ticket) }
  const branches = branchesToCompare(files.tickets, ticket, finishing.base, finishing.ownBranch)
  if (branches.length === 0) return []
  const reported = await filesOfFinishingTicket($, finishing)
  if (reported.length === 0) return []
  const changed = await Promise.all(branches.map(branch => changedOnBranch($, location.root, finishing.base, branch.branch)))
  const overlaps = overlapsFrom(branches, changed, reported)

  return withoutIgnored(overlaps, await ignoredAmong($, location.root, overlaps))
}
