import { idNumber } from './tickets'

// Every ticket id on a board starts with ticketPrefix and every story id with storyPrefix, then a number.
export type BoardIds = { ticketPrefix: string; storyPrefix: string }

// A board from before prefixes existed: every project's first ticket was SQ-1, so its ids stay as they were.
export const EARLIER_BOARD_IDS: BoardIds = { ticketPrefix: 'SQ-', storyPrefix: 'ST-' }

// The S after the dash keeps a story id from ever reading as a ticket id, or as a tracker key.
export const boardIdsOf = (prefix: string | undefined): BoardIds =>
  prefix === undefined ? EARLIER_BOARD_IDS : { ticketPrefix: `${prefix}-`, storyPrefix: `${prefix}-S` }

export const ticketIdOn = (ids: BoardIds, number: number): string => `${ids.ticketPrefix}${number}`

export const storyIdOn = (ids: BoardIds, number: number): string => `${ids.storyPrefix}${number}`

const isNumberedAfter = (prefix: string, value: string): boolean =>
  value.startsWith(prefix) && /^\d+$/.test(value.slice(prefix.length))

export const isTicketIdOn = (ids: BoardIds, value: string): boolean => isNumberedAfter(ids.ticketPrefix, value)

export const isStoryIdOn = (ids: BoardIds, value: string): boolean => isNumberedAfter(ids.storyPrefix, value)

type IdSet = { has: (id: string) => boolean }

// What a write takes as an id: the board's own form, or an id already on the board, so the tickets filed before a
// person changed the prefix by hand still take patches and still block.
export type IdsOnBoard = {
  isTicketId: (value: string) => boolean
  isStoryId: (value: string) => boolean
  ticketExample: string
  storyExample: string
}

export const idsOnBoard = (ids: BoardIds, tickets: IdSet, stories: IdSet): IdsOnBoard => ({
  isTicketId: value => isTicketIdOn(ids, value) || tickets.has(value),
  isStoryId: value => isStoryIdOn(ids, value) || stories.has(value),
  ticketExample: ticketIdOn(ids, 12),
  storyExample: storyIdOn(ids, 3),
})

// A counter never goes backwards, and a new number lands above every id a file on disk carries.
export const nextNumberAfter = (counter: number, ids: Iterable<string>): number =>
  Math.max(counter, 1 + Math.max(0, ...[...ids].map(idNumber)))

const NOTHING_ON_THE_BOARD: IdSet = { has: () => false }

export const idsOnEmptyBoard = (ids: BoardIds): IdsOnBoard => idsOnBoard(ids, NOTHING_ON_THE_BOARD, NOTHING_ON_THE_BOARD)
