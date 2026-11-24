import { earlierRunOf } from './earlier-run'
import { lastAgentIdOf } from './interrupted-work'
import type { Ticket } from './tickets'

// What the board can see about interrupted work at the moment it is resumed, from git alone. Each fact is only
// there when it is true, so a run that left nothing behind gets no section at all.

export type BranchCommit = { id: string; committerEmail: string; committerName: string; subject: string }

export type ResumeFacts = {
  branch: string
  base: string
  commits: BranchCommit[]
  worktree?: string
  uncommittedFiles: string[]
  changedOnBase: string[]
  lastCommitterIfSomeoneElse?: string
  hasRemoteMoved: boolean
  // The branch is an ancestor of the base: everything on it is merged already.
  isInBase?: boolean
}

// What git answered, each undefined when the command failed.
export type GitAnswers = {
  commitLog?: string
  ownEmail?: string
  touchedByBranch?: string
  changedOnBase?: string
  uncommitted?: string
  worktree?: string
  hasRemoteMoved: boolean
  isInBase?: boolean
}

// A worktree agent's branch carries its agent id, so an interrupted run that never reported a branch is still found.
export const runBranchOf = (ticket: Ticket): string | undefined => {
  const agentId = lastAgentIdOf(ticket)

  return earlierRunOf(ticket)?.branch ?? (agentId === undefined ? undefined : `worktree-agent-${agentId}`)
}

export const linesOf = (text: string | undefined): string[] =>
  (text ?? '')
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(line => line.trim() !== '')

const commitOf = (line: string): BranchCommit[] => {
  const [id, committerEmail, committerName, ...subject] = line.split('\t')

  return id === undefined || committerEmail === undefined || committerName === undefined ? [] : [{ id, committerEmail, committerName, subject: subject.join('\t') }]
}

export const commitsIn = (commitLog: string | undefined): BranchCommit[] => linesOf(commitLog).flatMap(commitOf)

// `git status --porcelain` puts two status letters and a space before each path.
export const uncommittedFilesIn = (status: string | undefined): string[] => linesOf(status).map(line => line.slice(3))

export const worktreeOfBranch = (porcelain: string | undefined, branch: string): string | undefined => {
  const blocks = (porcelain ?? '').split(/\r?\n\r?\n/)
  const block = blocks.find(candidate => candidate.split(/\r?\n/).includes(`branch refs/heads/${branch}`))

  return /^worktree (.+)$/m.exec(block ?? '')?.[1]?.trim()
}

const isRemoteRefOf = (name: string, branch: string): boolean => name.startsWith('refs/remotes/') && name.endsWith(`/${branch}`)

export const remoteTipsOf = (refs: string | undefined, branch: string): string[] =>
  linesOf(refs).flatMap(line => {
    const [name = '', tip = ''] = line.split(' ')

    return isRemoteRefOf(name, branch) && tip !== '' ? [tip] : []
  })

// With no git user to compare against, nobody is called someone else.
export const isOwnEmail = (email: string, ownEmail: string | undefined): boolean =>
  ownEmail === undefined || email.trim().toLowerCase() === ownEmail.trim().toLowerCase()

export const lastCommitterIfSomeoneElse = (commits: readonly BranchCommit[], ownEmail: string | undefined): string | undefined => {
  const last = commits.at(-1)

  return last === undefined || isOwnEmail(last.committerEmail, ownEmail) ? undefined : last.committerName
}

const inBoth = (left: readonly string[], right: readonly string[]): string[] => left.filter(path => right.includes(path))

export const resumeFactsFrom = (branch: string, base: string, answers: GitAnswers): ResumeFacts => {
  const commits = commitsIn(answers.commitLog)
  const someoneElse = lastCommitterIfSomeoneElse(commits, answers.ownEmail)

  return {
    branch,
    base,
    commits,
    ...(answers.worktree === undefined ? {} : { worktree: answers.worktree }),
    uncommittedFiles: uncommittedFilesIn(answers.uncommitted),
    changedOnBase: inBoth(linesOf(answers.touchedByBranch), linesOf(answers.changedOnBase)),
    ...(someoneElse === undefined ? {} : { lastCommitterIfSomeoneElse: someoneElse }),
    hasRemoteMoved: answers.hasRemoteMoved,
    ...(answers.isInBase ? { isInBase: true } : {}),
  }
}

const MOST_COMMITS_LISTED = 10

const commitLines = (facts: ResumeFacts): string[] => {
  if (facts.commits.length === 0) return []
  const listed = facts.commits.slice(0, MOST_COMMITS_LISTED).map(commit => `  - ${commit.id} ${commit.subject}`)
  const more = facts.commits.length - listed.length

  return [`- Commits already on branch ${facts.branch}, oldest first:`, ...listed, ...(more > 0 ? [`  - and ${more} more`] : [])]
}

const buildOnLine = (facts: ResumeFacts, earlierBranch: string | undefined): string[] =>
  facts.commits.length === 0 || earlierBranch === facts.branch
    ? []
    : [`- That branch is where this work stands: merge it into your worktree first and build on it instead of starting over.`]

const uncommittedLine = (facts: ResumeFacts): string[] =>
  facts.uncommittedFiles.length === 0
    ? []
    : [`- Uncommitted files in its worktree at ${facts.worktree ?? 'an unknown path'}: ${facts.uncommittedFiles.join(', ')}. That folder is outside your worktree: your shell cannot go there, the Read tool can. Read them and take what is right.`]

const changedOnBaseLine = (facts: ResumeFacts): string[] =>
  facts.changedOnBase.length === 0 ? [] : [`- Files this branch touched that changed on ${facts.base} since: ${facts.changedOnBase.join(', ')}`]

const someoneElseLine = (facts: ResumeFacts): string[] =>
  facts.lastCommitterIfSomeoneElse === undefined
    ? []
    : [`- The last commit on ${facts.branch} is by ${facts.lastCommitterIfSomeoneElse}, not by this checkout's git user.`]

// Seen on a scratch board on 2026-11-20: a doing ticket whose branch was already merged was started again with nothing
// said, and the run would have built the same thing a second time.
const inBaseLine = (facts: ResumeFacts): string[] =>
  facts.isInBase
    ? [`- Branch ${facts.branch} is already in ${facts.base}: its work is merged. Check whether the Done when already passes there before building anything.`]
    : []

const remoteLine = (facts: ResumeFacts): string[] =>
  facts.hasRemoteMoved ? [`- ${facts.branch} moved on the remote since. Merge what is there; never force push.`] : []

export const resumeSection = (facts: ResumeFacts | undefined, earlierBranch?: string): string[] => {
  if (facts === undefined) return []
  const lines = [
    ...inBaseLine(facts),
    ...commitLines(facts),
    ...buildOnLine(facts, earlierBranch),
    ...uncommittedLine(facts),
    ...changedOnBaseLine(facts),
    ...someoneElseLine(facts),
    ...remoteLine(facts),
  ]

  return lines.length === 0
    ? []
    : [['## What changed since', 'An earlier run of this ticket stopped without a result. What the board found when this run started:', ...lines].join('\n')]
}
