import { expect, test } from 'claude-code/testing'

import { DEFAULT_BOARD_CONFIG } from './board-config'
import { answerBoardView } from './board-tool'
import type { BoardFiles } from './store'
import { appendLogLine, newTicket } from './tickets'
import type { Ticket } from './tickets'
import type { ToolAnswer } from './tool-input'
import { boardCards } from './views/board-view'
import { boardPaneLines, paneLinesAsText } from './views/pane-sections'

const NOW = Date.parse('2026-11-19T10:00:00Z')
const STAMP = '2026-11-19T10:00Z'

const touchedYesterday = (id: string, title: string, status: string, fields: Partial<Ticket> = {}): Ticket =>
  appendLogLine({ ...newTicket(id, { title, status, ...fields }, '2026-11-18T09:00Z') }, '2026-11-18T09:00Z', `moved ready to ${status}`)

// No dropped ticket, nothing older than a week and nothing written by this session: the board as it read before.
const ORDINARY_BOARD: Ticket[] = [
  touchedYesterday('SQ-1', 'Retry failed uploads', 'ready'),
  touchedYesterday('SQ-2', 'Show retry count', 'ready', { blockedBy: ['SQ-1'] }),
  touchedYesterday('SQ-3', 'Pick a backoff', 'needs-you'),
  touchedYesterday('SQ-4', 'Log the retries', 'review'),
  touchedYesterday('SQ-5', 'Old cleanup', 'done'),
  touchedYesterday('SQ-6', 'Maybe later', 'parked'),
  touchedYesterday('SQ-7', 'An idea', 'inbox'),
]

const FILES: BoardFiles = { config: DEFAULT_BOARD_CONFIG, configText: undefined, tickets: ORDINARY_BOARD, stories: [], checkedOutBranch: 'main' }

const textOf = (answer: ToolAnswer): string => ('text' in answer ? answer.text : `refused: ${answer.refusal}`)

const view = (name: string): string => textOf(answerBoardView({ view: name }, FILES, STAMP))

test('a board with nothing dropped, nothing old and nothing of this session gives the same summary, list and frontier', () => {
  expect(view('summary')).toBe(
    '1 waiting on you, 2 ready to start, 0 in progress, 1 being checked. Ready to start: SQ-1. The waiting view writes what waits on the person, ready to pass on, to answer in this chat.\nAlso on the board: 1 done earlier, 1 parked. To see them: ask for the done, parked or inbox list, or type /board.',
  )
  expect(view('list')).toBe(
    [
      'SQ-1 ready build Retry failed uploads',
      'SQ-2 ready build Show retry count',
      'SQ-3 needs-you build Pick a backoff',
      'SQ-4 review build Log the retries',
      'SQ-5 done build Old cleanup',
      'SQ-6 parked build Maybe later',
      'SQ-7 inbox build An idea',
    ].join('\n'),
  )
  expect(view('frontier')).toBe('SQ-1 ready build Retry failed uploads')
  expect(view('now')).toBe(
    [
      'Nothing is running.',
      'Could start now:',
      '- SQ-1 Retry failed uploads',
      'You could:',
      '- Answer: Pick a backoff',
      '- Look at what is finished: SQ-4 Log the retries',
      '- Say what you want next',
    ].join('\n'),
  )
})

test('a board with nothing dropped, nothing old and nothing of this session draws the same pane', () => {
  const content = {
    cards: boardCards(ORDINARY_BOARD, DEFAULT_BOARD_CONFIG),
    running: [],
    sessionWork: { isWorking: false, steps: 0 },
    finishedAgents: [],
    worktreeCount: 0,
    touchedHere: new Set(['SQ-1', 'SQ-2', 'SQ-3', 'SQ-4', 'SQ-5']),
    showsIntro: false,
    columns: 80,
    now: NOW,
    whatYouCouldDo: [],
  }

  expect(paneLinesAsText(boardPaneLines(content))).toBe(
    [
      'Waits on you',
      '  SQ-3 Pick a backoff  no question written yet',
      '',
      'Nothing is running.',
      '',
      'Being checked',
      '  SQ-4 Log the retries',
      '',
      'Next',
      '  SQ-1 Retry failed uploads',
      '  SQ-2 Show retry count',
      '',
      'Done',
      '  SQ-5 Old cleanup',
      '',
      'Also on the board: 1 set aside, 1 not ready yet',
    ].join('\n'),
  )
})
