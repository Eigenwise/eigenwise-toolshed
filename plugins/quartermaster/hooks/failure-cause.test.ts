import { expect, test } from 'claude-code/testing'

import { causeOf, evidenceToolRefusal, ownToolRefusal } from './failure-cause'

test('the evidence refusal names the events folder and the cause', () => {
  expect(evidenceToolRefusal('/home/.claude/quartermaster/events/repo', 'unreadable')).toBe(
    'quartermaster: the evidence tool failed; read the event files directly in /home/.claude/quartermaster/events/repo (unreadable)',
  )
})

test('with no folder known the evidence refusal still says where to look', () => {
  expect(evidenceToolRefusal(undefined, 'unreadable')).toContain('directly in the events folder (unreadable)')
})

test('a refusal without a cause adds no parentheses', () => {
  expect(ownToolRefusal('a subagent cannot write')).toBe('quartermaster: a subagent cannot write')
})

test('a timeout has no message, so the kind is the cause, and a long one is cut', () => {
  expect(causeOf({ kind: 'timeout', budget: 500 })).toBe('timeout')
  expect(causeOf({ kind: 'throw', message: 'x'.repeat(900), budget: 500 }).length).toBe(300)
})
