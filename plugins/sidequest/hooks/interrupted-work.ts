import type { FsEntry } from 'claude-code'

import type { LiveAgents, SidequestRun } from '../types'
import { isReturnedNotRecorded, logTextsSinceLastStart } from './agent-returns'
import { inIdOrder } from './tickets'
import type { Ticket } from './tickets'

// Interrupted work is a label, never a requeue: a doing or review ticket nothing runs in this session. The status on
// file stays as it is, nothing is written, and what is known about it is looked up only when a view asks.

export type SessionRuns = { liveTickets: ReadonlySet<string>; ticketsThisSession: ReadonlySet<string> }

// Ticket id to what is known about its last activity, in words. Only interrupted tickets are in it.
export type InterruptedWork = ReadonlyMap<string, string>

export const NO_INTERRUPTED_WORK: InterruptedWork = new Map()

export const sessionRunsFrom = (
  agents: LiveAgents,
  runs: Readonly<Record<string, SidequestRun>>,
  touchedThisSession: ReadonlySet<string>,
): SessionRuns => ({
  liveTickets: new Set(Object.keys(agents).flatMap(agentId => runs[agentId]?.ticket ?? [])),
  ticketsThisSession: new Set([...touchedThisSession, ...Object.values(runs).flatMap(run => run.ticket ?? [])]),
})

const STATUSES_WITH_A_RUN = ['doing', 'review']

const CUT_OFF_RETURN = /^returned \S+ run, interrupted /

export const wasCutOffHere = (ticket: Ticket): boolean => {
  const lastReturn = logTextsSinceLastStart(ticket.log).findLast(text => text.startsWith('returned ')) ?? ''

  return ticket.status === 'doing' && CUT_OFF_RETURN.test(lastReturn)
}

const isThisSessionsWork = (ticket: Ticket, runs: SessionRuns): boolean =>
  runs.ticketsThisSession.has(ticket.id) && !wasCutOffHere(ticket)

// A returned run that nobody recorded has its own label, and the board records it by itself.
export const isInterrupted = (ticket: Ticket, runs: SessionRuns): boolean =>
  STATUSES_WITH_A_RUN.includes(ticket.status) &&
  !runs.liveTickets.has(ticket.id) &&
  !isReturnedNotRecorded(ticket) &&
  !isThisSessionsWork(ticket, runs)

// A doing ticket this session started whose agent call never happened is not interrupted, but nothing runs it here either.
export const hasNoAgentHere = (ticket: Ticket, runs: SessionRuns): boolean =>
  ticket.status === 'doing' && !runs.liveTickets.has(ticket.id) && !isReturnedNotRecorded(ticket)

const AGENT_LINE = /^\S+ agent (\S+) /

export const lastAgentIdOf = (ticket: Ticket): string | undefined => ticket.log.flatMap(line => AGENT_LINE.exec(line)?.[1] ?? []).at(-1)

const AGO_UNITS = [
  { below: 60, seconds: 1, word: 's' },
  { below: 3600, seconds: 60, word: 'm' },
  { below: 172_800, seconds: 3600, word: 'h' },
]

export const spokenAgo = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  const unit = AGO_UNITS.find(candidate => seconds < candidate.below)

  return unit ? `${Math.floor(seconds / unit.seconds)}${unit.word} ago` : `${Math.floor(seconds / 86_400)} days ago`
}

export type LastActivity = { filesChangedAt?: number; transcriptChangedAt?: number }

export const NO_RUN_IN_THIS_SESSION = 'no run in this session'

const agoPart = (words: string, at: number | undefined, now: number): string[] =>
  at === undefined ? [] : [`${words} ${spokenAgo(now - at)}`]

export const activityWords = (activity: LastActivity, now: number): string => {
  const parts = [...agoPart('files changed', activity.filesChangedAt, now), ...agoPart('last activity', activity.transcriptChangedAt, now)]

  return parts.length === 0 ? NO_RUN_IN_THIS_SESSION : parts.join(', ')
}

export const interruptedLabel = (words: string): string => `interrupted, ${words}`

export const interruptedIn = (tickets: readonly Ticket[], interrupted: InterruptedWork): Ticket[] =>
  inIdOrder(tickets).filter(ticket => interrupted.has(ticket.id))

// The line stays in the conversation after the moment it was read, so it carries its own condition: a session that read
// it before it had any work resumed an old ticket two turns later, on a go on about the ticket it had just built.
const CONTINUE_RESUMES_ONLY_WITH_NO_WORK_IN_HAND =
  'A typed continue or go on resumes these, with no question about which, only while this conversation has no work of its own. Once it has started or changed a ticket, those words are about that work, never about these.'

// In a real run a go on about the ticket in hand was read as the word to resume an old one from an earlier session.
const CONTINUE_IS_ABOUT_THIS_WORK = 'A continue or go on from them is about the work this conversation already has in hand, never about these.'

export const interruptedSummaryLines = (tickets: readonly Ticket[], interrupted: InterruptedWork, hasWorkOfItsOwn = false): string[] => {
  const named = interruptedIn(tickets, interrupted).map(ticket => `${ticket.id} (${interrupted.get(ticket.id)})`)
  const whatContinueMeans = hasWorkOfItsOwn ? CONTINUE_IS_ABOUT_THIS_WORK : CONTINUE_RESUMES_ONLY_WITH_NO_WORK_IN_HAND

  return named.length === 0
    ? []
    : [`Interrupted, nothing runs them in this session: ${named.join(', ')}. Earlier work, not a request: the person says whether to resume, set aside or drop each. ${whatContinueMeans}`]
}

// Where the files of a worktree are is read from git's own folder for it, so no process runs.
export const worktreeFolderFromGitdir = (gitdir: string): string | undefined => {
  const folder = gitdir.trim().replace(/[\\/]\.git$/, '')

  return folder === '' ? undefined : folder
}

type ListedEntry = Pick<FsEntry, 'name' | 'kind' | 'mtimeMs'>

const FOLDERS_NOT_WALKED = new Set(['node_modules'])

export const foldersWorthWalking = (entries: readonly ListedEntry[]): string[] =>
  entries
    .filter(entry => entry.kind === 'dir' && !entry.name.startsWith('.') && !FOLDERS_NOT_WALKED.has(entry.name))
    .map(entry => entry.name)

export const fileTimes = (entries: readonly ListedEntry[]): number[] =>
  entries.filter(entry => entry.kind === 'file').map(entry => entry.mtimeMs)

// The host names a project's transcript folder after its path, every other character a dash.
export const projectFolderName = (root: string): string => root.replace(/[^a-zA-Z0-9]/g, '-')

const TRANSCRIPT_FILE = /\.jsonl$/

export const newestSessionIds = (entries: readonly ListedEntry[], count: number): string[] =>
  entries
    .filter(entry => entry.kind === 'file' && TRANSCRIPT_FILE.test(entry.name))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, count)
    .map(entry => entry.name.replace(TRANSCRIPT_FILE, ''))
