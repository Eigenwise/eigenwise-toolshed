import { expect, test } from 'claude-code/testing'

import { isForYouInput, parseForYou, withForYouInput } from './for-you'
import { newTicket } from './tickets'

const STAMP = '2026-11-24T10:02Z'

test('an option given as a plain string "Label: what it does" is accepted and read as its label and what it gets', () => {
  const given = { question: 'Ship it?', options: ['Ship: the fix reaches users today', { label: 'Wait', gets: 'one more review', costs: 'a day' }] }
  const ticket = withForYouInput(newTicket('SQ-1', { title: 'Ship' }, STAMP), given)

  expect(isForYouInput(given)).toBe(true)
  expect(parseForYou(ticket.forYou).options).toEqual([
    { label: 'Ship', gets: 'the fix reaches users today', costs: '' },
    { label: 'Wait', gets: 'one more review', costs: 'a day' },
  ])
})

test('what the session left to the person is kept on the For you part and read back', () => {
  const alsoYours = [{ what: 'Rename the retry flag', doneByDefault: 'left as it is' }, 'Log each retry']
  const ticket = withForYouInput(newTicket('SQ-1', { title: 'Ship' }, STAMP), { question: 'Ship it?', alsoYours })

  expect(ticket.forYou).toContain('Also yours:\n- Rename the retry flag (if you say nothing: left as it is)\n- Log each retry')
  expect(parseForYou(ticket.forYou).alsoYours).toEqual([
    { what: 'Rename the retry flag', doneByDefault: 'left as it is' },
    { what: 'Log each retry', doneByDefault: '' },
  ])
})
