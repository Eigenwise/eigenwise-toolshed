import { isRecord } from './board-config'
import { pullRequestNumberOf, ticketHandle } from './branch-and-issue'
import { interruptedIn } from './interrupted-work'
import type { InterruptedWork } from './interrupted-work'
import { commitsIn, isOwnEmail, lastCommitterIfSomeoneElse, linesOf, runBranchOf } from './resume-facts'
import { inIdOrder } from './tickets'
import type { Ticket } from './tickets'
import type { JsonRecord } from './tool-input'

// For a team: what the remote and the tracker say about a ticket's work. Asked only when the person looks at a view
// or a ticket starts, and only for a ticket with a tracker key or a pull request. Any answer may be missing, and a
// missing answer reads as nothing to say. The first real session ran in a team repository where work lived on
// branches and pull requests the board knew nothing about.

// The tracker command line the land skill delivers through.
export const TRACKER_COMMAND = 'gh'

export const PULL_REQUEST_STATE_FIELDS = 'number,url,state,reviewDecision,mergeable,statusCheckRollup'
export const OPEN_PULL_REQUEST_FIELDS = 'number,url,author,headRefName,title'
export const REMOTE_BRANCH_FORMAT = '%(refname)%09%(symref)%09%(committername)%09%(committeremail)'
export const LAST_COMMIT_FORMAT = '%h%x09%ce%x09%cn%x09%s'

export const hasRemoteIn = (gitConfig: string | undefined): boolean => /^\s*\[remote\s+"[^"]*"\]/m.test(gitConfig ?? '')

export const isTeamTicket = (ticket: Ticket): boolean => ticket.issue !== undefined || ticket.pullRequest !== undefined

const parsedJson = (text: string | undefined): unknown => {
  try {
    const value: unknown = JSON.parse(text ?? '')

    return value
  } catch {
    return undefined
  }
}

const textIn = (record: JsonRecord, key: string): string => {
  const value = record[key]

  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

const escapedForPattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const carriesKey = (text: string, key: string): boolean =>
  new RegExp(`(?:^|[^A-Za-z0-9])${escapedForPattern(key)}(?!\\d)`).test(text)

// Remote branches, read from what the checkout already has: nothing is fetched.

export type RemoteBranch = { name: string; branch: string; committerName: string; committerEmail: string }

export type RemoteBranches = { branches: RemoteBranch[]; defaultBranches: ReadonlySet<string> }

export const NO_REMOTE_BRANCHES: RemoteBranches = { branches: [], defaultBranches: new Set() }

const REMOTE_REF = /^refs\/remotes\/([^/]+)\/(.+)$/

type RemoteRefLine = { remote: string; branch: string; pointsTo: string; committerName: string; committerEmail: string }

const remoteRefLineOf = (line: string): RemoteRefLine[] => {
  const [refname = '', pointsTo = '', committerName = '', committerEmail = ''] = line.split('\t')
  const match = REMOTE_REF.exec(refname)

  return match?.[1] === undefined || match[2] === undefined
    ? []
    : [{ remote: match[1], branch: match[2], pointsTo, committerName, committerEmail: committerEmail.replace(/^<|>$/g, '') }]
}

const isRemoteHead = (line: RemoteRefLine): boolean => line.branch === 'HEAD'

const defaultBranchOf = (line: RemoteRefLine): string => line.pointsTo.replace(`refs/remotes/${line.remote}/`, '')

export const remoteBranchesFrom = (refs: string | undefined): RemoteBranches => {
  const lines = linesOf(refs).flatMap(remoteRefLineOf)

  return {
    branches: lines
      .filter(line => !isRemoteHead(line))
      .map(line => ({ name: `${line.remote}/${line.branch}`, branch: line.branch, committerName: line.committerName, committerEmail: line.committerEmail })),
    defaultBranches: new Set(lines.filter(isRemoteHead).map(defaultBranchOf)),
  }
}

// Where each pull request stands, for the waiting view.

export type PullRequestState = {
  number: string
  address: string
  changesRequested: boolean
  approved: boolean
  checksFailing: boolean
  conflict: boolean
}

// Ticket id to the state of its open pull request.
export type PullRequestStates = ReadonlyMap<string, PullRequestState>

export const NO_PULL_REQUEST_STATES: PullRequestStates = new Map()

const FAILING_CHECK_WORDS = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])

// A check run says how it ended in `conclusion`, an older commit status in `state`.
const isFailingCheck = (check: unknown): boolean =>
  isRecord(check) && (FAILING_CHECK_WORDS.has(textIn(check, 'conclusion')) || FAILING_CHECK_WORDS.has(textIn(check, 'state')))

const checksOf = (record: JsonRecord): unknown[] => (Array.isArray(record.statusCheckRollup) ? record.statusCheckRollup : [])

// A merged or closed pull request asks nothing more, so only an open one has a state.
export const pullRequestStateFrom = (answer: string | undefined): PullRequestState | undefined => {
  const record = parsedJson(answer)
  if (!isRecord(record) || record.state !== 'OPEN') return undefined

  return {
    number: textIn(record, 'number'),
    address: textIn(record, 'url'),
    changesRequested: record.reviewDecision === 'CHANGES_REQUESTED',
    approved: record.reviewDecision === 'APPROVED',
    checksFailing: checksOf(record).some(isFailingCheck),
    conflict: record.mergeable === 'CONFLICTING',
  }
}

export const hasComeBack = (state: PullRequestState): boolean => state.changesRequested || state.checksFailing

const spokenList = (parts: readonly string[]): string =>
  parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1) ?? ''}`

const troubleWords = (state: PullRequestState): string[] =>
  [
    state.changesRequested ? 'changes requested' : '',
    state.checksFailing ? 'failing checks' : '',
    state.conflict ? 'a conflict with its base' : '',
  ].filter(part => part !== '')

// Approved with nothing wrong is one word; an open pull request with nothing to say says nothing.
export const pullRequestStateWords = (state: PullRequestState): string => {
  const trouble = troubleWords(state)
  if (trouble.length > 0) return spokenList(trouble)

  return state.approved ? 'approved' : ''
}

// Which tickets to ask the tracker about: open work, and done work whose pull request may come back.

const isWorthAskingAbout = (ticket: Ticket): boolean =>
  isTeamTicket(ticket) && ticket.status !== 'parked' && (ticket.status !== 'done' || ticket.pullRequest !== undefined)

export const MOST_PULL_REQUESTS_ASKED_ABOUT = 8

// Newest first, so the cap leaves out the oldest work.
export const ticketsToAskAbout = (tickets: readonly Ticket[]): Ticket[] =>
  inIdOrder(tickets).reverse().filter(isWorthAskingAbout).slice(0, MOST_PULL_REQUESTS_ASKED_ABOUT)

export const needsRemoteBranches = (tickets: readonly Ticket[]): boolean => tickets.some(ticket => ticket.pullRequest === undefined)

const branchOfWork = (ticket: Ticket): string | undefined => runBranchOf(ticket) ?? ticket.branch

const isPushedWorkBranch = (branch: string | undefined, remote: RemoteBranches): branch is string =>
  branch !== undefined && !remote.defaultBranches.has(branch) && remote.branches.some(pushed => pushed.branch === branch)

export type PullRequestQuestion = { ticketId: string; reference: string }

const referenceFor = (ticket: Ticket, remote: RemoteBranches): string | undefined => {
  const branch = branchOfWork(ticket)

  return ticket.pullRequest ?? (isPushedWorkBranch(branch, remote) ? branch : undefined)
}

export const pullRequestQuestions = (tickets: readonly Ticket[], remote: RemoteBranches): PullRequestQuestion[] =>
  tickets.flatMap(ticket => {
    const reference = referenceFor(ticket, remote)

    return reference === undefined ? [] : [{ ticketId: ticket.id, reference }]
  })

// Someone already on it, for start.

export type OpenPullRequest = { number: string; address: string; author: string; branch: string; title: string }

const authorOf = (author: unknown): string => (isRecord(author) ? textIn(author, 'login') : '')

const openPullRequestOf = (item: unknown): OpenPullRequest[] =>
  isRecord(item)
    ? [{ number: textIn(item, 'number'), address: textIn(item, 'url'), author: authorOf(item.author), branch: textIn(item, 'headRefName'), title: textIn(item, 'title') }]
    : []

export const openPullRequestsFrom = (answer: string | undefined): OpenPullRequest[] => {
  const list = parsedJson(answer)

  return Array.isArray(list) ? list.flatMap(openPullRequestOf) : []
}

export const isWorthAskingWhoElse = (ticket: Ticket | undefined): ticket is Ticket & { issue: string } =>
  ticket?.issue !== undefined && ticket.mode !== 'hitl'

export type OthersOnTheKey = { pullRequests: OpenPullRequest[]; branches: RemoteBranch[] }

export const NOBODY_ELSE_ON_THE_KEY: OthersOnTheKey = { pullRequests: [], branches: [] }

export type WhoElseAnswers = { pullRequests: OpenPullRequest[]; remote: RemoteBranches; ownEmail: string | undefined }

const ownBranchesOf = (ticket: Ticket): Set<string> =>
  new Set([ticket.branch, runBranchOf(ticket)].filter((branch): branch is string => branch !== undefined))

const isOthersPullRequest = (pullRequest: OpenPullRequest, ticket: Ticket, key: string): boolean =>
  pullRequest.number !== pullRequestNumberOf(ticket.pullRequest) &&
  !ownBranchesOf(ticket).has(pullRequest.branch) &&
  (carriesKey(pullRequest.title, key) || carriesKey(pullRequest.branch, key))

const isOthersBranch = (branch: RemoteBranch, ticket: Ticket, key: string, answers: WhoElseAnswers): boolean =>
  carriesKey(branch.branch, key) && !ownBranchesOf(ticket).has(branch.branch) && !isOwnEmail(branch.committerEmail, answers.ownEmail)

// A branch that carries one of those pull requests is said once, as the pull request.
export const othersOnTheKey = (ticket: Ticket & { issue: string }, answers: WhoElseAnswers): OthersOnTheKey => {
  const pullRequests = answers.pullRequests.filter(pullRequest => isOthersPullRequest(pullRequest, ticket, ticket.issue))
  const pullRequestBranches = new Set(pullRequests.map(pullRequest => pullRequest.branch))
  const branches = answers.remote.branches.filter(
    branch => !pullRequestBranches.has(branch.branch) && isOthersBranch(branch, ticket, ticket.issue, answers),
  )

  return { pullRequests, branches }
}

const MOST_NAMED_ON_THE_KEY = 2

const whoOrSomeone = (name: string): string => (name.trim() === '' ? 'someone' : name.trim())

const addressPart = (address: string): string => (address === '' ? '' : ` (${address})`)

const pullRequestWho = (pullRequest: OpenPullRequest): string =>
  `${whoOrSomeone(pullRequest.author)} has open pull request #${pullRequest.number} on ${pullRequest.branch}${addressPart(pullRequest.address)}`

const branchWho = (branch: RemoteBranch): string => `${whoOrSomeone(branch.committerName)} last committed to ${branch.name}`

const moreWords = (count: number): string[] => (count > 0 ? [`and ${count} more`] : [])

// A fact for the session to pass on, never a refusal: the ticket is started either way.
export const someoneElseOnItLine = (ticket: Ticket, others: OthersOnTheKey): string => {
  const parts = [...others.pullRequests.map(pullRequestWho), ...others.branches.map(branchWho)]
  if (parts.length === 0) return ''
  const named = [...parts.slice(0, MOST_NAMED_ON_THE_KEY), ...moreWords(parts.length - MOST_NAMED_ON_THE_KEY)]

  return `\nSomeone else may already be on ${ticket.issue ?? ticket.id}: ${named.join('; ')}. ${ticket.id} started all the same; pass this on to the person.`
}

// Interrupted work on a branch someone else committed to last is theirs now, so it is not offered to resume.

// Ticket id to the name of whoever committed to its branch last, only when that is not this checkout's git user.
export type CommittedLastBySomeoneElse = ReadonlyMap<string, string>

export const NO_ONE_ELSE_COMMITTED_LAST: CommittedLastBySomeoneElse = new Map()

export type BranchToAskAbout = { ticketId: string; branch: string }

export const interruptedBranchesToAskAbout = (tickets: readonly Ticket[], interrupted: InterruptedWork): BranchToAskAbout[] =>
  interruptedIn(tickets, interrupted)
    .filter(isTeamTicket)
    .flatMap(ticket => {
      const branch = runBranchOf(ticket)

      return branch === undefined ? [] : [{ ticketId: ticket.id, branch }]
    })

export const committedLastFrom = (
  asked: readonly BranchToAskAbout[],
  lastCommits: readonly (string | undefined)[],
  ownEmail: string | undefined,
): CommittedLastBySomeoneElse =>
  new Map(
    asked.flatMap((question, index): [string, string][] => {
      const someoneElse = lastCommitterIfSomeoneElse(commitsIn(lastCommits[index]), ownEmail)

      return someoneElse === undefined ? [] : [[question.ticketId, someoneElse]]
    }),
  )

export const withoutTheirs = (interrupted: InterruptedWork, theirs: CommittedLastBySomeoneElse): InterruptedWork =>
  new Map([...interrupted].filter(([ticketId]) => !theirs.has(ticketId)))

export const theirsSummaryLines = (tickets: readonly Ticket[], theirs: CommittedLastBySomeoneElse): string[] =>
  inIdOrder(tickets).flatMap(ticket => {
    const name = theirs.get(ticket.id)

    return name === undefined
      ? []
      : [`${ticketHandle(ticket)} was interrupted on a branch ${name} committed to last: it is ${name}'s work now, so it is not offered to resume.`]
  })

// What the board tool's views read from the remote and the tracker, when they asked.
export type TeamFacts = { pullRequests: PullRequestStates; committedLastBySomeoneElse: CommittedLastBySomeoneElse }

export const NO_TEAM_FACTS: TeamFacts = { pullRequests: NO_PULL_REQUEST_STATES, committedLastBySomeoneElse: NO_ONE_ELSE_COMMITTED_LAST }
