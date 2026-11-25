import { expect, test } from 'claude-code/testing'

import { reviewReadsAsPassed, reviewStandingLine, reviewStandingOf } from './review-standing'
import { newTicket } from './tickets'

const STAMP = '2026-11-24T10:02Z'
const FAIL = 'note review fail: a required field is missing from the test payload, plus two style points'
const REVIEWER_RETURN = 'returned review run after 2m, agent a1b2'

const ticketWith = (...lines: string[]) => ({ ...newTicket('SQ-1', { title: 'Retry uploads' }, STAMP), log: lines.map(line => `${STAMP} ${line}`) })

test('a pass with no fail before it passed', () => {
  const ticket = ticketWith('note review pass: as asked')

  expect(reviewStandingLine(ticket)).toBe('The review passed.')
  expect(reviewReadsAsPassed(ticket)).toBe(true)
})

test('a pass after a fail with a reviewer returned between them passed on a second read', () => {
  const ticket = ticketWith(FAIL, 'note review fixed: added the field', REVIEWER_RETURN, 'note review pass: the finding is gone')

  expect(reviewStandingLine(ticket)).toBe('The review passed on a second read, after a fix.')
  expect(reviewReadsAsPassed(ticket)).toBe(true)
})

test('a pass only the session wrote after a fail is a fix nobody read again', () => {
  const ticket = ticketWith(FAIL, 'note review pass: after these fixes nothing of the finding is left')

  expect(reviewStandingLine(ticket)).toBe(
    'The review failed: a required field is missing from the test payload, plus two style points. Fixed after, not reviewed again.',
  )
  expect(reviewReadsAsPassed(ticket)).toBe(false)
})

test('a review fixed note after a fail is a fix nobody read again', () => {
  const ticket = ticketWith(FAIL, 'note review fixed: added the field and renamed two things')

  expect(reviewStandingOf(ticket).kind).toBe('fixed-without-second-read')
  expect(reviewStandingLine(ticket)).toMatch(/^The review failed: .*\. Fixed after, not reviewed again\.$/)
  expect(reviewReadsAsPassed(ticket)).toBe(false)
})

test('a reviewer that was cut off does not count as a second read', () => {
  const ticket = ticketWith(FAIL, 'returned review run, interrupted after 10s, agent a1b2', 'note review pass: fixed it myself')

  expect(reviewStandingOf(ticket).kind).toBe('fixed-without-second-read')
})

test('a reviewer returned before the fail does not count as a second read', () => {
  const ticket = ticketWith(REVIEWER_RETURN, FAIL, 'note review pass: fixed it myself')

  expect(reviewStandingOf(ticket).kind).toBe('fixed-without-second-read')
})

test('a fail with nothing after it failed, and a long finding is cut to one line', () => {
  const long = `note review fail: ${'the retry count is never reset '.repeat(8)}`

  expect(reviewStandingLine(ticketWith(FAIL))).toBe('The review failed: a required field is missing from the test payload, plus two style points.')
  expect(reviewStandingLine(ticketWith(long))).toMatch(/^The review failed: the retry count is never reset .*[^.]\.\.\.$/)
  expect(reviewReadsAsPassed(ticketWith(FAIL))).toBe(false)
})

test('a skipped review says so, and no review says nothing', () => {
  expect(reviewStandingLine(ticketWith('note review skipped: quick'))).toBe('The review was skipped.')
  expect(reviewStandingLine(ticketWith('started by the session'))).toBe('')
  expect(reviewReadsAsPassed(ticketWith('note review skipped: quick'))).toBe(false)
})

test('a reviewer returned after the pass does not make the pass a second read', () => {
  const ticket = ticketWith(FAIL, 'note review pass: fixed it myself', REVIEWER_RETURN)

  expect(reviewStandingOf(ticket).kind).toBe('fixed-without-second-read')
  expect(reviewReadsAsPassed(ticket)).toBe(false)
})

test('a fail note without a colon is drawn from its finding alone', () => {
  expect(reviewStandingLine(ticketWith('note review fail on one point, with six runs'))).toBe('The review failed: on one point, with six runs.')
  expect(reviewStandingLine(ticketWith('note review fail, from reading the diff'))).toBe('The review failed: from reading the diff.')
  expect(reviewStandingLine(ticketWith('note review fail (second): five of seven points'))).toBe('The review failed: five of seven points.')
  expect(reviewStandingLine(ticketWith('note review fail - the field is missing'))).toBe('The review failed: the field is missing.')
  expect(reviewStandingLine(ticketWith('note review fail. On one system the path breaks'))).toBe('The review failed: On one system the path breaks.')
  expect(reviewStandingLine(ticketWith('note review fail (second):'))).toBe('The review failed.')
})

test('a finding that ends in a question keeps its own ending', () => {
  expect(reviewStandingLine(ticketWith('note review fail: is the field required?'))).toBe('The review failed: is the field required?')
})

test('a finding whose sentence ends right where it is cut ends in three dots, never four', () => {
  const endsAtTheCut = 'note review fail: the required field is missing from the test payload and the retry count is never reset. Two style points are open.'

  expect(reviewStandingLine(ticketWith(endsAtTheCut))).toBe(
    'The review failed: the required field is missing from the test payload and the retry count is never reset...',
  )
})

test('a fix noted after the reviewer returned was not read by that reviewer', () => {
  const ticket = ticketWith(FAIL, REVIEWER_RETURN, 'note review fixed: one more change', 'note review pass: fixed it myself')

  expect(reviewStandingOf(ticket).kind).toBe('fixed-without-second-read')
  expect(reviewReadsAsPassed(ticket)).toBe(false)
})

test('a cut finding ends in three dots only, also when a fix after it was not read again', () => {
  const long = `note review fail: ${'the retry count is never reset '.repeat(8)}`

  expect(reviewStandingLine(ticketWith(long, 'note review fixed: done'))).toMatch(/[^.]\.\.\. Fixed after, not reviewed again\.$/)
})
