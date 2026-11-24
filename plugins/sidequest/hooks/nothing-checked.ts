import { logTextsSinceLastStart } from './agent-returns'
import { NOT_RECORDED } from './run-outcome'
import type { Ticket } from './tickets'

// Seen on a scratch board on 2026-11-20: a finish with no check, or one that said it was not checked, answered
// "moved to review" and nothing else, and the result read as proven. The log says it in these words every time.
export const NOTHING_WAS_CHECKED = 'nothing was checked'

const SAYS_NOT_CHECKED = /^(not (checked|run|verified|tested)|un(checked|tested|verified)|no (checks?|tests?)\b|nothing (was )?(checked|run|tested)|none\b|nothing$|n\/a\b|-$)/i

const LEADING_MARKS = /^[\s`"'*_]+/

export const saysNothingWasChecked = (checked: string | undefined): boolean => {
  const words = (checked ?? '').replace(LEADING_MARKS, '').trim()

  return words === '' || words === NOT_RECORDED || SAYS_NOT_CHECKED.test(words)
}

// The return record may already hold what the agent checked; finish then adds nothing to it.
export const checkedSinceLastStart = (log: readonly string[]): string | undefined =>
  logTextsSinceLastStart(log)
    .findLast(text => text.startsWith('checked '))
    ?.slice('checked '.length)

export const wasFinishedUnchecked = (ticket: Ticket): boolean =>
  ['review', 'done'].includes(ticket.status) && logTextsSinceLastStart(ticket.log).includes(NOTHING_WAS_CHECKED)
