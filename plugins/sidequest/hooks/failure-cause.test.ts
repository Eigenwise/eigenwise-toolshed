import { expect, test } from 'claude-code/testing'

import { boardToolRefusal, causeOf } from './failure-cause'

test('a refusal carries the cause and still names the board files', () => {
  const refusal = boardToolRefusal('disk full')

  expect(refusal).toContain('could not read or write the board just now (disk full)')
  expect(refusal).toContain('board.json, tickets/<id>.md')
})

test('a timeout has no message, so the kind is the cause', () => {
  expect(causeOf({ kind: 'timeout', budget: 500 })).toBe('timeout')
})

test('a long message is cut at 300 characters', () => {
  expect(causeOf({ kind: 'throw', message: 'x'.repeat(900), budget: 500 }).length).toBe(300)
})
