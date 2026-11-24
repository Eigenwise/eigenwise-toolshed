import { expect, test } from 'claude-code/testing'

import { DEFAULT_BOARD_CONFIG } from './board-config'
import { answerBoardView } from './board-tool'
import { piecesOfWork } from './pieces-of-work'
import type { BoardFiles } from './store'
import { applyTicketOperations } from './ticket-tool'
import { newStory, newTicket, withChangedTickets } from './tickets'
import type { Story, Ticket } from './tickets'
import type { ToolAnswer } from './tool-input'

const STAMP = '2026-11-23T10:00Z'

const ticketOf = (id: string, fields: Parameters<typeof newTicket>[1]): Ticket => newTicket(id, fields, STAMP)

const asking = (question: string): Parameters<typeof newTicket>[1] => ({
  status: 'needs-you',
  mode: 'hitl',
  forYou: `Question: ${question}\nOptions:\n- Yes\n- No\nRecommended: A`,
})

const REFUNDS = { story: 'LA-S1', issue: 'PAY-41', branch: 'PAY-41-partial-refunds' }
const LEDGER = { story: 'LA-S2', branch: 'PAY-57-ledger-export' }
const SETTINGS = { story: 'LA-S3', branch: 'main' }

const STORIES: Story[] = [
  newStory('LA-S1', 'Refunds can be partial', STAMP),
  newStory('LA-S2', 'PAY-57 Export the ledger as CSV', STAMP),
  newStory('LA-S3', 'Tidy the settings page', STAMP),
]

const THREE_PIECES: Ticket[] = [
  ticketOf('LA-1', { title: 'PAY-41 Keep the refunded amount', ...REFUNDS }),
  ticketOf('LA-2', { title: 'PAY-41 The remaining amount shows on the payment', ...REFUNDS, ...asking('Show the remaining amount in red?') }),
  ticketOf('LA-3', { title: 'Write the CSV header', ...LEDGER, ...asking('Do dates go first?') }),
  ticketOf('LA-4', { title: 'Stream the rows', ...LEDGER, status: 'doing' }),
  ticketOf('LA-5', { title: 'PAY-41 Refund twice on one payment', ...REFUNDS, status: 'doing' }),
  ticketOf('LA-6', { title: 'Name the file', ...LEDGER }),
  ticketOf('LA-7', { title: 'Move the toggles', ...SETTINGS, ...asking('Keep the old toggles one release?') }),
  ticketOf('LA-8', { title: 'Drop the old tab', ...SETTINGS }),
  ticketOf('LA-9', { title: 'Rename the section', ...SETTINGS, status: 'done' }),
  ticketOf('LA-10', { title: 'Fix a typo', branch: 'main' }),
]

const filesOf = (tickets: Ticket[], stories: Story[]): BoardFiles => ({
  config: DEFAULT_BOARD_CONFIG,
  configText: undefined,
  tickets,
  stories,
  checkedOutBranch: 'main',
})

const textOf = (answer: ToolAnswer): string => ('text' in answer ? answer.text : `refused: ${answer.refusal}`)

// The session wrote LA-6 and LA-8, so the ledger work comes first and the settings work, also on the checkout, next.
const SESSION_CHANGES = new Map([
  ['LA-6', 'inbox'],
  ['LA-8', undefined],
])

const view = (name: string, files: BoardFiles, changes: ReadonlyMap<string, string | undefined> = SESSION_CHANGES): string =>
  textOf(answerBoardView({ view: name }, files, STAMP, undefined, undefined, changes))

test('waiting groups by the piece of work, the work this session touched first, and 1A still answers the first block', () => {
  expect(view('waiting', filesOf(THREE_PIECES, STORIES))).toBe(
    [
      'Waiting on you, by piece of work:',
      'PAY-57 Export the ledger as CSV (branch PAY-57-ledger-export)',
      [
        '1. Do dates go first?',
        '   A. Yes',
        '   B. No',
        '   Recommended: A',
        '   To answer: 1 and a letter, like 1A. Ticket Write the CSV header (LA-3).',
      ].join('\n'),
      'Tidy the settings page (branch main)',
      [
        '2. Keep the old toggles one release?',
        '   A. Yes',
        '   B. No',
        '   Recommended: A',
        '   To answer: 2 and a letter, like 2A. Ticket Move the toggles (LA-7).',
      ].join('\n'),
      'PAY-41 Refunds can be partial (branch PAY-41-partial-refunds)',
      [
        '3. Show the remaining amount in red?',
        '   A. Yes',
        '   B. No',
        '   Recommended: A',
        '   To answer: 3 and a letter, like 3A. Ticket The remaining amount shows on the payment (LA-2).',
      ].join('\n'),
    ].join('\n\n'),
  )
})

test('now groups by the piece of work and each line starts with what the ticket is', () => {
  expect(view('now', filesOf(THREE_PIECES, STORIES))).toBe(
    [
      'PAY-57 Export the ledger as CSV (branch PAY-57-ledger-export)',
      '- running: Stream the rows (LA-4)',
      '- could start: Name the file (LA-6)',
      'Tidy the settings page (branch main)',
      '- could start: Drop the old tab (LA-8)',
      'PAY-41 Refunds can be partial (branch PAY-41-partial-refunds)',
      '- running: Refund twice on one payment (LA-5)',
      '- could start: Keep the refunded amount (LA-1)',
      'Other tickets',
      '- could start: Fix a typo (LA-10, branch main)',
      'You could:',
      '- Answer 3 questions that wait on you, first: Show the remaining amount in red?',
      '- Say what you want next',
      'For the session, not to paste:',
      'Its return comes to you as a new turn: end your turn, do not sleep or read the board again to wait.',
    ].join('\n'),
  )
})

test('closing puts the session lines under their pieces and names the other pieces in the count line', () => {
  expect(view('closing', filesOf(THREE_PIECES, STORIES))).toBe(
    [
      'What this session changed on the board:',
      'PAY-57 Export the ledger as CSV (branch PAY-57-ledger-export)',
      '- Name the file (LA-6): ready to start',
      'Tidy the settings page (branch main)',
      '- Drop the old tab (LA-8): ready to start',
      'Also on the board: PAY-57 Export the ledger as CSV (1 open, 1 waiting on you), Tidy the settings page (1 waiting on you), PAY-41 Refunds can be partial (2 open, 1 waiting on you), other tickets (1 open).',
    ].join('\n'),
  )
})

const ONE_STORY = THREE_PIECES.filter(ticket => ticket.story === 'LA-S1')

test('a board with one piece of work prints no heading, and its line names the key once', () => {
  const files = filesOf(ONE_STORY, STORIES.slice(0, 1))
  const changes = new Map([['LA-1', 'inbox']])

  expect(view('waiting', files, changes)).toBe(
    [
      'Waiting on you, most blocking first:',
      [
        'Show the remaining amount in red?',
        '   A. Yes',
        '   B. No',
        '   Recommended: A',
        '   To answer: a letter, like A. Ticket PAY-41 LA-2 (branch PAY-41-partial-refunds).',
      ].join('\n'),
    ].join('\n\n'),
  )
  expect(view('now', files, changes)).toBe(
    [
      'Running now:',
      '- PAY-41 LA-5 (branch PAY-41-partial-refunds) PAY-41 Refund twice on one payment',
      'Could start now:',
      '- PAY-41 LA-1 (branch PAY-41-partial-refunds) PAY-41 Keep the refunded amount',
      'You could:',
      '- Answer: Show the remaining amount in red?',
      '- Say what you want next',
      'For the session, not to paste:',
      'Its return comes to you as a new turn: end your turn, do not sleep or read the board again to wait.',
    ].join('\n'),
  )
  expect(view('closing', files, changes)).toBe(
    [
      'What this session changed on the board:',
      '- PAY-41 LA-1 Keep the refunded amount: ready to start',
      'Also on the board from before: 1 open, 1 waiting on you.',
    ].join('\n'),
  )
})

const ORDER_STORIES: Story[] = [newStory('LA-S1', 'Oldest work', STAMP), newStory('LA-S2', 'Checked out work', STAMP), newStory('LA-S3', 'Touched work', STAMP)]

const ORDER_BOARD: Ticket[] = [
  ticketOf('LA-1', { title: 'A loose one', branch: 'main' }),
  ticketOf('LA-2', { title: 'Oldest', story: 'LA-S1', branch: 'other' }),
  ticketOf('LA-3', { title: 'On the checkout', story: 'LA-S2', branch: 'main' }),
  ticketOf('LA-4', { title: 'Touched', story: 'LA-S3', branch: 'other' }),
  ticketOf('LA-5', { title: 'Key only', issue: 'PAY-9', branch: 'other' }),
]

const pieceHandles = (touched: ReadonlySet<string>, checkedOutBranch?: string): string[] =>
  piecesOfWork(ORDER_BOARD, { tickets: ORDER_BOARD, stories: ORDER_STORIES, touched, ...(checkedOutBranch === undefined ? {} : { checkedOutBranch }) }).pieces.map(
    piece => piece.handle,
  )

test('pieces come touched first, else on the checked-out branch, else by their lowest id, and loose tickets belong to none', () => {
  expect(pieceHandles(new Set(['LA-4']), 'main')).toEqual(['Touched work', 'Checked out work', 'Oldest work', 'PAY-9'])
  expect(pieceHandles(new Set(), 'main')).toEqual(['Checked out work', 'Oldest work', 'Touched work', 'PAY-9'])
  expect(pieceHandles(new Set())).toEqual(['Oldest work', 'Checked out work', 'Touched work', 'PAY-9'])
  expect(piecesOfWork(ORDER_BOARD, { tickets: ORDER_BOARD, stories: ORDER_STORIES, touched: new Set() }).ticketsOfNoPiece.map(ticket => ticket.id)).toEqual(['LA-1'])
})

const PARKING_BOARD: Ticket[] = [
  ticketOf('LA-1', { title: 'Keep the refunded amount', ...REFUNDS, ...asking('Round to cents?') }),
  ticketOf('LA-2', { title: 'Write the CSV header', ...LEDGER, ...asking('Do dates go first?') }),
  ticketOf('LA-3', { title: 'Refund twice on one payment', ...REFUNDS, ...asking('Allow a second refund?') }),
  ticketOf('LA-4', { title: 'Name the file', ...LEDGER, ...asking('Put the date in the name?'), status: 'ready', mode: 'afk' }),
]

test('the note pasted when a write parks a ticket carries the number and name the waiting view printed right after gives it', () => {
  const files = filesOf(PARKING_BOARD, STORIES)
  const turn = { words: undefined, ticketsThisSessionCreated: new Set<string>(), ticketsThisSessionTouched: new Set<string>() }
  const moved = applyTicketOperations({ operations: [{ op: 'move', id: 'LA-4', status: 'needs-you' }] }, files, STAMP, turn)
  const after = { ...files, tickets: withChangedTickets(files.tickets, moved.change?.tickets ?? []) }
  const heading = 'PAY-57 Export the ledger as CSV (branch PAY-57-ledger-export)'
  const block = [
    '2. Put the date in the name?',
    '   A. Yes',
    '   B. No',
    '   Recommended: A',
    '   To answer: 2 and a letter, like 2A. Ticket Name the file (LA-4).',
  ].join('\n')
  const waiting = view('waiting', after, new Map([['LA-4', 'ready']]))

  expect(textOf(moved.answer)).toContain(`Show the person this as it is:\n${heading}\n\n${block}`)
  expect(waiting).toContain(block)
  expect(waiting.lastIndexOf(heading, waiting.indexOf(block))).toBeGreaterThan(waiting.lastIndexOf('(branch PAY-41-partial-refunds)', waiting.indexOf(block)))
})

const headingsOf = (tickets: Ticket[], stories: Story[]): string[] =>
  view('waiting', filesOf(tickets, stories), new Map())
    .split('\n\n')
    .filter(part => !/^\d+\. /.test(part) && part !== 'Waiting on you, by piece of work:')

test('a heading is never blank, never doubles a key and never shows a raw story id', () => {
  const stories = [newStory('LA-S1', '', STAMP), newStory('LA-S2', 'PAY-41', STAMP), newStory('LA-S3', 'PAY-57 Export the ledger', STAMP)]
  const tickets = [
    ticketOf('LA-1', { title: 'Untitled story work', story: 'LA-S1', branch: 'main', ...asking('One?') }),
    ticketOf('LA-2', { title: 'Keyed story work', story: 'LA-S2', issue: 'PAY-41', branch: 'main', ...asking('Two?') }),
    ticketOf('LA-3', { title: 'Other key work', story: 'LA-S3', issue: 'PAY-60', branch: 'main', ...asking('Three?') }),
    ticketOf('LA-4', { title: 'Lost story with a key', story: 'LA-S9', issue: 'PAY-70', branch: 'main', ...asking('Four?') }),
    ticketOf('LA-5', { title: 'Lost story without a key', story: 'LA-S8', branch: 'main', ...asking('Five?') }),
  ]

  expect(headingsOf(tickets, stories)).toEqual([
    'LA-S1 (branch main)',
    'PAY-41 (branch main)',
    'PAY-57 Export the ledger (branch main)',
    'PAY-70 (branch main)',
    'Other tickets',
  ])
})

test('a loose ticket with the tracker key of a story joins that story, and a piece knows the branch its tickets share', () => {
  const tickets = [
    ticketOf('LA-1', { title: 'PAY-41 First', story: 'LA-S1', issue: 'PAY-41', branch: 'refunds' }),
    ticketOf('LA-2', { title: 'PAY-41 Second', issue: 'PAY-41', branch: 'refunds' }),
    ticketOf('LA-3', { title: 'Elsewhere', story: 'LA-S2', branch: 'one' }),
    ticketOf('LA-4', { title: 'Elsewhere too', story: 'LA-S2', branch: 'two' }),
  ]
  const stories = [newStory('LA-S1', 'PAY-41: Refunds can be partial', STAMP), newStory('LA-S2', 'Tidy the settings page', STAMP)]
  const { pieces } = piecesOfWork(tickets, { tickets, stories, touched: new Set() })

  expect(pieces.map(piece => ({ handle: piece.handle, ids: piece.tickets.map(ticket => ticket.id), sharedBranch: piece.sharedBranch }))).toEqual([
    { handle: 'PAY-41 Refunds can be partial', ids: ['LA-1', 'LA-2'], sharedBranch: 'refunds' },
    { handle: 'Tidy the settings page', ids: ['LA-3', 'LA-4'], sharedBranch: undefined },
  ])
})
