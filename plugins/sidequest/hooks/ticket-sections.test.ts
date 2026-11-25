import { expect, test } from 'claude-code/testing'

import { briefFor } from './brief'
import { newTicket, parseTicket, serializeTicket } from './tickets'

const STAMP = '2026-11-24T10:02Z'

test('a heading a session writes inside a ticket field stays in that field, and the brief carries the whole of it', () => {
  const what = 'Retry failed uploads.\n\n## Approach\nWrap send in uploadWithRetry.\n\n## Tests\n- retries twice'
  const ticket = newTicket('SQ-1', { title: 'Retry', what, doneWhen: '- [ ] retried\n## Also\n- [ ] logged', forYou: 'Question: Ship it?\nWhy now: one\n## not a section' }, STAMP)
  const readBack = parseTicket(serializeTicket(ticket), 'SQ-1')

  expect(readBack.what).toContain('### Approach\nWrap send in uploadWithRetry.')
  expect(readBack.what).toContain('### Tests\n- retries twice')
  expect(readBack.doneWhen).toContain('### Also\n- [ ] logged')
  expect(readBack.forYou).toContain('### not a section')
  expect(readBack.otherSections).toEqual([])
  expect(briefFor(readBack)).toContain('### Approach\nWrap send in uploadWithRetry.')
})

test('a ticket file that already holds a section of its own, split off earlier or written by hand, gives it to the brief', () => {
  const written = serializeTicket(newTicket('SQ-2', { title: 'Retry', what: 'Retry failed uploads.', doneWhen: '- [ ] retried' }, STAMP))
  const splitOffEarlier = written.replace('## Done when', '## Approach\nWrap send in uploadWithRetry.\n\n## Done when')
  const readBack = parseTicket(splitOffEarlier, 'SQ-2')

  expect(readBack.otherSections).toEqual([{ heading: 'Approach', text: 'Wrap send in uploadWithRetry.' }])
  expect(readBack.what).toBe('Retry failed uploads.')
  expect(briefFor(readBack)).toContain('## Approach\nWrap send in uploadWithRetry.')
  expect(briefFor(readBack)).toContain('## What\nRetry failed uploads.')
})
