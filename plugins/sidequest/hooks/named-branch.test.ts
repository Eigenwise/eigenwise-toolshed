import { expect, test } from 'claude-code/testing'

import { DEFAULT_BOARD_CONFIG } from './board-config'
import { answerBoardView } from './board-tool'
import { finishBranchToken } from './earlier-run'
import { leftoversOf, noLeftoversNote } from './drop'
import { baseBranchOf } from './register-interrupted'
import { NO_PROVIDERS } from './routing'
import { finishTicket, startTicket } from './run-tools'
import type { BoardFiles } from './store'
import { newTicket } from './tickets'
import type { Ticket } from './tickets'

const STAMP = '2026-11-22T10:02Z'
const MERGE_HEADING = '## Start from the work this builds on'
const ticketWith = (fields: Partial<Ticket>): Ticket => ({ ...newTicket('SQ-2', { title: 'Second slice' }, STAMP), ...fields })

const filesFor = (tickets: Ticket[], checkedOutBranch: string | undefined, verify = ''): BoardFiles => ({
  config: { ...DEFAULT_BOARD_CONFIG, settings: { ...DEFAULT_BOARD_CONFIG.settings, verify } },
  configText: undefined,
  tickets,
  stories: [],
  ...(checkedOutBranch === undefined ? {} : { checkedOutBranch }),
})

const briefOfStart = (files: BoardFiles, hasRemote: boolean): string => {
  const answer = startTicket({ id: 'SQ-2' }, files, NO_PROVIDERS, STAMP, { hasRemote }).answer

  return 'text' in answer ? answer.text : answer.refusal
}

const storyTicket = ticketWith({ story: 'ST-1', branch: 'integration-not-made-yet' })

test('a story ticket whose branch is not checked out is told to merge the checked-out branch', () => {
  const text = briefOfStart(filesFor([storyTicket], 'main'), true)

  expect(text).toContain(MERGE_HEADING)
  expect(text).toContain('run `git merge main`')
  expect(text).not.toContain('git merge integration-not-made-yet')
})

test('no merge section when the repository has no remote or the checkout is on no branch', () => {
  expect(briefOfStart(filesFor([storyTicket], 'main'), false)).not.toContain(MERGE_HEADING)
  expect(briefOfStart(filesFor([storyTicket], undefined), true)).not.toContain(MERGE_HEADING)
})

const finishedOn = (branch: string | undefined): Ticket => {
  const ticket = ticketWith({ branch: 'main', status: 'doing' })
  const input = { id: 'SQ-2', outcome: 'done', result: 'Built.', checked: 'npm test exit 0', ...(branch === undefined ? {} : { branch }) }
  const existingBranch = branch === undefined ? undefined : finishBranchToken(branch)
  const { change } = finishTicket(input, filesFor([ticket], 'main'), STAMP, { overlaps: [], saidPairs: new Set(), existingBranch })

  return change?.tickets[0] ?? ticket
}

test('finish given a named branch sets the ticket branch and the list names it', () => {
  const finished = finishedOn('feature/second-slice')
  const list = answerBoardView({ view: 'list' }, filesFor([finished], 'main'), STAMP)

  expect(finished.branch).toBe('feature/second-slice')
  expect('text' in list ? list.text : '').toContain('branch feature/second-slice')
})

test('a closing line names the tracker key once, the title without it, the status the ticket ended in and its pull request', () => {
  const keyed = ticketWith({ issue: 'NOTE-212', title: 'NOTE-212 Search can include archived notes', branch: 'NOTE-212_archived-search', pullRequest: '#1', status: 'done' })
  const keyless = ticketWith({ title: 'Search can include archived notes', pullRequest: 'https://example.test/pulls/1', status: 'done' })
  const closingOf = (ticket: Ticket): string => {
    const closing = answerBoardView({ view: 'closing' }, filesFor([ticket], 'main'), STAMP, undefined, undefined, new Map([['SQ-2', 'needs-you']]))

    return 'text' in closing ? closing.text : ''
  }

  expect(closingOf(keyed)).toBe('What this session changed on the board:\n- NOTE-212 SQ-2 Search can include archived notes: done (pull request #1)')
  expect(closingOf(keyless)).toBe('What this session changed on the board:\n- SQ-2 Search can include archived notes: done (pull request #1)')
})

test('finish given a branch the host named leaves the ticket branch alone', () => {
  expect(finishedOn('worktree-agent-abc').branch).toBe('main')
})

test('after a finish on a named branch the resume base is the checked-out branch and a drop says the branch stays', () => {
  const finished = finishedOn('feature/second-slice')

  expect(baseBranchOf(finished, filesFor([finished], 'main'))).toBe('main')
  expect(baseBranchOf(ticketWith({ branch: 'release' }), filesFor([], 'main'))).toBe('release')
  expect(leftoversOf(finished, 'main')).toBeUndefined()
  expect(noLeftoversNote(finished, 'main')).toBe('SQ-2 keeps its branch feature/second-slice and any worktree on it: it is not a host-named branch, so the tidy skill shows it before anything is removed.')
  expect(noLeftoversNote(finished, 'feature/second-slice')).toBe('SQ-2 had no branch or worktree of its own.')
  expect(noLeftoversNote(ticketWith({}), 'main')).toBe('SQ-2 had no branch or worktree of its own.')
})

const verifyWordsAfterFinish = (kind: string): string => {
  const ticket = ticketWith({ kind, status: 'doing' })
  const answer = finishTicket({ id: 'SQ-2', outcome: 'done', result: 'Done.', checked: 'ran it' }, filesFor([ticket], 'main'), STAMP).answer

  return 'text' in answer ? answer.text : answer.refusal
}

test('finish says no verify command is set for a build ticket and not for a research ticket', () => {
  expect(verifyWordsAfterFinish('build')).toContain('No verify command is set')
  expect(verifyWordsAfterFinish('research')).not.toContain('verify')
})
