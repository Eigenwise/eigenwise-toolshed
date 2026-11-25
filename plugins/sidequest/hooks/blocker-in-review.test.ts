import { expect, test } from 'claude-code/testing'

import { DEFAULT_BOARD_CONFIG } from './board-config'
import type { BoardConfig } from './board-config'
import { blockerWaits, readyWaits } from './blocked-work'
import { frontierOf } from './frontier'
import { alongsideNote, whatCanMoveText, whatThePersonCouldDo } from './what-can-move'
import { newTicket } from './tickets'
import type { Ticket } from './tickets'

const STAMP = '2026-11-16T10:02Z'
const ticket = (id: string, fields: Partial<Ticket>): Ticket => ({ ...newTicket(id, {}, STAMP), title: id, ...fields })

const reviewedBlocker = (lastReviewNote: string, fields: Partial<Ticket> = {}): Ticket =>
  ticket('SQ-1', { status: 'review', branch: 'work/shared', log: [`${STAMP} note ${lastReviewNote}`], ...fields })

const blockedTicket = (fields: Partial<Ticket> = {}): Ticket => ticket('SQ-2', { blockedBy: ['SQ-1'], branch: 'work/shared', ...fields })

const frontierIds = (tickets: Ticket[], worktrees = true): string[] => frontierOf(tickets, worktrees).map(item => item.id)

for (const lastReviewNote of ['review pass: nothing found', 'review skipped: the ticket said review false']) {
  test(`a blocker in review with "${lastReviewNote}" lets a ticket start when worktrees are off`, () => {
    const tickets = [reviewedBlocker(lastReviewNote), blockedTicket()]

    expect(frontierIds(tickets, false)).toEqual(['SQ-2'])
    expect(blockerWaits(tickets[1]!, tickets, false)).toEqual([])
    expect(readyWaits(tickets, true, false)).toEqual([])
  })
}

test('a reviewed blocker on the same branch with worktrees on still blocks, and the words say it is in review', () => {
  const tickets = [reviewedBlocker('review pass: fine'), blockedTicket()]

  expect(frontierIds(tickets)).toEqual([])
  expect(blockerWaits(tickets[1]!, tickets)).toEqual([{ ticketId: 'SQ-2', words: 'waits for SQ-1, which is in review, and only counts once it lands' }])
})

test('a reviewed blocker counts when worktrees are off, even on another branch', () => {
  const tickets = [reviewedBlocker('review pass: fine'), blockedTicket({ branch: 'work/other' })]

  expect(frontierIds(tickets, false)).toEqual(['SQ-2'])
  expect(blockerWaits(tickets[1]!, tickets, false)).toEqual([])
})

test('a blocker in review with a failed or missing review still blocks', () => {
  const failed = [reviewedBlocker('review fail: broken'), blockedTicket()]
  const unreviewed = [reviewedBlocker('review pass: x', { log: [] }), blockedTicket()]

  expect(frontierIds(failed, false)).toEqual([])
  expect(frontierIds(unreviewed, false)).toEqual([])
  expect(blockerWaits(failed[1]!, failed, false)).toHaveLength(1)
})

for (const failureWord of ['fail', 'failed', 'failure']) {
  test(`a "review ${failureWord}" note after an earlier pass blocks when worktrees are off`, () => {
    const lastNote = `review ${failureWord}: broken after the pass`
    const passThenFail = reviewedBlocker(lastNote, { log: [`${STAMP} note review pass: ok`, `${STAMP} note ${lastNote}`] })

    expect(frontierIds([passThenFail, blockedTicket()], false)).toEqual([])
  })
}

test('only the last review note counts: a pass after a fail lets the ticket start, a fail after a pass does not', () => {
  const failThenPass = reviewedBlocker('review pass: fixed', { log: [`${STAMP} note review fail: x`, `${STAMP} note review pass: fixed`] })
  const passThenFail = reviewedBlocker('review fail: x', { log: [`${STAMP} note review pass: ok`, `${STAMP} note review fail: x`] })

  expect(frontierIds([failThenPass, blockedTicket()], false)).toEqual(['SQ-2'])
  expect(frontierIds([passThenFail, blockedTicket()], false)).toEqual([])
})

test('a blocker that is doing still blocks even with worktrees off', () => {
  expect(frontierIds([reviewedBlocker('review pass: x', { status: 'doing' }), blockedTicket()], false)).toEqual([])
})

const WITH_TESTER: BoardConfig = {
  ...DEFAULT_BOARD_CONFIG,
  settings: { ...DEFAULT_BOARD_CONFIG.settings, shared: { tester: { what: 'the tester', refresh: 'auto' } } },
}

test('the person is never offered a done ticket to try by hand', () => {
  const tickets = [ticket('SQ-1', { status: 'done', kind: 'research', title: 'Compare the options' })]

  expect(whatThePersonCouldDo(tickets)).toEqual([])
  expect(whatCanMoveText(tickets, DEFAULT_BOARD_CONFIG, STAMP)).not.toContain('Try by hand')
})

const OFFER_SENTENCE = 'start only what they pick'

test('the start answer leaves out the offer sentence when nothing could be picked', () => {
  const started = ticket('SQ-1', { status: 'doing', uses: ['tester'] })

  expect(alongsideNote(started, [started], WITH_TESTER)).not.toContain(OFFER_SENTENCE)
})

test('the start answer keeps the offer sentence when something else could start', () => {
  const started = ticket('SQ-1', { status: 'doing', uses: ['tester'] })

  expect(alongsideNote(started, [started, ticket('SQ-2', {})], WITH_TESTER)).toContain(OFFER_SENTENCE)
})
