import type { EngineInterface, Frozen, PromptSubmitInput } from 'claude-code'

import { startedUnaskedNotice, turnWordsOf } from './whose-words'
import type { TurnWords } from './whose-words'

// Kept in the module for the current main turn only, never in state or a file. A reload forgets it, and then a write
// that takes a ticket out of parked says the board did not see the turn start.
let currentTurn: TurnWords | undefined
let isInteractiveSession = false

// The tickets this session created, so a stop with no story parks this session's plan and nobody else's. Lost on a
// reload, and then that stop parks nothing and says so.
const ticketsThisSessionCreated = new Set<string>()

export const noteSessionStart = (isInteractive: boolean): void => {
  isInteractiveSession = isInteractive
}

// Answers what this prompt itself says, so a notification folded into a turn nobody typed does not count twice.
export const noteTurnPrompt = (prompt: Frozen<PromptSubmitInput>): TurnWords | undefined => {
  const turn = turnWordsOf(prompt, isInteractiveSession)
  currentTurn = turn ?? currentTurn

  return turn
}

export const currentTurnWords = (): TurnWords | undefined => currentTurn

export const rememberCreatedTickets = (ticketIds: readonly string[]): void => {
  for (const ticketId of ticketIds) ticketsThisSessionCreated.add(ticketId)
}

export const createdThisSession = (): ReadonlySet<string> => ticketsThisSessionCreated

export async function tellPersonOfUnaskedStarts($: EngineInterface, ticketIds: readonly string[]): Promise<void> {
  if (ticketIds.length === 0) return
  const notice = startedUnaskedNotice(ticketIds)
  $.ui.toast(notice)
  await $.ui.notify(notice, { title: 'Sidequest', key: `started-unasked-${ticketIds.join('-')}` }).catch(() => undefined)
}
