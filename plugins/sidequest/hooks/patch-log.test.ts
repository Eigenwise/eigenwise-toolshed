import { expect, test } from 'claude-code/testing'

import { DEFAULT_BOARD_CONFIG } from './board-config'
import type { BoardFiles } from './store'
import { applyTicketOperations } from './ticket-tool'
import { newTicket } from './tickets'
import type { Ticket } from './tickets'

const STAMP = '2026-11-20T10:02Z'

const boardWith = (ticket: Ticket): BoardFiles => ({ config: DEFAULT_BOARD_CONFIG, configText: undefined, tickets: [ticket], stories: [] })

const TICKET = { ...newTicket('SQ-1', { title: 'Retry failed uploads', what: 'Uploads retry.' }, '2026-11-16T09:00Z'), log: ['2026-11-16T09:00Z created'] }

const patched = (fields: Record<string, unknown>): Ticket => {
  const answer = applyTicketOperations({ operations: [{ op: 'patch', id: 'SQ-1', ...fields }] }, boardWith(TICKET), STAMP)
  const ticket = answer.change?.tickets[0]
  if (ticket === undefined) throw new Error(`the patch was refused: ${JSON.stringify(answer.answer)}`)

  return ticket
}

test('a patch of the status logs the old and the new value in the shape of a move', () => {
  expect(patched({ status: 'parked' }).log).toEqual([...TICKET.log, `${STAMP} patched status ready to parked`])
})

test('a patch of the title logs the old and the new title', () => {
  expect(patched({ title: 'Retry uploads twice' }).log).toEqual([...TICKET.log, `${STAMP} patched title "Retry failed uploads" to "Retry uploads twice"`])
})

test('a patch of both logs one line with both', () => {
  expect(patched({ status: 'parked', title: 'Retry uploads twice' }).log).toEqual([
    ...TICKET.log,
    `${STAMP} patched status ready to parked, title "Retry failed uploads" to "Retry uploads twice"`,
  ])
})

test('a patch of another field, or of a status and title to what they already are, logs nothing', () => {
  expect(patched({ what: 'Uploads retry three times.' }).log).toEqual(TICKET.log)
  expect(patched({ status: 'ready', title: 'Retry failed uploads' }).log).toEqual(TICKET.log)
})

test('a move still logs as it did', () => {
  const answer = applyTicketOperations({ operations: [{ op: 'move', id: 'SQ-1', status: 'parked' }] }, boardWith(TICKET), STAMP)

  expect(answer.change?.tickets[0]?.log).toEqual([...TICKET.log, `${STAMP} moved ready to parked`])
})
