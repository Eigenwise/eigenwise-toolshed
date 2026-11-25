import { handleDetails, trackerKeyAtTitleStart } from './branch-and-issue'
import type { TicketHandleFields } from './branch-and-issue'
import { idNumber, inIdOrder, oneLine } from './tickets'
import type { Story, Ticket } from './tickets'

// A person with two or three tracker issues in flight reads a view by the work, so the views group by it. A piece of
// work is a story; tickets with no story but one tracker key are one piece; a ticket with neither belongs to none.

export type StoriesAndCheckout = { stories: readonly Story[]; checkedOutBranch?: string; projectName?: string }

export const NO_STORIES: StoriesAndCheckout = { stories: [] }

export type BoardWork = StoriesAndCheckout & { tickets: readonly Ticket[]; touched: ReadonlySet<string> }

export type PieceOfWork = { handle: string; trackerKey?: string; sharedBranch?: string; storyId?: string; tickets: Ticket[] }

export type PiecesOfWork = { pieces: PieceOfWork[]; ticketsOfNoPiece: Ticket[] }

export type HeadedTickets = { heading: string; piece?: PieceOfWork; tickets: Ticket[] }

export const OTHER_TICKETS_HEADING = 'Other tickets'

const hasIssue = <Fields extends Pick<Ticket, 'issue'>>(ticket: Fields): ticket is Fields & { issue: string } =>
  ticket.issue !== undefined && ticket.issue !== ''

const storyIdsOf = (board: BoardWork): string[] => board.stories.map(story => story.id)

// A story id with no story file behind it would head a block with a raw id, so its tickets go by their key instead.
const storyOnBoard = (ticket: Ticket, board: BoardWork): string | undefined =>
  board.stories.some(story => story.id === ticket.story) ? ticket.story : undefined

const storyTitleOf = (storyId: string, board: BoardWork): string | undefined =>
  board.stories.find(story => story.id === storyId)?.title

const trackerKeyOfStory = (storyId: string, board: BoardWork): string | undefined =>
  inIdOrder(board.tickets).find(ticket => ticket.story === storyId && hasIssue(ticket))?.issue ??
  trackerKeyAtTitleStart(storyTitleOf(storyId, board) ?? '')

type PieceIdentity = { name: string; storyId?: string; trackerKey?: string }

const storyPiece = (storyId: string): PieceIdentity => ({ name: `story ${storyId}`, storyId })

// A loose ticket with the key of a story's work belongs to that story, so the same heading never shows twice.
const storyIdByTrackerKey = (board: BoardWork): Map<string, string> => {
  const byKey = new Map<string, string>()
  for (const storyId of storyIdsOf(board)) {
    const key = trackerKeyOfStory(storyId, board)
    if (key !== undefined && !byKey.has(key)) byKey.set(key, storyId)
  }

  return byKey
}

type PieceOfTicket = (ticket: Ticket) => PieceIdentity | undefined

const looseTicketPiece = (issue: string, storyIdByKey: ReadonlyMap<string, string>): PieceIdentity => {
  const storyId = storyIdByKey.get(issue)

  return storyId === undefined ? { name: `issue ${issue}`, trackerKey: issue } : storyPiece(storyId)
}

const pieceOfTicketOn = (board: BoardWork): PieceOfTicket => {
  const storyIdByKey = storyIdByTrackerKey(board)

  return ticket => {
    const storyId = storyOnBoard(ticket, board)
    if (storyId !== undefined) return storyPiece(storyId)

    return hasIssue(ticket) ? looseTicketPiece(ticket.issue, storyIdByKey) : undefined
  }
}

const KEY_SEPARATOR = /^[\s:-]+/

const restAfterKey = (plainTitle: string, key: string): string => plainTitle.slice(key.length).replace(KEY_SEPARATOR, '')

export const titleWithoutKey = (title: string, key: string | undefined): string => {
  const plain = oneLine(title)
  if (key === undefined || trackerKeyAtTitleStart(plain) !== key) return plain

  return restAfterKey(plain, key) || plain
}

// A title that already starts with a tracker key keeps it, so no heading reads `PAY-41 PAY-57 ...` or `PAY-41 PAY-41`.
const keyedTitle = (key: string, plainTitle: string): string => {
  const keyInTitle = trackerKeyAtTitleStart(plainTitle)
  if (keyInTitle === undefined) return `${key} ${plainTitle}`
  if (keyInTitle !== key) return plainTitle

  return [key, restAfterKey(plainTitle, key)].filter(part => part !== '').join(' ')
}

const pieceHandle = (key: string | undefined, title: string | undefined, storyId: string): string => {
  const plainTitle = oneLine(title ?? '')
  if (plainTitle === '') return key ?? storyId

  return key === undefined ? plainTitle : keyedTitle(key, plainTitle)
}

export const sharedBranchOf = (tickets: readonly { branch?: string }[]): string | undefined => {
  const branches = new Set(tickets.map(ticket => ticket.branch))
  const [only] = branches

  return branches.size === 1 ? only : undefined
}

const pieceKeyAndTitle = (identity: PieceIdentity, board: BoardWork): { trackerKey?: string; title?: string } =>
  identity.storyId === undefined
    ? { trackerKey: identity.trackerKey }
    : { trackerKey: trackerKeyOfStory(identity.storyId, board), title: storyTitleOf(identity.storyId, board) }

const pieceFor = (identity: PieceIdentity, tickets: Ticket[], board: BoardWork): PieceOfWork => {
  const { trackerKey, title } = pieceKeyAndTitle(identity, board)
  const handle = pieceHandle(trackerKey, title, identity.storyId ?? '')
  const sharedBranch = sharedBranchOf(tickets)

  return {
    handle,
    tickets,
    ...(trackerKey === undefined ? {} : { trackerKey }),
    ...(sharedBranch === undefined ? {} : { sharedBranch }),
    ...(identity.storyId === undefined ? {} : { storyId: identity.storyId }),
  }
}

const TOUCHED_RANK = 0
const CHECKED_OUT_RANK = 1
const OTHER_RANK = 2

const rankOfPiece = (identity: PieceIdentity, board: BoardWork, pieceOfTicket: PieceOfTicket): number => {
  const inPiece = board.tickets.filter(ticket => pieceOfTicket(ticket)?.name === identity.name)
  if (inPiece.some(ticket => board.touched.has(ticket.id))) return TOUCHED_RANK

  return inPiece.some(ticket => board.checkedOutBranch !== undefined && ticket.branch === board.checkedOutBranch) ? CHECKED_OUT_RANK : OTHER_RANK
}

type ShownPiece = { identity: PieceIdentity; tickets: Ticket[] }

const shownPieces = (shown: readonly Ticket[], pieceOfTicket: PieceOfTicket): ShownPiece[] => {
  const byName = new Map<string, ShownPiece>()
  for (const ticket of inIdOrder(shown)) {
    const identity = pieceOfTicket(ticket)
    if (identity !== undefined) byName.set(identity.name, { identity, tickets: [...(byName.get(identity.name)?.tickets ?? []), ticket] })
  }

  return [...byName.values()]
}

type RankedPiece = { rank: number; lowestId: number; piece: PieceOfWork }

// The work this session is on comes first, then the work the checkout is on, then the rest by their oldest ticket.
export const piecesOfWork = (shown: readonly Ticket[], board: BoardWork): PiecesOfWork => {
  const pieceOfTicket = pieceOfTicketOn(board)
  const ranked: RankedPiece[] = shownPieces(shown, pieceOfTicket).map(({ identity, tickets }) => ({
    rank: rankOfPiece(identity, board, pieceOfTicket),
    lowestId: Math.min(...tickets.map(ticket => idNumber(ticket.id))),
    piece: pieceFor(identity, tickets, board),
  }))
  ranked.sort((left, right) => left.rank - right.rank || left.lowestId - right.lowestId)

  return { pieces: ranked.map(({ piece }) => piece), ticketsOfNoPiece: inIdOrder(shown).filter(ticket => pieceOfTicket(ticket) === undefined) }
}

// One piece, or only loose tickets, reads as it always did: grouping would only add headings.
export const spansSeveralPieces = (grouped: PiecesOfWork): boolean => grouped.pieces.length > 1

export const pieceHeading = (piece: Pick<PieceOfWork, 'handle' | 'sharedBranch'>): string =>
  piece.sharedBranch === undefined ? piece.handle : `${piece.handle} (branch ${piece.sharedBranch})`

// Where a whole heading has no room, the person still knows the work by its tracker key, else by the story's title.
export const shortPieceName = (piece: Pick<PieceOfWork, 'handle' | 'trackerKey'>): string => piece.trackerKey ?? piece.handle

export type PieceOfATicket = { handle: string; trackerKey?: string; sharedBranch?: string; storyId?: string; order: number }

const pieceOfATicket = ({ handle, trackerKey, sharedBranch, storyId }: PieceOfWork, order: number): PieceOfATicket => ({
  handle,
  order,
  ...(trackerKey === undefined ? {} : { trackerKey }),
  ...(sharedBranch === undefined ? {} : { sharedBranch }),
  ...(storyId === undefined ? {} : { storyId }),
})

// The order and the branch are the shared ones over the whole board, so a view drawn later from the cards alone keeps
// them whichever of the piece's tickets it shows.
export const pieceOfEachTicket = (board: BoardWork): Map<string, PieceOfATicket> => {
  const byTicketId = new Map<string, PieceOfATicket>()
  piecesOfWork(board.tickets, board).pieces.forEach((piece, order) => {
    for (const ticket of piece.tickets) byTicketId.set(ticket.id, pieceOfATicket(piece, order))
  })

  return byTicketId
}

export const headedTickets = (grouped: PiecesOfWork): HeadedTickets[] => [
  ...grouped.pieces.map(piece => ({ heading: pieceHeading(piece), piece, tickets: piece.tickets })),
  ...(grouped.ticketsOfNoPiece.length === 0 ? [] : [{ heading: OTHER_TICKETS_HEADING, tickets: grouped.ticketsOfNoPiece }]),
]

type KnownFromHeading = Pick<PieceOfWork, 'trackerKey' | 'sharedBranch'>

const keyWhenOtherThanPiece = (ticket: TicketHandleFields, piece: KnownFromHeading | undefined): string[] =>
  hasIssue(ticket) && ticket.issue !== piece?.trackerKey ? [ticket.issue] : []

// The board id, and whatever of key, branch and pull request the heading above does not already say.
export const handleUnder = (ticket: TicketHandleFields, piece: KnownFromHeading | undefined): string =>
  [...keyWhenOtherThanPiece(ticket, piece), ticket.id, ...handleDetails(ticket, piece?.sharedBranch)].join(', ')

// Under a heading the title carries the work and the board id follows in brackets as the small handle.
export const ticketNameUnder = (ticket: Ticket, piece: PieceOfWork | undefined): string =>
  `${titleWithoutKey(ticket.title, piece?.trackerKey)} (${handleUnder(ticket, piece)})`
