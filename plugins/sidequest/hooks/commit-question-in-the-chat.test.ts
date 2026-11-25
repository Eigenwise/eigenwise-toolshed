import { expect, test } from 'claude-code/testing'

import { afterTheReviewPointer, commitQuestionOf } from './commit-question-in-the-chat'
import { newTicket } from './tickets'
import type { WaitingAround } from './waiting-view'

const STAMP = '2026-11-24T10:02Z'
const AROUND: WaitingAround = { stories: [], touched: new Set() }

const ticketWith = (...lines: string[]) => ({ ...newTicket('SQ-1', { title: 'Retry uploads' }, STAMP), log: lines.map(line => `${STAMP} ${line}`) })

const pointerFor = (...lines: string[]): string => {
  const ticket = ticketWith(...lines)

  return afterTheReviewPointer(commitQuestionOf(ticket, [ticket], AROUND).reviewPassed)
}

test('the chat pointer says the review passed after a pass and after a reviewed fix', () => {
  expect(pointerFor('note review pass: as asked')).toMatch(/^The review passed:/)
  expect(pointerFor('note review fail: a field is missing', 'returned review run after 2m, agent a1b2', 'note review pass: gone')).toMatch(/^The review passed:/)
})

test('the chat pointer never says the review passed when no reviewer read the fix', () => {
  expect(pointerFor('note review fail: a field is missing', 'note review pass: fixed it myself')).toMatch(/^The review is back:/)
  expect(pointerFor('note review fail: a field is missing', 'note review fixed: added the field')).toMatch(/^The review is back:/)
  expect(pointerFor('note review fail: a field is missing')).toMatch(/^The review is back:/)
})
