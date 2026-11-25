import { expect, test } from 'claude-code/testing'

import { parseForYou, withForYouInput } from './for-you'
import { newTicket, parseTicket, serializeTicket } from './tickets'
import { waitingText } from './waiting-view'

const STAMP = '2026-11-24T10:02Z'

const DESCRIPTION = '## What changed\n\nA failed upload is retried twice.\n\nSteps: open the upload page\nRecommended: nothing else'
const HUNKS = '@@ -1,3 +1,3 @@\n Options: kept as context\n-  return send(file)\n+  return uploadWithRetry(file)'
const COMMIT_MESSAGE = 'Retry failed uploads twice\n\nA failed send is sent again twice.\n    Indented line kept.'

test('what the person says yes to reads back from the ticket file as it was written, blank lines, headings, indents and look-alike labels kept', () => {
  const given = { question: 'Commit, push and open the pull request?', sayingYesTo: { hunks: HUNKS, commitMessage: COMMIT_MESSAGE, pullRequestDescription: DESCRIPTION } }
  const ticket = withForYouInput(newTicket('SQ-1', { title: 'Retry uploads', status: 'needs-you' }, STAMP), given)

  const readBack = parseForYou(parseTicket(serializeTicket(ticket), 'SQ-1').forYou)

  expect(readBack.question).toBe('Commit, push and open the pull request?')
  expect(readBack.steps).toBe('')
  expect(readBack.recommended).toBe('')
  expect(readBack.sayingYesTo.hunks).toBe(HUNKS)
  expect(readBack.sayingYesTo.commitMessage).toBe(COMMIT_MESSAGE)
  expect(readBack.sayingYesTo.pullRequestDescription).toBe(DESCRIPTION)
  expect(parseTicket(serializeTicket(ticket), 'SQ-1').otherSections).toEqual([])
})

test('the second step of what the person says yes to keeps the first, and a part given again replaces only itself', () => {
  const first = withForYouInput(newTicket('SQ-1', { title: 'Retry uploads' }, STAMP), { sayingYesTo: { changed: '- uploads retry', checked: '41 pass' } })
  const second = withForYouInput(first, { question: 'Commit?', sayingYesTo: { reviewFound: 'Nothing.', checked: '42 pass' } })

  expect(parseForYou(second.forYou).sayingYesTo).toMatchObject({ changed: '- uploads retry', checked: '42 pass', reviewFound: 'Nothing.' })
  expect(parseForYou(second.forYou).question).toBe('Commit?')
})

test('the waiting line names the branch the ticket carries, and a ticket with no branch of its own gets none, whatever is checked out', () => {
  const forYou = 'Question: Commit, push and open the pull request?\nOptions:\n- Yes: it goes out Costs: nothing\nRecommended: A'
  const onItsBranch = { ...newTicket('SQ-1', { title: 'Retry uploads', status: 'needs-you', branch: 'fix/retries' }, STAMP), forYou }
  const withNoBranch = { ...newTicket('SQ-1', { title: 'Retry uploads', status: 'needs-you' }, STAMP), forYou }
  const checkout = { stories: [], checkedOutBranch: 'main' }

  expect(waitingText([onItsBranch], undefined, undefined, undefined, checkout).split('\n').at(-1)).toBe('   To answer in this chat: a letter, like A. Ticket SQ-1 (branch fix/retries).')
  expect(waitingText([withNoBranch], undefined, undefined, undefined, checkout).split('\n').at(-1)).toBe('   To answer in this chat: a letter, like A. Ticket SQ-1.')
})
