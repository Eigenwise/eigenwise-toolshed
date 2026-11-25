import { expect, test } from 'claude-code/testing'

import { NOTHING_TO_SAY_YES_TO } from '../saying-yes-to'
import { newTicket } from '../tickets'
import { commitSummaryLines, destinationLead, destinationRest, shortQuestion, takenByDefaultRows } from './first-screen'

const STAMP = '2026-11-24T10:02Z'

const PARTS = {
  ...NOTHING_TO_SAY_YES_TO,
  changed: '- uploads: a failed send is retried twice',
  hunks: '+++ b/upload.ts\n@@ -1,1 +1,1 @@\n-  return send(file)\n+  return uploadWithRetry(file)',
  reviewFound: 'Nothing that changes what you read.',
}

test('the commit summary says whether the review passed and the branch, and never a size counted from the shown hunks', () => {
  const reviewed = { ...newTicket('SQ-1', { title: 'Retry uploads', branch: 'fix/retries' }, STAMP), log: [`${STAMP} note review pass: as asked`] }

  expect(commitSummaryLines(reviewed, PARTS)).toEqual(['The review passed.', 'On branch fix/retries.'])
  expect(commitSummaryLines({ ...reviewed, branch: undefined }, PARTS)).toEqual(['The review passed.', '- uploads: a failed send is retried twice'])
})

const firstLineAfter = (...notes: string[]): string | undefined => {
  const ticket = { ...newTicket('SQ-1', { title: 'Retry uploads' }, STAMP), log: notes.map(note => `${STAMP} ${note}`) }

  return commitSummaryLines(ticket, PARTS)[0]
}

const FAILED_ON_FIELD = 'note review fail: a required field is missing from the test payload'
const REVIEWER_RETURN = 'returned review run after 2m, agent a1b2'

test('the first line of the commit question tells where the review stands from the log', () => {
  expect(firstLineAfter('note review pass: as asked')).toBe('The review passed.')
  expect(firstLineAfter(FAILED_ON_FIELD, REVIEWER_RETURN, 'note review pass: gone')).toBe('The review passed on a second read, after a fix.')
  expect(firstLineAfter(FAILED_ON_FIELD)).toBe('The review failed: a required field is missing from the test payload.')
  expect(firstLineAfter('note review skipped: quick')).toBe('The review was skipped.')
})

test('a fix nobody read again never reads as a pass, whether the session wrote a pass or a fixed note', () => {
  const expected = 'The review failed: a required field is missing from the test payload. Fixed after, not reviewed again.'

  expect(firstLineAfter(FAILED_ON_FIELD, 'note review pass: after these fixes nothing of the finding is left')).toBe(expected)
  expect(firstLineAfter(FAILED_ON_FIELD, 'note review fixed: added the field')).toBe(expected)
})

test('the destination leads with its first paragraph and keeps the rest', () => {
  const destination = 'Uploads retry.\n\n**Proof on the real thing:** cut the line.\n\n**Where it ends:** a pull request.'

  expect(destinationLead(destination)).toBe('Uploads retry.')
  expect(destinationRest(destination)).toBe('**Proof on the real thing:** cut the line.\n\n**Where it ends:** a pull request.')
  expect(destinationRest('Uploads retry.')).toBe('')
})

test('what was taken by default is each such decision, its question in short then its answer, without its id or undo', () => {
  const decisions = [
    '- D-1: Retries? Answer: Two Decided by: human',
    '- D-2: Backoff? Answer: `doubling`, from 1 s. Undo: say fixed. Decided by: default',
    '- D-3: Where it ends? Answer: A pull request',
    '  to main Decided by: default',
    '- D-4: Should a bad value be tested through the server as well? Answer: No. The log names the speed that was asked for. Decided by: default',
  ].join('\n')

  expect(takenByDefaultRows(decisions)).toEqual([
    'Backoff? `doubling`, from 1 s.',
    'Where it ends? A pull request to main',
    'Should a bad value be tested through? No. The log names the speed that was asked for.',
  ])
})

test('a question in short is its first clause or about 40 characters, whichever is shorter, ending in its question mark', () => {
  expect(shortQuestion('Bad value tested, or only the good path?')).toBe('Bad value tested?')
  expect(shortQuestion('Who reads the report once the tickets are built and merged?')).toBe('Who reads the report once the tickets?')
  expect(shortQuestion('Retries?')).toBe('Retries?')
})
