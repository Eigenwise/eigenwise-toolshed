import type { HookFailure } from 'claude-code'

const MAX_CAUSE_CHARACTERS = 300

// A timeout carries no message, so the kind is what is left to say.
export const causeOf = (failure: HookFailure): string => (failure.message ?? failure.kind).slice(0, MAX_CAUSE_CHARACTERS)

export const boardToolRefusal = (cause: string): string =>
  `Sidequest could not read or write the board just now (${cause}). The board is plain files under .sidequest/ (board.json, tickets/<id>.md, stories/<id>.md, each id starting with the prefix in board.json, or SQ- and ST- on a board without one), so edit them directly in the same format.`
