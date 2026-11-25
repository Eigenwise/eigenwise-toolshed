import { expect, test } from 'claude-code/testing'

import { newTicket } from './tickets'
import type { Ticket } from './tickets'
import { waitingText } from './waiting-view'

const NOW = Date.parse('2026-11-22T10:00:00Z')

const waitingTicket = (id: string, title: string, stamp: string): Ticket => ({
  ...newTicket(id, { title, status: 'needs-you', mode: 'hitl', forYou: `Question: What about ${title}?` }, stamp),
  log: [],
})

const OLD_QUESTION = waitingTicket('SQ-3', 'Two things from outside', '2026-11-10T09:00Z')
const NEW_QUESTION = waitingTicket('SQ-40', 'Pick the limit', '2026-11-22T09:00Z')

test('a question this session did not touch and that waited a week comes after, as one line', () => {
  const text = waitingText([OLD_QUESTION, NEW_QUESTION], undefined, NOW, new Set(['SQ-40']))

  expect(text).toContain('\n\nWhat about Pick the limit?')
  expect(text).not.toContain('What about Two things from outside?')
  expect(text.endsWith('Still waiting on you from earlier sessions:\n- SQ-3 Two things from outside, waiting 12 days. To answer in this chat: ask for ticket SQ-3, then answer it.')).toBe(true)
  expect(text.indexOf('Pick the limit')).toBeLessThan(text.indexOf('Still waiting on you from earlier sessions:'))
})

test('when this session touched nothing that waits, the view is what it always was', () => {
  const asBefore = waitingText([OLD_QUESTION, NEW_QUESTION], undefined, NOW)

  expect(waitingText([OLD_QUESTION, NEW_QUESTION], undefined, NOW, new Set(['SQ-99']))).toBe(asBefore)
  expect(asBefore).toContain('1. What about Two things from outside?')
  expect(asBefore).not.toContain('Still waiting on you from earlier sessions:')
})
