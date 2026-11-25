import { logTextsSinceLastStart } from './agent-returns'
import { ticketHandle } from './branch-and-issue'
import { linesOf, runBranchOf } from './resume-facts'
import type { Ticket } from './tickets'
import { isTextList } from './tool-input'

// Leftover tickets show to the person on the pane. The model hears about one only for a real conflict, inside an
// answer a tool already gives, once per pair of tickets, as a fact. If it reads as a reason to stop, cheap models stop
// and ask, and the line has failed (the story's D-13).

export type BranchToCompare = { ticketId: string; branch: string }

export type BranchOverlap = BranchToCompare & { sharedFiles: string[] }

export type ConflictNotice = { line: string; pairs: string[] }

export const NO_CONFLICT_NOTICE: ConflictNotice = { line: '', pairs: [] }

export const NO_PAIRS_SAID: ReadonlySet<string> = new Set()

const CARRY_ON = 'carry on unless they really conflict'
const MOST_TICKETS_NAMED = 2
const MOST_FILES_NAMED = 2

export const ticketPair = (one: string, other: string): string => [one, other].sort().join(' and ')

const CLOSED_STATUSES = ['done', 'dropped']

const isOtherOpenTicket = (ticket: Ticket, subjectId: string): boolean => ticket.id !== subjectId && !CLOSED_STATUSES.includes(ticket.status)

// A ticket's run branch is where its agent committed; without one, the branch the ticket names.
const branchOfOpenTicket = (ticket: Ticket): string | undefined => runBranchOf(ticket) ?? ticket.branch

const branchToCompare = (ticket: Ticket, base: string, ownBranch: string | undefined): BranchToCompare[] => {
  const branch = branchOfOpenTicket(ticket)

  return branch === undefined || branch === base || branch === ownBranch ? [] : [{ ticketId: ticket.id, branch }]
}

export const branchesToCompare = (tickets: readonly Ticket[], subject: Ticket, base: string, ownBranch: string | undefined): BranchToCompare[] =>
  tickets.filter(ticket => isOtherOpenTicket(ticket, subject.id)).flatMap(ticket => branchToCompare(ticket, base, ownBranch))

const NOTHING_REPORTED = /^(?:not recorded|none|nothing|n\/a)\b|^-$/i

const cleanPath = (path: string): string =>
  path.replace(/[`*]/g, '').replace(/^\s*-\s+/, '').trim().replace(/\\/g, '/').replace(/^\.\//, '')

const reportedFilesIn = (paths: readonly string[]): string[] => paths.map(cleanPath).filter(path => path !== '')

const reportedFilesInText = (text: string | undefined): string[] =>
  text === undefined || NOTHING_REPORTED.test(text.trim()) ? [] : reportedFilesIn(text.split(/[,\n]/))

const CHANGED_LINE = 'changed '

const loggedChangedFiles = (ticket: Ticket): string | undefined =>
  logTextsSinceLastStart(ticket.log)
    .findLast(text => text.startsWith(CHANGED_LINE))
    ?.slice(CHANGED_LINE.length)

// What finish was given wins; else what the board logged when the agent returned.
export const reportedChangedFiles = (given: unknown, ticket: Ticket): string[] => {
  if (isTextList(given)) return reportedFilesIn(given)

  return reportedFilesInText(typeof given === 'string' ? given : loggedChangedFiles(ticket))
}

const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'deno.lock',
  'Cargo.lock',
  'Gemfile.lock',
  'composer.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'pdm.lock',
  'go.sum',
  'flake.lock',
  'mix.lock',
  'pubspec.lock',
  'Podfile.lock',
  'Package.resolved',
  'packages.lock.json',
  'gradle.lockfile',
])

const fileNameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

export const isLockfile = (path: string): boolean => LOCKFILE_NAMES.has(fileNameOf(path))

// An agent may report a path from inside its worktree, so a reported path that ends with the repository path counts.
const isSamePath = (reported: string, repositoryPath: string): boolean =>
  reported === repositoryPath || reported.endsWith(`/${repositoryPath}`)

export const sharedFilesOf = (reported: readonly string[], changedOnBranch: string | undefined): string[] =>
  linesOf(changedOnBranch).filter(path => !isLockfile(path) && reported.some(one => isSamePath(one, path)))

export const overlapsFrom = (branches: readonly BranchToCompare[], changedOnBranches: readonly (string | undefined)[], reported: readonly string[]): BranchOverlap[] =>
  branches
    .map((branch, index) => ({ ...branch, sharedFiles: sharedFilesOf(reported, changedOnBranches[index]) }))
    .filter(overlap => overlap.sharedFiles.length > 0)

export const withoutIgnored = (overlaps: readonly BranchOverlap[], ignoredText: string | undefined): BranchOverlap[] => {
  const ignored = new Set(linesOf(ignoredText))

  return overlaps
    .map(overlap => ({ ...overlap, sharedFiles: overlap.sharedFiles.filter(path => !ignored.has(path)) }))
    .filter(overlap => overlap.sharedFiles.length > 0)
}

type ConflictPart = { pair: string; words: string }


const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

const fileWords = (files: readonly string[]): string => {
  const named = files.slice(0, MOST_FILES_NAMED)
  const more = files.length - named.length

  return more > 0 ? `${named.join(', ')} and ${plural(more, 'more file')}` : named.join(' and ')
}

const moreTicketsWords = (count: number): string[] =>
  count === 0 ? [] : [`${plural(count, 'more open ticket')} ${count === 1 ? 'does' : 'do'} the same`]

const noticeOf = (parts: readonly ConflictPart[], said: ReadonlySet<string>): ConflictNotice => {
  const unsaid = parts.filter(part => !said.has(part.pair))
  if (unsaid.length === 0) return NO_CONFLICT_NOTICE
  const sentences = [...new Set(unsaid.map(part => part.words))]
  const named = sentences.slice(0, MOST_TICKETS_NAMED)
  const facts = [...named, ...moreTicketsWords(sentences.length - named.length)]

  return { line: `${facts.join('; ')}; ${CARRY_ON}.`, pairs: unsaid.map(part => part.pair) }
}

const sameFilesPart = (subject: Ticket, overlap: BranchOverlap, tickets: readonly Ticket[]): ConflictPart[] => {
  const other = tickets.find(ticket => ticket.id === overlap.ticketId)

  return other === undefined
    ? []
    : [{ pair: ticketPair(subject.id, other.id), words: `${ticketHandle(other)} also changes ${fileWords(overlap.sharedFiles)} on its branch ${overlap.branch}, which is not merged yet` }]
}

export const sameFilesNotice = (subject: Ticket, overlaps: readonly BranchOverlap[], tickets: readonly Ticket[], said: ReadonlySet<string>): ConflictNotice =>
  noticeOf(overlaps.flatMap(overlap => sameFilesPart(subject, overlap, tickets)), said)

// Tickets of one story share a key by design: that is one plan, not a leftover.
const isSamePlan = (ticket: Ticket, subject: Ticket): boolean => subject.story !== undefined && ticket.story === subject.story

const sharesTrackerKey = (ticket: Ticket, subject: Ticket): boolean =>
  subject.issue !== undefined && ticket.issue === subject.issue && isOtherOpenTicket(ticket, subject.id) && !isSamePlan(ticket, subject)

const sameKeyParts = (subject: Ticket, others: readonly Ticket[]): ConflictPart[] =>
  others
    .filter(ticket => sharesTrackerKey(ticket, subject))
    .map(ticket => ({ pair: ticketPair(subject.id, ticket.id), words: `${ticketHandle(ticket)} is open with the same tracker key` }))

export const noticeOnItsOwnLine = (notice: ConflictNotice): string => (notice.line === '' ? '' : `\n${notice.line}`)

export const sameKeyNotice = (subjects: readonly Ticket[], others: readonly Ticket[], said: ReadonlySet<string>): ConflictNotice =>
  noticeOf(subjects.flatMap(subject => sameKeyParts(subject, others)), said)
