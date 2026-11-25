import { expect, test } from 'claude-code/testing'

import type { BoardCard } from '../../types'
import { DEFAULT_BOARD_CONFIG } from '../board-config'
import { NO_INTERRUPTED_WORK } from '../interrupted-work'
import { newStory, newTicket } from '../tickets'
import type { Story, Ticket } from '../tickets'
import { bandLine, boardCards, piecesWaitingOnYou } from './board-view'
import { boardPaneLines, paneLinesAsText } from './pane-sections'
import type { PaneContent, PaneLine } from './pane-sections'

const STAMP = '2026-11-16T09:56Z'
const NOW = Date.parse('2026-11-16T10:02:00Z')

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

// Two keyed stories of three tickets each and one story with no key, beside one loose ticket.
const THREE_PIECES: Ticket[] = [
  ticketOf('LA-1', { title: 'PAY-41 Keep the refunded amount', ...REFUNDS }),
  ticketOf('LA-2', { title: 'PAY-41 The remaining amount shows on the payment', ...REFUNDS, ...asking('Show the remaining amount in red?') }),
  ticketOf('LA-3', { title: 'Write the CSV header', ...LEDGER, ...asking('Do dates go first?') }),
  ticketOf('LA-4', { title: 'Stream the rows', ...LEDGER, status: 'doing' }),
  ticketOf('LA-5', { title: 'PAY-41 Refund twice on one payment', ...REFUNDS, status: 'review' }),
  ticketOf('LA-6', { title: 'Name the file', ...LEDGER, status: 'done' }),
  ticketOf('LA-7', { title: 'Move the toggles', ...SETTINGS, ...asking('Keep the old toggles one release?') }),
  ticketOf('LA-8', { title: 'Drop the old tab', ...SETTINGS }),
  ticketOf('LA-9', { title: 'Rename the section', ...SETTINGS, status: 'done' }),
  ticketOf('LA-10', { title: 'Fix a typo', branch: 'main' }),
]

// The session wrote LA-6 and LA-8, so the ledger work comes first and the settings work, also on the checkout, next.
const TOUCHED = new Set(['LA-6', 'LA-8'])

const cardsOf = (tickets: readonly Ticket[], stories: readonly Story[], touched: ReadonlySet<string> = TOUCHED): BoardCard[] =>
  boardCards(tickets, DEFAULT_BOARD_CONFIG, NO_INTERRUPTED_WORK, { stories, checkedOutBranch: 'main', touched })

const contentOf = (cards: readonly BoardCard[], touched: ReadonlySet<string> = TOUCHED): PaneContent => ({
  cards,
  running: [{ agentId: 'agent-1', what: 'Stream the rows', ticket: 'LA-4', model: 'sonnet', canBeViewed: true }],
  sessionWork: { isWorking: false, steps: 0 },
  finishedAgents: [],
  worktreeCount: 0,
  touchedHere: touched,
  showsIntro: false,
  columns: 120,
  now: NOW,
  whatYouCouldDo: [],
})

const pressedIds = (lines: readonly PaneLine[]): string[] =>
  lines.flatMap(line => (line.kind === 'row' && line.press.opens === 'ticket' ? [line.press.id] : []))

test('across three pieces of work the pane draws one block per piece, the touched work first, each row saying what it is and ending on the board id', () => {
  const lines = boardPaneLines(contentOf(cardsOf(THREE_PIECES, STORIES)))

  expect(paneLinesAsText(lines)).toBe(
    [
      'Now',
      '  PAY-57: Stream the rows  sonnet',
      '',
      'Being checked',
      '  PAY-41 LA-5 Refund twice on one payment',
      '',
      'PAY-57 Export the ledger as CSV (branch PAY-57-ledger-export)',
      '  waits on you: Do dates go first?  recommended: Yes  LA-3',
      '  done: Name the file  LA-6',
      '',
      'Tidy the settings page (branch main)',
      '  waits on you: Keep the old toggles one release?  recommended: Yes  LA-7',
      '  next: Drop the old tab  LA-8',
      '',
      'PAY-41 Refunds can be partial (branch PAY-41-partial-refunds)',
      '  waits on you: Show the remaining amount in red?  recommended: Yes  LA-2',
      '  next: Keep the refunded amount  LA-1',
      '',
      'Other tickets',
      '  next: Fix a typo  LA-10, branch main',
    ].join('\n'),
  )
  expect(lines.filter(line => line.kind === 'heading').length).toBe(4)
  expect(pressedIds(lines)).toEqual(['LA-5', 'LA-3', 'LA-6', 'LA-7', 'LA-8', 'LA-2', 'LA-1', 'LA-10'])
})

const ONE_STORY = THREE_PIECES.filter(ticket => ticket.story === 'LA-S1')
const ONE_STORY_TOUCHED = new Set(['LA-1'])

test('a board with one story draws its pane and its band as before, with the tracker key leading each handle', () => {
  const cards = cardsOf(ONE_STORY, STORIES.slice(0, 1), ONE_STORY_TOUCHED)
  const cardsAsBefore = boardCards(ONE_STORY, DEFAULT_BOARD_CONFIG)
  const pane = paneLinesAsText(boardPaneLines({ ...contentOf(cards, ONE_STORY_TOUCHED), running: [] }))

  expect(pane).toBe(paneLinesAsText(boardPaneLines({ ...contentOf(cardsAsBefore, ONE_STORY_TOUCHED), running: [] })))
  expect(pane).toBe(
    [
      'Waits on you',
      '  PAY-41 LA-2 Show the remaining amount in red?  recommended: Yes',
      '',
      'Nothing is running.',
      '',
      'Being checked',
      '  PAY-41 LA-5 Refund twice on one payment',
      '',
      'Next',
      '  PAY-41 LA-1 Keep the refunded amount',
    ].join('\n'),
  )

  const activity = { agents: {}, runs: {}, doingTickets: [], returnedTickets: [], waits: {}, piecesWaitingOnYou: piecesWaitingOnYou(cards, NOW, ONE_STORY_TOUCHED) }
  expect(bandLine({ needsYou: 1, ready: 1, doing: 0, review: 1 }, activity, 120)).toEqual({ warnings: '1 ticket needs you', counts: '1 ticket ready to start, 1 being checked' })
})

const quietActivity = (pieces: readonly string[]) => ({ agents: {}, runs: {}, doingTickets: [], returnedTickets: [], waits: {}, piecesWaitingOnYou: pieces })

test('the wide band names the pieces of work that wait on the person, up to three, and the narrow band only counts', () => {
  const pieces = piecesWaitingOnYou(cardsOf(THREE_PIECES, STORIES), NOW, TOUCHED)
  const summary = { needsYou: 3, ready: 3, doing: 1, review: 1 }

  expect(pieces).toEqual(['PAY-57', 'Tidy the settings page', 'PAY-41'])
  expect(bandLine(summary, quietActivity(pieces), 160)).toEqual({
    warnings: '3 tickets need you: PAY-57, Tidy the settings page, PAY-41',
    counts: '3 tickets ready to start, 1 stopped, 1 being checked',
  })
  expect(bandLine({ ...summary, needsYou: 4 }, quietActivity([...pieces, 'PAY-90']), 160).warnings).toBe(
    '4 tickets need you: PAY-57, Tidy the settings page, PAY-41 and 1 more',
  )
  expect(bandLine({ ...summary, needsYou: 2 }, quietActivity(['PAY-41', 'PAY-57']), 120).warnings).toBe('2 tickets need you: PAY-41, PAY-57')
  expect(bandLine(summary, quietActivity(pieces), 30)).toEqual({ warnings: '3 need you', counts: '' })
})

const waitingIn = (id: string, fields: Parameters<typeof newTicket>[1]): Ticket => ticketOf(id, { title: `Question in ${id}`, ...fields, ...asking(`Go ahead with ${id}?`) })

const bandWarningsFor = (tickets: readonly Ticket[], stories: readonly Story[]): string => {
  const cards = cardsOf(tickets, stories, new Set())
  const needsYou = cards.filter(card => card.status === 'needs-you').length
  const activity = quietActivity(piecesWaitingOnYou(cards, NOW, new Set()))

  return bandLine({ needsYou, ready: 0, doing: 0, review: 0 }, activity, 200).warnings
}

const LONG_STORY = newStory('LA-S4', 'Let people export every report they can see as a spreadsheet', STAMP)

test('the band names every ticket it counts, the ones of no piece as other tickets, and nothing when all are of one piece', () => {
  const refunds = waitingIn('LA-1', REFUNDS)
  const ledger = waitingIn('LA-2', { story: 'LA-S2' })
  const loose = waitingIn('LA-3', {})

  expect(bandWarningsFor([refunds, ledger, loose], STORIES)).toBe('3 tickets need you: PAY-41, PAY-57, other tickets')
  expect(bandWarningsFor([refunds, loose], STORIES)).toBe('2 tickets need you: PAY-41, other tickets')
  expect(bandWarningsFor([refunds, waitingIn('LA-4', REFUNDS)], STORIES)).toBe('2 tickets need you')
  expect(bandWarningsFor([waitingIn('LA-5', { story: 'LA-S4' }), ledger], [...STORIES, LONG_STORY])).toBe(
    '2 tickets need you: PAY-57, Let people export every rep...',
  )
})

test('under a heading a pane row shows the key, branch and pull request the heading does not, and the heading branch is the whole piece', () => {
  const stories = [newStory('LA-S1', 'Refunds can be partial', STAMP), newStory('LA-S2', 'Tidy the settings page', STAMP)]
  const tickets = [
    ticketOf('LA-1', { title: 'Keep the refunded amount', story: 'LA-S1', issue: 'PAY-41', branch: 'refunds', ...asking('Round to cents?') }),
    ticketOf('LA-2', { title: 'Show the refund', story: 'LA-S1', issue: 'PAY-42', branch: 'refunds', pullRequest: 'https://example.test/pull/12' }),
    ticketOf('LA-3', { title: 'The old refund page', story: 'LA-S1', issue: 'PAY-41', branch: 'old-refunds', status: 'parked' }),
    ticketOf('LA-4', { title: 'Move the toggles', story: 'LA-S2', branch: 'settings', ...asking('Keep the old toggles?') }),
    ticketOf('LA-5', { title: 'Drop the old tab', story: 'LA-S2', branch: 'settings' }),
  ]
  const touched = new Set(['LA-1'])
  const lines = boardPaneLines({ ...contentOf(cardsOf(tickets, stories, touched), touched), running: [] })

  expect(paneLinesAsText(lines)).toBe(
    [
      'Nothing is running.',
      '',
      'PAY-41 Refunds can be partial',
      '  waits on you: Round to cents?  recommended: Yes  LA-1, branch refunds',
      '  next: Show the refund  PAY-42, LA-2, branch refunds, pull request #12',
      '',
      'Tidy the settings page (branch settings)',
      '  waits on you: Keep the old toggles?  recommended: Yes  LA-4',
      '  next: Drop the old tab  LA-5',
      '',
      'Also on the board: 1 set aside',
    ].join('\n'),
  )
})
