import { expect, test } from 'claude-code/testing'

import { briefFor } from './brief'
import { EARLIER_BOARD_IDS } from './board-ids'
import { ANSWER_CHARACTER_CAP, ANSWER_COUNT_CAP } from './earlier-run'
import { routeRequestIn } from './routing'
import { newTicket } from './tickets'
import type { Ticket } from './tickets'

const STAMP = '2026-11-16T10:02Z'
const ticketWithLog = (log: string[]): Ticket => ({ ...newTicket('SQ-1', { title: 'Retry uploads' }, STAMP), log })
const answer = (words: string): string => `${STAMP} answered by human in the board: ${words}`
const note = (words: string): string => `${STAMP} note ${words}`

test('a ticket with no earlier run gets the same brief as before', () => {
  const brief = briefFor(ticketWithLog([`${STAMP} created`]))

  expect(brief).not.toContain('## Earlier run')
  expect(brief).not.toContain('What the person answered')
})

test('one answer from the person reaches the brief in their own words', () => {
  const brief = briefFor(ticketWithLog([answer('Use option B, keep the old name.')]))

  expect(brief).toContain('## What the person answered')
  expect(brief).toContain('- Use option B, keep the old name.')
})

test('two answers come oldest first', () => {
  const brief = briefFor(ticketWithLog([answer('first word'), answer('second word')]))

  expect(brief.indexOf('- first word')).toBeLessThan(brief.indexOf('- second word'))
})

test('five failures of mixed kinds carry the newest in full and one line counting the rest', () => {
  const brief = briefFor(
    ticketWithLog([
      note('review fail: one'),
      note('verify fail: two'),
      note('ci fail: three'),
      note('review fail: four'),
      note('verify fail: five, the typecheck is red in two files'),
    ]),
  )

  expect(brief).toContain('The verify that sent it back:\nverify fail: five, the typecheck is red in two files')
  expect(brief).toContain('It failed 4 times before this (review fail, verify fail, ci fail).')
  expect(brief).not.toContain('fail: two')
})

test('a failure that a later review pass answered is not carried', () => {
  const brief = briefFor(ticketWithLog([note('verify fail: red'), note('review pass: fixed')]))

  expect(brief).not.toContain('sent it back')
})

test('a long log carries only the newest answers, each cut, and says what was left out', () => {
  const total = ANSWER_COUNT_CAP + 2
  const answers = Array.from({ length: total }, (_, index) => answer(`answer-${index}`))
  const longAnswer = answer('x'.repeat(ANSWER_CHARACTER_CAP + 50))
  const brief = briefFor(ticketWithLog([...answers, longAnswer]))

  expect(brief).not.toContain('answer-0')
  expect(brief).toContain(`answer-${total - 1}`)
  expect(brief).toContain('3 oldest answers left out')
  expect(brief).toContain(`${'x'.repeat(ANSWER_CHARACTER_CAP)} ...(cut)`)
  expect(brief).not.toContain('x'.repeat(ANSWER_CHARACTER_CAP + 1))
})

test('a route tag counts at the start, after a leading ticket ref and in the description, and not quoted in the body', () => {
  expect(routeRequestIn('[route:review] check it', '', EARLIER_BOARD_IDS)).toEqual({ category: 'review' })
  expect(routeRequestIn('SQ-12 [route:review] check it', '', EARLIER_BOARD_IDS)).toEqual({ ticket: 'SQ-12', category: 'review' })
  expect(routeRequestIn('look around', 'a look [route:explore]', EARLIER_BOARD_IDS)).toEqual({ category: 'explore' })
  expect(routeRequestIn('Ticket SQ-12: Fix it\n\n## What\nThe tag [route:review] is read.', '', EARLIER_BOARD_IDS)).toEqual({ ticket: 'SQ-12' })
  expect(routeRequestIn('look at this [route:review]', '', EARLIER_BOARD_IDS)).toBe(undefined)
})
