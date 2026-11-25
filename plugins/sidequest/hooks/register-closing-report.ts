import { NO_SESSION_CHANGES, withSessionChanges } from './closing-report'
import type { SessionChanges } from './closing-report'
import type { Ticket } from './tickets'

// Kept in the module, never in state or a file: a reload forgets it, and the closing report then names nothing of
// this session and counts everything as from before.
let changesThisSession: SessionChanges = NO_SESSION_CHANGES

export const rememberSessionChanges = (before: readonly Ticket[], written: readonly Ticket[]): void => {
  changesThisSession = withSessionChanges(changesThisSession, before, written)
}

export const sessionChanges = (): SessionChanges => changesThisSession

export const ticketsTouchedThisSession = (): ReadonlySet<string> => new Set(changesThisSession.keys())
