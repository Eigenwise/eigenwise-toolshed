import { expect, test } from 'claude-code/testing'

import { DEFAULT_BOARD_CONFIG } from './board-config'
import { briefFor } from './brief'
import { newTicket } from './tickets'
import type { Ticket } from './tickets'

const STAMP = '2026-11-22T10:02Z'
const HEADING = '## Start from the work this builds on'
const ticketWith = (fields: Partial<Ticket>): Ticket => ({ ...newTicket('SQ-2', { title: 'Second slice' }, STAMP), ...fields })
const isolatedRun = { config: DEFAULT_BOARD_CONFIG, isIsolated: true, branchToMerge: 'integration-one' }

test('an isolated run for a blocked ticket is told to merge the branch the board was on first', () => {
  const brief = briefFor(ticketWith({ blockedBy: ['SQ-1'] }), undefined, undefined, isolatedRun)

  expect(brief).toContain(HEADING)
  expect(brief).toContain('run `git merge integration-one`')
})

test('an isolated run for a ticket in a story is told to merge the branch first', () => {
  const brief = briefFor(ticketWith({ story: 'ST-1' }), undefined, undefined, isolatedRun)

  expect(brief).toContain('run `git merge integration-one`')
})

test('no branch to merge means no merge section', () => {
  const brief = briefFor(ticketWith({ blockedBy: ['SQ-1'] }), undefined, undefined, { ...isolatedRun, branchToMerge: undefined })

  expect(brief).not.toContain(HEADING)
})

test('a ticket with no blockers and no story gets no merge section', () => {
  const brief = briefFor(ticketWith({ branch: 'integration-one' }), undefined, undefined, isolatedRun)

  expect(brief).not.toContain(HEADING)
})

test('a run without its own worktree gets no merge section', () => {
  const blockedTicket = ticketWith({ blockedBy: ['SQ-1'] })

  expect(briefFor(blockedTicket, undefined, undefined, { ...isolatedRun, isIsolated: false })).not.toContain(HEADING)
  expect(briefFor(blockedTicket)).not.toContain(HEADING)
})

test('a run in a folder with no git gets no merge section', () => {
  const brief = briefFor(ticketWith({ blockedBy: ['SQ-1'] }), undefined, undefined, isolatedRun, undefined, '/work/projects')

  expect(brief).not.toContain(HEADING)
  expect(brief).toContain('## No git here')
})
