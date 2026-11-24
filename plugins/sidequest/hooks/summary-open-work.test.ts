import { expect, test } from 'claude-code/testing'

import { DEFAULT_BOARD_CONFIG } from './board-config'
import { answerBoardView } from './board-tool'
import type { SessionChanges } from './closing-report'
import type { BoardFiles } from './store'
import { newTicket } from './tickets'
import type { Ticket } from './tickets'
import type { ToolAnswer } from './tool-input'

const STAMP = '2026-11-23T10:00Z'
const WEEK_AGO = '2026-11-16T09:00Z'
const SIX_DAYS_AGO = '2026-11-17T09:00Z'
const HOW_TO_SEE_THEM = 'To see them: ask for the done, parked or inbox list, or type /board.'

const ticketOf = (id: string, title: string, status: string, created = WEEK_AGO): Ticket => newTicket(id, { title, status }, created)

const filesOf = (tickets: Ticket[], folderRead?: string): BoardFiles => ({
  config: DEFAULT_BOARD_CONFIG,
  configText: undefined,
  tickets,
  stories: [],
  checkedOutBranch: 'main',
  folderRead,
})

const summaryOf = (files: BoardFiles, changes: SessionChanges = new Map()): string => {
  const answer: ToolAnswer = answerBoardView({ view: 'summary' }, files, STAMP, undefined, undefined, changes)

  return 'text' in answer ? answer.text : `refused: ${answer.refusal}`
}

test('a board of earlier done work, one parked and one inbox ticket names the inbox ticket and says how to see the rest', () => {
  const summary = summaryOf(
    filesOf([
      ticketOf('SQ-1', 'First', 'done'),
      ticketOf('SQ-2', 'Second', 'done'),
      ticketOf('SQ-3', 'Third', 'done'),
      ticketOf('SQ-4', 'Maybe later', 'parked'),
      ticketOf('SQ-5', 'Sort out the retries', 'inbox', '2026-11-22T09:00Z'),
    ]),
  )

  expect(summary).not.toContain('tickets in all')
  expect(summary.split('\n')).toEqual([
    '0 waiting on you, 0 ready to start, 0 in progress, 0 being checked. Nothing is ready to start.',
    '1 in the inbox, 1 day old: Sort out the retries (SQ-5).',
    `Also on the board: 3 done earlier, 1 parked. ${HOW_TO_SEE_THEM}`,
  ])
})

test('six in the inbox names the three oldest and counts three more', () => {
  const inbox = [1, 2, 3, 4, 5, 6].map(number => ticketOf(`SQ-${number}`, `Idea ${number}`, 'inbox', number === 1 ? SIX_DAYS_AGO : `2026-11-2${number}T09:00Z`))
  const summary = summaryOf(filesOf(inbox))

  expect(summary.split('\n')).toContain(
    `6 in the inbox, the oldest 6 days old: Idea 1 (SQ-1), Idea 2 (SQ-2), Idea 3 (SQ-3), and 3 more. ${HOW_TO_SEE_THEM}`,
  )
})

test('a done ticket this session touched is not counted as done earlier, and dropped work is not counted', () => {
  const tickets = [ticketOf('SQ-1', 'Old', 'done'), ticketOf('SQ-2', 'Just now', 'done'), ticketOf('SQ-3', 'Gone', 'dropped')]
  const summary = summaryOf(filesOf(tickets), new Map([['SQ-2', 'doing']]))

  expect(summary).toContain(`Also on the board: 1 done earlier. ${HOW_TO_SEE_THEM}`)
  expect(summary).not.toContain('dropped')
})

test('only open tickets add no line and no how-to-see sentence', () => {
  const summary = summaryOf(filesOf([ticketOf('SQ-1', 'Build it', 'ready'), ticketOf('SQ-2', 'Check it', 'review')]))

  expect(summary).toBe('0 waiting on you, 1 ready to start, 0 in progress, 1 being checked. Ready to start: SQ-1.')
})

test('a single named inbox ticket and nothing else adds no how-to-see sentence', () => {
  const summary = summaryOf(filesOf([ticketOf('SQ-1', 'Only idea', 'inbox')]))

  expect(summary).toContain('1 in the inbox, 7 days old: Only idea (SQ-1).')
  expect(summary).not.toContain('To see them')
})

test('an empty board still names the folder it read', () => {
  expect(summaryOf(filesOf([], '/repo/.sidequest'))).toContain('No ticket files in /repo/.sidequest.')
})
