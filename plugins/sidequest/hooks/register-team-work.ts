import type { EngineInterface } from 'claude-code'

import { boardLocation } from './board-session'
import { boardViewOf } from './board-tool'
import type { InterruptedWork } from './interrupted-work'
import { readOptionalText } from './store'
import type { BoardLocation } from './store'
import {
  committedLastFrom,
  hasRemoteIn,
  interruptedBranchesToAskAbout,
  isWorthAskingWhoElse,
  LAST_COMMIT_FORMAT,
  needsRemoteBranches,
  NO_ONE_ELSE_COMMITTED_LAST,
  NO_PULL_REQUEST_STATES,
  NO_REMOTE_BRANCHES,
  NO_TEAM_FACTS,
  OPEN_PULL_REQUEST_FIELDS,
  openPullRequestsFrom,
  othersOnTheKey,
  PULL_REQUEST_STATE_FIELDS,
  pullRequestQuestions,
  pullRequestStateFrom,
  REMOTE_BRANCH_FORMAT,
  remoteBranchesFrom,
  ticketsToAskAbout,
  TRACKER_COMMAND,
} from './team-work'
import type { CommittedLastBySomeoneElse, OthersOnTheKey, PullRequestQuestion, PullRequestState, PullRequestStates, RemoteBranches, TeamFacts } from './team-work'
import type { Ticket } from './tickets'
import type { JsonRecord } from './tool-input'

// Every lookup here is asked only when the person looks at a view or a ticket starts, and only for tickets with a
// tracker key or a pull request. A project with no remote is known from its git config file, so it starts no process.
// A failed or slow answer reads as nothing to say, and nothing is written anywhere.

// Lookups run side by side, so all of them together take no longer than this.
const LOOKUP_TIMEOUT_MS = 3000

async function askCommand($: EngineInterface, cwd: string, argv: readonly string[]): Promise<string | undefined> {
  const answer = await $.process.run(argv, { cwd, timeoutMs: LOOKUP_TIMEOUT_MS }).catch(() => undefined)

  return answer?.exitCode === 0 ? answer.stdout : undefined
}

function askGit($: EngineInterface, root: string, args: readonly string[]): Promise<string | undefined> {
  return askCommand($, root, ['git', ...args])
}

function askTracker($: EngineInterface, root: string, args: readonly string[]): Promise<string | undefined> {
  return askCommand($, root, [TRACKER_COMMAND, ...args])
}

export async function hasRemote($: EngineInterface, location: BoardLocation): Promise<boolean> {
  return location.gitCommonDir !== undefined && hasRemoteIn(await readOptionalText($, `${location.gitCommonDir}/config`))
}

async function remoteBranchesOf($: EngineInterface, root: string): Promise<RemoteBranches> {
  return remoteBranchesFrom(await askGit($, root, ['for-each-ref', `--format=${REMOTE_BRANCH_FORMAT}`, 'refs/remotes']))
}

// One lookup for an open pull request on the same key, by anyone but the person signed in to the tracker, and what the
// checkout already knows of remote branches.
export async function othersOnTheKeyFor($: EngineInterface, location: BoardLocation, ticket: Ticket | undefined): Promise<OthersOnTheKey | undefined> {
  if (!isWorthAskingWhoElse(ticket) || !(await hasRemote($, location))) return undefined
  const search = ['pr', 'list', '--state', 'open', '--search', `${ticket.issue} -author:@me`, '--json', OPEN_PULL_REQUEST_FIELDS]
  const [listed, remote, ownEmail] = await Promise.all([
    askTracker($, location.root, search),
    remoteBranchesOf($, location.root),
    askGit($, location.root, ['config', 'user.email']),
  ])

  return othersOnTheKey(ticket, { pullRequests: openPullRequestsFrom(listed), remote, ownEmail })
}

async function pullRequestStateOf($: EngineInterface, root: string, question: PullRequestQuestion): Promise<[string, PullRequestState][]> {
  const state = pullRequestStateFrom(await askTracker($, root, ['pr', 'view', question.reference, '--json', PULL_REQUEST_STATE_FIELDS]))

  return state === undefined ? [] : [[question.ticketId, state]]
}

export async function pullRequestStatesFor($: EngineInterface, tickets: readonly Ticket[]): Promise<PullRequestStates> {
  const asked = ticketsToAskAbout(tickets)
  if (asked.length === 0) return NO_PULL_REQUEST_STATES
  const location = await boardLocation($)
  if (!(await hasRemote($, location))) return NO_PULL_REQUEST_STATES
  const remote = needsRemoteBranches(asked) ? await remoteBranchesOf($, location.root) : NO_REMOTE_BRANCHES
  const states = await Promise.all(pullRequestQuestions(asked, remote).map(question => pullRequestStateOf($, location.root, question)))

  return new Map(states.flat())
}

export async function committedLastBySomeoneElse($: EngineInterface, tickets: readonly Ticket[], interrupted: InterruptedWork): Promise<CommittedLastBySomeoneElse> {
  const asked = interruptedBranchesToAskAbout(tickets, interrupted)
  if (asked.length === 0) return NO_ONE_ELSE_COMMITTED_LAST
  const location = await boardLocation($)
  if (!(await hasRemote($, location))) return NO_ONE_ELSE_COMMITTED_LAST
  const [ownEmail, ...lastCommits] = await Promise.all([
    askGit($, location.root, ['config', 'user.email']),
    ...asked.map(question => askGit($, location.root, ['log', '-1', `--format=${LAST_COMMIT_FORMAT}`, question.branch])),
  ])

  return committedLastFrom(asked, lastCommits, ownEmail)
}

// Each view asks only for what it shows.
export async function teamFactsForView($: EngineInterface, input: JsonRecord, tickets: readonly Ticket[], interrupted: InterruptedWork): Promise<TeamFacts> {
  const view = boardViewOf(input)
  if (view === 'waiting') return { ...NO_TEAM_FACTS, pullRequests: await pullRequestStatesFor($, tickets) }
  if (view === 'summary' || view === 'now') return { ...NO_TEAM_FACTS, committedLastBySomeoneElse: await committedLastBySomeoneElse($, tickets, interrupted) }

  return NO_TEAM_FACTS
}
