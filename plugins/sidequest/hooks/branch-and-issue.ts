import { waitsOnHuman } from './human-answers'
import { runBranchOf } from './resume-facts'
import { STARTED_BY_SESSION } from './tickets'
import type { Ticket } from './tickets'

export type TicketHandleFields = Pick<Ticket, 'id' | 'issue' | 'branch' | 'startedBy' | 'pullRequest'>

const BRANCH_IN_HEAD = /^ref:\s*refs\/heads\/(.+)$/
const KEY_AT_TITLE_START = /^([A-Z]+-\d+)(?![\w-])/
const KEY_IN_BRANCH = /(?:^|[^A-Za-z0-9])([A-Z]+-\d+)(?!\d)/g

const OPEN_WORK_STATUSES = ['ready', 'doing', 'review']

export const branchInHead = (headText: string): string | undefined => BRANCH_IN_HEAD.exec(headText.trim())?.[1]

export const trackerKeyAtTitleStart = (title: string): string | undefined => KEY_AT_TITLE_START.exec(title.trim())?.[1]

export const trackerKeysInBranch = (branch: string): string[] =>
  [...branch.matchAll(KEY_IN_BRANCH)].flatMap(match => match[1] ?? [])

// The board's own ids have the same shape as a tracker key, and one of those names a board ticket, not tracker work.
const isTrackerKey = (key: string | undefined, isBoardTicketId: (id: string) => boolean): key is string =>
  key !== undefined && !isBoardTicketId(key)

export const trackerKeyFor = (title: string, branch: string | undefined, isBoardTicketId: (id: string) => boolean): string | undefined => {
  const fromTitle = trackerKeyAtTitleStart(title)

  return isTrackerKey(fromTitle, isBoardTicketId) ? fromTitle : trackerKeysInBranch(branch ?? '').find(key => isTrackerKey(key, isBoardTicketId))
}

// What the session gave wins; a hand edit is never overwritten because this only runs on create.
export const withBranchAndIssue = (ticket: Ticket, checkedOutBranch: string | undefined, isBoardTicketId: (id: string) => boolean): Ticket => {
  const branch = ticket.branch ?? checkedOutBranch
  const issue = ticket.issue ?? trackerKeyFor(ticket.title, branch, isBoardTicketId)

  return { ...ticket, ...(branch === undefined ? {} : { branch }), ...(issue === undefined ? {} : { issue }) }
}

// A number alone, `#12`, or an address that ends in the number, the way trackers write a pull request's address.
const NUMBER_AT_THE_END = /(?:^#?|\/)(\d+)\/?$/

export const pullRequestNumberOf = (pullRequest: string | undefined): string | undefined =>
  NUMBER_AT_THE_END.exec(pullRequest?.trim() ?? '')?.[1]

export const pullRequestWords = (pullRequest: string): string => {
  const number = pullRequestNumberOf(pullRequest)

  return number === undefined ? `pull request ${pullRequest}` : `pull request #${number}`
}

const branchDetail = (branch: string | undefined, knownBranch: string | undefined): string =>
  branch === undefined || branch === knownBranch ? '' : `branch ${branch}`

// What follows the board id in brackets. A branch the reader already knows from a heading is left out.
export const handleDetails = (ticket: TicketHandleFields, knownBranch?: string): string[] =>
  [
    branchDetail(ticket.branch, knownBranch),
    ticket.pullRequest === undefined ? '' : pullRequestWords(ticket.pullRequest),
    ticket.startedBy === STARTED_BY_SESSION ? 'started by the session' : '',
  ].filter(part => part !== '')

// The person knows their work by the tracker key, so it leads and the board id follows as the small handle.
export const ticketHandle = (ticket: TicketHandleFields): string => {
  const details = handleDetails(ticket)
  const idWithDetails = details.length === 0 ? ticket.id : `${ticket.id} (${details.join(', ')})`

  return ticket.issue === undefined || ticket.issue === '' ? idWithDetails : `${ticket.issue} ${idWithDetails}`
}

const isOpenWork = (ticket: Ticket): boolean => OPEN_WORK_STATUSES.includes(ticket.status) || waitsOnHuman(ticket)

const isOnOtherBranch = (ticket: Ticket, checkedOutBranch: string): boolean =>
  ticket.branch !== undefined && ticket.branch !== checkedOutBranch && ticket.branch !== runBranchOf(ticket) && isOpenWork(ticket)

const otherBranchLine = (ticket: Ticket, checkedOutBranch: string): string =>
  `${ticketHandle({ id: ticket.id, issue: ticket.issue })} belongs to branch ${ticket.branch ?? ''}, but the checkout is on ${checkedOutBranch}.`

const MOST_LINES_BEFORE_ONE = 3

// A board filed on one branch and read from another would otherwise print a line per ticket.
const manyOnOtherBranches = (tickets: readonly Ticket[], checkedOutBranch: string): string =>
  `${tickets.length} open tickets belong to another branch than ${checkedOutBranch}, the one checked out: ${tickets
    .map(ticket => `${ticketHandle({ id: ticket.id, issue: ticket.issue })} on ${ticket.branch ?? ''}`)
    .join(', ')}.`

export const otherBranchLines = (tickets: readonly Ticket[], checkedOutBranch: string | undefined): string[] => {
  if (checkedOutBranch === undefined) return []
  const elsewhere = tickets.filter(ticket => isOnOtherBranch(ticket, checkedOutBranch))

  return elsewhere.length > MOST_LINES_BEFORE_ONE
    ? [manyOnOtherBranches(elsewhere, checkedOutBranch)]
    : elsewhere.map(ticket => otherBranchLine(ticket, checkedOutBranch))
}
