import { expect, test } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

import { DEFAULT_BOARD_CONFIG } from './board-config'
import { otherBranchLines } from './branch-and-issue'
import { existingBranchIn } from './register-leftover-conflicts'
import { NO_PROVIDERS } from './routing'
import { finishTicket, startTicket } from './run-tools'
import type { BoardFiles } from './store'
import { newTicket } from './tickets'
import type { Ticket } from './tickets'

const STAMP = '2026-11-22T10:02Z'
const LOCAL_BRANCHES = ['fix/login-x', 'main']

const ticketWith = (fields: Partial<Ticket>): Ticket => ({ ...newTicket('SQ-2', { title: 'Second slice' }, STAMP), ...fields })

const filesFor = (tickets: Ticket[]): BoardFiles => ({
  config: DEFAULT_BOARD_CONFIG,
  configText: undefined,
  tickets,
  stories: [],
  checkedOutBranch: 'main',
})

// The test engine has no process, so the function runs against the git calls it makes. The cast is the only gap
// between this stand-in and the real engine.
const engineWithBranches = (gitCalls: string[][]): EngineInterface =>
  ({
    process: {
      run: async (argv: string[]) => {
        gitCalls.push(argv)
        const isLocal = LOCAL_BRANCHES.some(branch => argv.at(-1) === `refs/heads/${branch}`)

        return { exitCode: isLocal ? 0 : 1, stdout: isLocal ? 'abc\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      },
    },
  }) as unknown as EngineInterface

const branchAfterFinish = async (given: string): Promise<string | undefined> => {
  const gitCalls: string[][] = []
  const existingBranch = await existingBranchIn(engineWithBranches(gitCalls), '/repo', given)
  const ticket = ticketWith({ branch: 'main', status: 'doing' })
  const input = { id: 'SQ-2', outcome: 'done', result: 'Built.', checked: 'npm test exit 0', branch: given }
  const { change } = finishTicket(input, filesFor([ticket]), STAMP, { overlaps: [], saidPairs: new Set(), existingBranch })

  return change?.tickets[0]?.branch
}

test('finish names a branch only when it is one name and a local branch of that name exists', async () => {
  expect(await branchAfterFinish('the checked-out branch')).toBe('main')
  expect(await branchAfterFinish('HEAD')).toBe('main')
  expect(await branchAfterFinish('origin/x')).toBe('main')
  expect(await branchAfterFinish('fix/gone')).toBe('main')
  expect(await branchAfterFinish('fix/login-x')).toBe('fix/login-x')
  expect(await branchAfterFinish(' `fix/login-x` ')).toBe('fix/login-x')
})

test('a branch the host named or a value with spaces starts no git process', async () => {
  const gitCalls: string[][] = []

  expect(await existingBranchIn(engineWithBranches(gitCalls), '/repo', 'worktree-agent-abc')).toBeUndefined()
  expect(await existingBranchIn(engineWithBranches(gitCalls), '/repo', 'the checked-out branch')).toBeUndefined()
  expect(gitCalls).toEqual([])
})

test('a ticket on its own run branch gets no other-branch line and one filed elsewhere with no run still does', () => {
  const finishing = ticketWith({ branch: 'main', status: 'doing' })
  const input = { id: 'SQ-2', outcome: 'review', result: 'Built.', checked: 'npm test exit 0', branch: 'fix/login-x' }
  const onOwnRunBranch = finishTicket(input, filesFor([finishing]), STAMP, { overlaps: [], saidPairs: new Set(), existingBranch: 'fix/login-x' }).change?.tickets[0] ?? finishing
  const filedElsewhere = ticketWith({ id: 'SQ-3', status: 'ready', branch: 'release' })

  expect(otherBranchLines([onOwnRunBranch], 'main')).toEqual([])
  expect(otherBranchLines([filedElsewhere], 'main')).toEqual(['SQ-3 belongs to branch release, but the checkout is on main.'])
})

const startOf = (fields: Partial<Ticket>) => startTicket({ id: 'SQ-2' }, filesFor([ticketWith(fields)]), NO_PROVIDERS, STAMP, {})

test('a refused start and a scout start do not ask for a worktree, a worker start does', () => {
  expect(startOf({ mode: 'hitl' }).madeWorktree).toBeUndefined()
  expect(startOf({ kind: 'research', category: 'explore' }).madeWorktree).toBeUndefined()
  expect(startOf({ kind: 'build' }).madeWorktree).toBe(true)
})
