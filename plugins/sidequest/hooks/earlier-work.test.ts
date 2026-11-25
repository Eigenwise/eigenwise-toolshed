import { expect, test } from 'claude-code/testing'

import type { BoardCard } from '../types'
import { DEFAULT_BOARD_CONFIG } from './board-config'
import { summarize } from './summary'
import { newTicket } from './tickets'
import type { Ticket } from './tickets'
import { bandCounts, bandLine, bandWarnings, boardCards, oldestWaitingOf } from './views/board-view'
import { boardPaneLines, paneLinesAsText } from './views/pane-sections'
import type { PaneContent } from './views/pane-sections'

const NOW = Date.parse('2026-11-23T10:00:00Z')
const DAY = 24 * 60 * 60 * 1000

const stampAgo = (milliseconds: number): string => new Date(NOW - milliseconds).toISOString().slice(0, 16) + 'Z'

const ticketOf = (id: string, title: string, status: string, age: number): Ticket => ({
  ...newTicket(id, { title, status, mode: status === 'needs-you' ? 'hitl' : 'afk', forYou: status === 'needs-you' ? `Question: What about ${title}?` : '' }, stampAgo(age)),
  log: [`${stampAgo(age)} moved to ${status}`],
})

const paneFor = (tickets: readonly Ticket[], touchedHere: ReadonlySet<string>): PaneContent => ({
  cards: boardCards(tickets, DEFAULT_BOARD_CONFIG),
  running: [],
  sessionWork: { isWorking: false, steps: 0 },
  finishedAgents: [],
  worktreeCount: 0,
  touchedHere,
  showsIntro: false,
  columns: 80,
  now: NOW,
  whatYouCouldDo: [],
})

const noActivity = { agents: {}, runs: {}, waits: {}, doingTickets: [], returnedTickets: [] }

const OLD_DONE = [1, 2, 3].map(number => ticketOf(`SQ-${number}`, `Older ${number}`, 'done', 5 * DAY))
const OLD_QUESTION = ticketOf('SQ-9', 'Pick the limit', 'needs-you', 4 * DAY)
const NEW_QUESTION = ticketOf('SQ-10', 'Pick the name', 'needs-you', DAY / 24)

test('done tickets this session never touched draw no Done section, and one it finishes is the only one listed', () => {
  expect(paneLinesAsText(boardPaneLines(paneFor(OLD_DONE, new Set())))).not.toContain('Done')

  const text = paneLinesAsText(boardPaneLines(paneFor(OLD_DONE, new Set(['SQ-2']))))

  expect(text).toContain('Done\n  SQ-2 Older 2')
  expect(text).not.toContain('Older 1')
  expect(text).not.toContain('Older 3')
})

test('a waiting ticket untouched here for four days is counted quietly, and a touched or newer one still warns', () => {
  const summary = summarize([OLD_QUESTION], new Set(), NOW)
  const wide = bandLine(summary, noActivity, 120)

  expect(summary.needsYou).toBe(1)
  expect(summary.needsYouFromEarlierWork).toBe(1)
  expect(wide).toEqual({ warnings: '', counts: '1 waiting on you from earlier sessions' })
  expect(bandLine(summarize([OLD_QUESTION, ticketOf('SQ-11', 'Another', 'needs-you', 6 * DAY)], new Set(), NOW), noActivity, 120).counts).toBe('2 waiting on you from earlier sessions')
  expect(bandLine(summary, noActivity, 10)).toEqual({ warnings: '', counts: '' })

  const touched = summarize([OLD_QUESTION], new Set(['SQ-9']), NOW)
  const anHourOld = summarize([NEW_QUESTION], new Set(), NOW)

  expect(bandLine(touched, noActivity, 120)).toEqual({ warnings: '1 ticket needs you', counts: '' })
  expect(bandLine(anHourOld, noActivity, 120).warnings).toBe('1 ticket needs you')
  expect(bandLine(anHourOld, noActivity, 10).warnings).toBe('1 needs you')
})

test('the waiting days in the band are about the tickets that warn, not the ones from earlier work', () => {
  const cards: BoardCard[] = boardCards([OLD_QUESTION, NEW_QUESTION], DEFAULT_BOARD_CONFIG)

  expect(oldestWaitingOf(cards, NOW, new Set())).toBeLessThan(DAY)
  expect(oldestWaitingOf(cards, NOW, new Set(['SQ-9']))).toBe(4 * DAY)
  expect(bandWarnings(summarize([OLD_QUESTION, NEW_QUESTION], new Set(), NOW), noActivity)).toBe('1 ticket needs you')
  expect(bandCounts(summarize([OLD_QUESTION, NEW_QUESTION], new Set(), NOW), noActivity)).toBe('1 waiting on you from earlier sessions')
})

test('the pane lists a four-day-old waiting ticket under From earlier work, after what waits on you', () => {
  const text = paneLinesAsText(boardPaneLines(paneFor([OLD_QUESTION, NEW_QUESTION], new Set())))

  expect(text).toContain('Waits on you\n  SQ-10 What about Pick the name?')
  expect(text).toContain('Waiting on you from earlier sessions\n  SQ-9 What about Pick the limit?')
  expect(text.indexOf('Waits on you')).toBeLessThan(text.indexOf('Waiting on you from earlier sessions'))
  expect(text.split('Waits on you')[1]?.split('Waiting on you from earlier sessions')[0]).not.toContain('SQ-9')
})

test('when this session touched every ticket the band and the pane are as before', () => {
  const tickets = [...OLD_DONE, OLD_QUESTION, NEW_QUESTION]
  const touchedHere = new Set(tickets.map(ticket => ticket.id))
  const summary = summarize(tickets, touchedHere, NOW)
  const text = paneLinesAsText(boardPaneLines(paneFor(tickets, touchedHere)))

  expect(bandLine(summary, noActivity, 120)).toEqual({ warnings: '2 tickets need you', counts: '' })
  expect(text).not.toContain('Waiting on you from earlier sessions')
  expect(text).toContain('Waits on you\n  SQ-9 What about Pick the limit?\n  SQ-10 What about Pick the name?')
  expect(text).toContain('Done\n')
})
