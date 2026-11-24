import { atom, read } from 'claude-code'
import type { EngineInterface, FsEntry } from 'claude-code'

import { boardLocation } from './board-session'
import {
  activityWords,
  fileTimes,
  foldersWorthWalking,
  hasNoAgentHere,
  isInterrupted,
  lastAgentIdOf,
  newestSessionIds,
  NO_INTERRUPTED_WORK,
  projectFolderName,
  sessionRunsFrom,
  worktreeFolderFromGitdir,
} from './interrupted-work'
import type { InterruptedWork, LastActivity, SessionRuns } from './interrupted-work'
import { touchedThisSession } from './register-compaction'
import { remoteTipsOf, resumeFactsFrom, runBranchOf, worktreeOfBranch } from './resume-facts'
import type { ResumeFacts } from './resume-facts'
import { readConfigFolder, readOptionalText } from './store'
import type { BoardFiles, BoardLocation } from './store'
import type { Ticket } from './tickets'

// The host only follows a state name declared in the file that uses it, so this file names its own.
const agentRuns = atom({ plugin: 'sidequest', key: 'runs' } as const, {})
const liveAgents = atom({ plugin: 'sidequest', key: 'agents' } as const, {}, { shape: 'live-agents-2' })

// A large worktree costs at most this many listings; the newest file reached is what the words say.
const MOST_FOLDERS_WALKED = 60
// The run that left the work is nearly always one of the last few sessions of the project.
const SESSIONS_LOOKED_AT = 5

export async function sessionRunsOf($: EngineInterface): Promise<SessionRuns> {
  const [agents, runs] = await Promise.all([read($, liveAgents), read($, agentRuns)])

  return sessionRunsFrom(agents, runs, touchedThisSession())
}

export async function isAgentOfThisSessionOn($: EngineInterface, ticketId: string | undefined): Promise<boolean> {
  return ticketId !== undefined && (await sessionRunsOf($)).liveTickets.has(ticketId)
}

async function worktreeFolderOf($: EngineInterface, location: BoardLocation, agentId: string): Promise<string | undefined> {
  if (location.gitCommonDir === undefined) return undefined
  const gitdir = await readOptionalText($, `${location.gitCommonDir}/worktrees/agent-${agentId}/gitdir`)

  return gitdir === undefined ? undefined : worktreeFolderFromGitdir(gitdir)
}

type Listing = { folder: string; entries: FsEntry[] }

async function listFolder($: EngineInterface, folder: string): Promise<Listing> {
  return { folder, entries: await $.fs.list(folder).catch(() => []) }
}

const subfoldersOf = (listing: Listing): string[] => foldersWorthWalking(listing.entries).map(name => `${listing.folder}/${name}`)

async function newestFileChangeUnder($: EngineInterface, folder: string): Promise<number | undefined> {
  const times: number[] = []
  let waiting = [folder]
  let walked = 0
  while (waiting.length > 0 && walked < MOST_FOLDERS_WALKED) {
    const batch = waiting.slice(0, MOST_FOLDERS_WALKED - walked)
    walked += batch.length
    const listings = await Promise.all(batch.map(path => listFolder($, path)))
    times.push(...listings.flatMap(listing => fileTimes(listing.entries)))
    waiting = [...waiting.slice(batch.length), ...listings.flatMap(subfoldersOf)]
  }

  return times.length === 0 ? undefined : Math.max(...times)
}

async function filesChangedAt($: EngineInterface, location: BoardLocation, agentId: string): Promise<number | undefined> {
  const folder = await worktreeFolderOf($, location, agentId)

  return folder === undefined ? undefined : newestFileChangeUnder($, folder)
}

const transcriptPath = (projectFolder: string, sessionId: string, agentId: string): string =>
  `${projectFolder}/${sessionId}/subagents/agent-${agentId}.jsonl`

async function transcriptChangedAt($: EngineInterface, location: BoardLocation, agentId: string): Promise<number | undefined> {
  const configFolder = await readConfigFolder($)
  if (configFolder === undefined) return undefined
  const projectFolder = `${configFolder}/projects/${projectFolderName(location.root)}`
  const sessions = newestSessionIds(await $.fs.list(projectFolder).catch(() => []), SESSIONS_LOOKED_AT)
  const stats = await Promise.all(sessions.map(sessionId => $.fs.stat(transcriptPath(projectFolder, sessionId, agentId)).catch(() => undefined)))

  return stats.find(stat => stat !== undefined)?.mtimeMs
}

async function lastActivityOf($: EngineInterface, location: BoardLocation, ticket: Ticket): Promise<LastActivity> {
  const agentId = lastAgentIdOf(ticket)
  if (agentId === undefined) return {}
  const [filesChanged, transcriptChanged] = await Promise.all([
    filesChangedAt($, location, agentId).catch(() => undefined),
    transcriptChangedAt($, location, agentId).catch(() => undefined),
  ])

  return { filesChangedAt: filesChanged, transcriptChangedAt: transcriptChanged }
}

// Looked up only when a view is asked for or the pane redraws for another reason, never per tool call. A board with
// nothing interrupted costs two state reads and nothing else.
async function lastActivityWordsFor($: EngineInterface, interrupted: readonly Ticket[]): Promise<InterruptedWork> {
  if (interrupted.length === 0) return NO_INTERRUPTED_WORK
  const [location, now] = await Promise.all([boardLocation($), $.clock.now()])
  const activities = await Promise.all(interrupted.map(ticket => lastActivityOf($, location, ticket)))

  return new Map(interrupted.map((ticket, index) => [ticket.id, activityWords(activities[index] ?? {}, now)]))
}

export async function interruptedWorkOn($: EngineInterface, tickets: readonly Ticket[]): Promise<InterruptedWork> {
  const runs = await sessionRunsOf($)

  return lastActivityWordsFor($, tickets.filter(ticket => isInterrupted(ticket, runs)))
}

// Every doing ticket no agent of this session is on, the way the pane counts them. The ones this session started are the new part.
export async function workWithNoAgentHereOn($: EngineInterface, tickets: readonly Ticket[]): Promise<InterruptedWork> {
  const runs = await sessionRunsOf($)
  const unrun = tickets.filter(ticket => hasNoAgentHere(ticket, runs))

  return lastActivityWordsFor($, unrun)
}

// What git printed, or undefined when it failed or could not run.
export async function git($: EngineInterface, cwd: string, args: readonly string[]): Promise<string | undefined> {
  const answer = await $.process.run(['git', ...args], { cwd }).catch(() => undefined)

  return answer?.exitCode === 0 ? answer.stdout : undefined
}

// A remote tip that is not behind the local branch means someone else moved it since.
async function hasRemoteMoved($: EngineInterface, root: string, branch: string, refs: string | undefined): Promise<boolean> {
  const local = (await git($, root, ['rev-parse', branch]))?.trim()
  const otherTips = remoteTipsOf(refs, branch).filter(tip => tip !== local)
  const behindLocal = await Promise.all(otherTips.map(tip => git($, root, ['merge-base', '--is-ancestor', tip, branch])))

  return behindLocal.some(answer => answer === undefined)
}

async function uncommittedIn($: EngineInterface, worktree: string | undefined): Promise<string | undefined> {
  return worktree === undefined ? undefined : git($, worktree, ['status', '--porcelain'])
}

// A ticket whose branch is the run's own has nothing to compare the run against but the checkout.
export const baseBranchOf = (ticket: Ticket, files: BoardFiles): string => {
  const filedOn = ticket.branch === runBranchOf(ticket) ? undefined : ticket.branch

  return filedOn ?? files.checkedOutBranch ?? 'HEAD'
}

async function forkPointOf($: EngineInterface, root: string, base: string, branch: string): Promise<string | undefined> {
  const forkPoint = (await git($, root, ['merge-base', base, branch]))?.trim()

  return forkPoint === '' ? undefined : forkPoint
}

async function resumeFactsOf($: EngineInterface, location: BoardLocation, files: BoardFiles, ticket: Ticket): Promise<ResumeFacts | undefined> {
  const branch = runBranchOf(ticket)
  const base = baseBranchOf(ticket, files)
  const root = location.root
  const forkPoint = branch === undefined ? undefined : await forkPointOf($, root, base, branch)
  if (branch === undefined || forkPoint === undefined) return undefined
  const [commitLog, ownEmail, touchedByBranch, changedOnBase, worktrees, refs, inBase] = await Promise.all([
    git($, root, ['log', '--reverse', '--format=%h%x09%ce%x09%cn%x09%s', `${forkPoint}..${branch}`]),
    git($, root, ['config', 'user.email']),
    git($, root, ['diff', '--name-only', forkPoint, branch]),
    git($, root, ['diff', '--name-only', forkPoint, base]),
    git($, root, ['worktree', 'list', '--porcelain']),
    git($, root, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes']),
    git($, root, ['merge-base', '--is-ancestor', branch, base]),
  ])
  const worktree = worktreeOfBranch(worktrees, branch)
  const [uncommitted, remoteMoved] = await Promise.all([uncommittedIn($, worktree), hasRemoteMoved($, root, branch, refs)])
  const answers = { commitLog, ownEmail, touchedByBranch, changedOnBase, uncommitted, worktree, hasRemoteMoved: remoteMoved, isInBase: inBase !== undefined }

  return resumeFactsFrom(branch, base, answers)
}

// Only an interrupted ticket is looked at, so starting fresh work runs no process at all. The board is the one the
// start already read.
export async function resumeFactsForStart($: EngineInterface, location: BoardLocation, files: BoardFiles, ticket: Ticket | undefined): Promise<ResumeFacts | undefined> {
  if (ticket === undefined || !isInterrupted(ticket, await sessionRunsOf($))) return undefined

  return resumeFactsOf($, location, files, ticket)
}
