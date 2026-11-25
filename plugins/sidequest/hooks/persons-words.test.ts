import { expect, test } from 'claude-code/testing'

import { briefFor, PERSONS_WORDS_RULE } from './brief'
import { newTicket } from './tickets'
import type { Ticket } from './tickets'

const STAMP = '2026-11-23T10:02Z'
const ticketWith = (fields: Partial<Ticket>): Ticket => ({ ...newTicket('SQ-2', { title: 'Second slice' }, STAMP), ...fields })

test('a check the person worded is carried with the rule that it is met as written', () => {
  const brief = briefFor(ticketWith({ doneWhen: "- [ ] In the person's words: a row whose number matches but whose name is new is kept" }))

  expect(brief).toContain("In the person's words: a row whose number matches but whose name is new is kept")
  expect(brief).toContain(PERSONS_WORDS_RULE)
})

test('a ticket with no such line gets the brief it always got', () => {
  const brief = briefFor(ticketWith({ doneWhen: '- [ ] the list keeps its order' }))

  expect(brief).toContain('## Done when\n- [ ] the list keeps its order')
  expect(brief).not.toContain(PERSONS_WORDS_RULE)
})
