import { expect, test } from 'claude-code/testing'

import { DEFAULT_BOARD_CONFIG } from './board-config'
import { applyTicketOperations, PRESS_ON_THE_BOARD } from './ticket-tool'
import type { BoardFiles } from './store'
import { newTicket } from './tickets'
import type { Ticket } from './tickets'
import { fittedRow } from './views/pane-sections'
import type { SectionRow } from './views/pane-sections'

const STAMP = '2026-11-24T10:00Z'

const boardOf = (tickets: Ticket[]): BoardFiles => ({ config: DEFAULT_BOARD_CONFIG, configText: undefined, tickets, stories: [] })

test('a pressed drop toasts plain words, and the answer the model reads still says to patch blockedBy', () => {
  const blocker = newTicket('SQ-3', { title: 'Pick a backoff', status: 'ready' }, STAMP)
  const blocked = newTicket('SQ-5', { title: 'Retry uploads', status: 'ready', blockedBy: ['SQ-3'] }, STAMP)

  const result = applyTicketOperations({ operations: [{ op: 'drop', id: 'SQ-3' }] }, boardOf([blocker, blocked]), STAMP, PRESS_ON_THE_BOARD)
  const forThePerson = result.forThePerson?.(new Set()) ?? ''

  expect(forThePerson).toBe('SQ-3 dropped. SQ-3 had no branch or worktree of its own. SQ-5 was waiting on SQ-3 and is now stuck. Tell the session if it should go on without it.')
  expect('text' in result.answer && result.answer.text).toContain('patch its blockedBy')
})

test('a pressed set aside toasts the ticket set aside, and the model still reads the move', () => {
  const ticket = newTicket('SQ-3', { title: 'Pick a backoff', status: 'ready' }, STAMP)

  const result = applyTicketOperations({ operations: [{ op: 'move', id: 'SQ-3', status: 'parked' }] }, boardOf([ticket]), STAMP, PRESS_ON_THE_BOARD)

  expect(result.forThePerson?.(new Set())).toBe('SQ-3 set aside.')
  expect('text' in result.answer && result.answer.text).toContain('moved SQ-3 to parked.')
})

const rowWith = (aside: string): SectionRow => ({
  kind: 'row',
  tone: 'plain',
  text: 'SQ-12 Retry failed uploads when the network drops',
  aside,
  keepsAside: true,
  press: { opens: 'nothing' },
})

// A 60-column pane leaves 58 for the row beside its rail.
test('the longer asides show whole in a 60-column pane', () => {
  for (const aside of ['stopped, nothing runs it (3h ago)', 'started earlier, nothing runs it now', 'built, being checked', 'waits on SQ-2, which was dropped']) {
    expect(fittedRow(rowWith(aside), 58).aside).toBe(aside)
  }
})
