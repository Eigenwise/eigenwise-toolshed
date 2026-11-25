import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, ToolCallResult } from 'claude-code'

import { newTicket, serializeTicket } from './tickets'
import type { Ticket } from './tickets'
import { waitingText } from './waiting-view'

const ROOT = '/repo'
const TICKETS = `${ROOT}/.sidequest/tickets`
const GIT_CONFIG = `${ROOT}/.git/config`
const WITH_A_REMOTE = '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://example.test/o/r.git\n'
const NOW = Date.parse('2026-11-16T10:02:00Z')
const STAMP = '2026-11-16T09:00Z'
const STATE_FIELDS = '--json number,url,state,reviewDecision,mergeable,statusCheckRollup'
const REMOTE_BRANCHES = 'git for-each-ref --format=%(refname)%09%(symref)%09%(committername)%09%(committeremail) refs/remotes'
const PULL_REQUESTS_ON = (key: string): string => `gh pr list --state open --search ${key} -author:@me --json number,url,author,headRefName,title`

const portablePath = (path: string): string => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

const entriesUnder = (files: Map<string, string>, folder: string) => {
  const prefix = `${folder}/`

  return [...files.keys()]
    .filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
    .map(path => ({ name: path.slice(prefix.length), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false }))
}

// What a command answers: its output, or FAILS for a command that cannot start or ran out of time.
const FAILS = Symbol('fails')
type CommandTable = Record<string, string | typeof FAILS>
type CommandCall = { command: string; timeoutMs: number | undefined }

// A command missing from the table exits 1, the way a branch git does not know does. Finding the board is not
// counted: it happens once per session, before any tool.
const standInForEngine = (on: On, files: Map<string, string>, table: CommandTable = {}): CommandCall[] => {
  const calls: CommandCall[] = []
  on('fs.read', (_, e) => {
    const text = files.get(portablePath(e.path))

    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', (_, e) => {
    files.set(portablePath(e.path), e.text)

    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    const entries = entriesUnder(files, portablePath(e.path))

    return entries.length > 0 ? { value: entries } : { deny: `ENOENT ${e.path}` }
  })
  on('process.run', (_, e) => {
    if (e.argv.includes('--git-common-dir')) {
      return { value: { exitCode: 0, stdout: `${ROOT}/.git\n${ROOT}/.git\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const command = e.argv.join(' ')
    calls.push({ command, timeoutMs: e.init?.timeoutMs })
    const answer = table[command]
    if (answer === FAILS) return { deny: `${command}: timed out` }

    return { value: { exitCode: answer === undefined ? 1 : 0, stdout: answer ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home' : undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__sidequest__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('store.get', () => ({ value: true }))

  return calls
}

const textOf = (answer: ToolCallResult): string => (typeof answer.result === 'string' ? answer.result : `deny: ${answer.deny}`)

const startSession = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

const view = async ($: Engine, name: string): Promise<string> => textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: name }))

const start = async ($: Engine, id: string): Promise<string> => textOf(await $.tool.call({ tool: 'mcp__sidequest__start', id }))

const ticketOf = (id: string, fields: Parameters<typeof newTicket>[1], log: string[] = []): Ticket => ({ ...newTicket(id, fields, STAMP), log })

const boardOf = (tickets: readonly Ticket[], gitConfig?: string): Map<string, string> => {
  const files = new Map([[`${ROOT}/.git/HEAD`, 'ref: refs/heads/main\n'], [`${ROOT}/.git/info/exclude`, '.claude/worktrees/\n'], ...tickets.map((ticket): [string, string] => [`${TICKETS}/${ticket.id}.md`, serializeTicket(ticket)])])
  if (gitConfig !== undefined) files.set(GIT_CONFIG, gitConfig)

  return files
}

const pullRequestAnswer = (number: number, fields: Record<string, unknown>): string =>
  JSON.stringify({ number, url: `https://example.test/o/r/pull/${number}`, state: 'OPEN', reviewDecision: '', mergeable: 'MERGEABLE', statusCheckRollup: [], ...fields })

test('a ticket carries its pull request through create and patch, and its handle names the number in the views', async ($, on) => {
  const files = boardOf([])
  files.set(`${ROOT}/.sidequest/board.json`, JSON.stringify({ version: 1, nextTicket: 1, nextStory: 1, settings: { verify: 'npm test' } }))
  const calls = standInForEngine(on, files)
  await startSession($)

  await $.tool.call({
    tool: 'mcp__sidequest__ticket',
    operations: [
      { op: 'create', title: 'PAY-41 Retry failed uploads', pullRequest: 'https://example.test/o/r/pull/130' },
      { op: 'create', title: 'Show the retry count' },
      { op: 'patch', id: 'REPO-2', pullRequest: '#131' },
    ],
  })

  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain('\npullRequest: https://example.test/o/r/pull/130\n')
  expect(files.get(`${TICKETS}/REPO-2.md`)).toContain('\npullRequest: "#131"\n')
  expect(await view($, 'list')).toBe(
    [
      'PAY-41 REPO-1 (branch main, pull request #130) ready build PAY-41 Retry failed uploads',
      'REPO-2 (branch main, pull request #131) ready build Show the retry count',
    ].join('\n'),
  )
  expect((await view($, 'now')).split('\n')).toContain('- PAY-41 REPO-1 (branch main, pull request #130) PAY-41 Retry failed uploads')
  expect(calls.filter(call => call.command.startsWith('gh'))).toEqual([])
})

const TEAM_BOARD: Ticket[] = [
  ticketOf('SQ-1', { title: 'Retry failed uploads', status: 'done', issue: 'PAY-41', branch: 'main', pullRequest: 'https://example.test/o/r/pull/130' }),
  ticketOf('SQ-2', { title: 'Show the retry count', status: 'review', issue: 'PAY-42', branch: 'main', pullRequest: '#131' }),
  ticketOf('SQ-3', { title: 'Pick a backoff', issue: 'PAY-43', branch: 'fix/PAY-43-backoff' }),
  ticketOf('SQ-4', { title: 'Choose the backoff', status: 'needs-you', mode: 'hitl', forYou: 'Question: Which backoff should retries use?' }),
  ticketOf('SQ-5', { title: 'Old idea', status: 'parked', issue: 'PAY-44', pullRequest: '#120' }),
]

const TEAM_TRACKER: CommandTable = {
  [`gh pr view https://example.test/o/r/pull/130 ${STATE_FIELDS}`]: pullRequestAnswer(130, { reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [{ conclusion: 'SUCCESS' }] }),
  [`gh pr view #131 ${STATE_FIELDS}`]: pullRequestAnswer(131, { reviewDecision: 'APPROVED', statusCheckRollup: [{ conclusion: 'SUCCESS' }, { state: 'SUCCESS' }] }),
  [`gh pr view fix/PAY-43-backoff ${STATE_FIELDS}`]: pullRequestAnswer(132, { reviewDecision: 'REVIEW_REQUIRED', mergeable: 'CONFLICTING' }),
  [REMOTE_BRANCHES]: [
    'refs/remotes/origin/HEAD\trefs/remotes/origin/main\tMe\t<me@example.com>',
    'refs/remotes/origin/main\t\tMe\t<me@example.com>',
    'refs/remotes/origin/fix/PAY-43-backoff\t\tMe\t<me@example.com>',
  ].join('\n'),
}

test('the waiting view brings back a done ticket whose pull request got changes requested, and an approved one asks nothing', async ($, on) => {
  const calls = standInForEngine(on, boardOf(TEAM_BOARD, WITH_A_REMOTE), TEAM_TRACKER)
  await startSession($)

  const waiting = await view($, 'waiting')

  expect(waiting).toBe(
    [
      'Waiting on you in repo, most blocking first:',
      '1. Which backoff should retries use?\n   To answer in this chat: 1 done, or 1 and what you found. Ticket SQ-4.',
      [
        '2. The pull request for "Retry failed uploads" came back with changes requested. Take the work up again?',
        '   Why now: the work was marked done here, and this came in since.',
        '   Steps: open https://example.test/o/r/pull/130, read what came back, and say whether to take the work up again.',
        '   To answer in this chat: 2 done, or 2 and what you found. Ticket PAY-41 SQ-1 (branch main, pull request #130).',
      ].join('\n'),
      [
        'Where the pull requests stand:',
        '- "Show the retry count", pull request #131: approved.',
        '- "Pick a backoff", pull request #132: a conflict with its base.',
      ].join('\n'),
    ].join('\n\n'),
  )
  expect(calls.map(call => call.command)).not.toContain(`gh pr view #120 ${STATE_FIELDS}`)
  expect(calls.every(call => call.timeoutMs !== undefined && call.timeoutMs <= 5000)).toBe(true)
})

test('red checks bring a ticket back too, and a waiting ticket keeps its own question', async ($, on) => {
  const board = [
    ticketOf('SQ-6', { title: 'Retry failed uploads', status: 'review', issue: 'PAY-41', pullRequest: '#140' }),
    ticketOf('SQ-7', { title: 'Decide the limit', status: 'needs-you', issue: 'PAY-42', pullRequest: '#141', forYou: 'Question: How many retries?' }),
  ]
  standInForEngine(on, boardOf(board, WITH_A_REMOTE), {
    [`gh pr view #140 ${STATE_FIELDS}`]: pullRequestAnswer(140, { statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }] }),
    [`gh pr view #141 ${STATE_FIELDS}`]: pullRequestAnswer(141, { reviewDecision: 'CHANGES_REQUESTED' }),
  })
  await startSession($)

  const waiting = await view($, 'waiting')

  expect(waiting.startsWith('Waiting on you in repo, by piece of work:\n\nPAY-41\n\n1. The pull request for "Retry failed uploads" came back with failing checks. Take the work up again?')).toBe(true)
  expect(waiting).not.toContain('Why now: the work was marked done here')
  expect(waiting).toContain('PAY-42\n\n2. How many retries?')
  expect(waiting).toContain('- "Decide the limit", pull request #141: changes requested.')
})

const KEYED_TICKET = ticketOf('SQ-8', { title: 'PAY-41 Retry failed uploads', issue: 'PAY-41', branch: 'main', pullRequest: '#139' })

const WHO_ELSE: CommandTable = {
  [PULL_REQUESTS_ON('PAY-41')]: JSON.stringify([
    { number: 139, url: 'https://example.test/o/r/pull/139', author: { login: 'dana' }, headRefName: 'mine/PAY-41', title: 'PAY-41 my own one' },
    { number: 140, url: 'https://example.test/o/r/pull/140', author: { login: 'dana' }, headRefName: 'fix/PAY-41-retry', title: 'PAY-41 Retry uploads' },
    { number: 150, url: 'https://example.test/o/r/pull/150', author: { login: 'kim' }, headRefName: 'docs', title: 'Mentions PAY-410 only' },
  ]),
  [REMOTE_BRANCHES]: [
    'refs/remotes/origin/fix/PAY-41-retry\t\tDana\t<dana@example.com>',
    'refs/remotes/origin/PAY-41-spike\t\tLee\t<lee@example.com>',
    'refs/remotes/origin/PAY-41-mine\t\tMe\t<me@example.com>',
  ].join('\n'),
  'git config user.email': 'me@example.com\n',
}

test('start on a ticket with a tracker key says in one line who else has it open, and starts it all the same', async ($, on) => {
  const files = boardOf([KEYED_TICKET], WITH_A_REMOTE)
  const calls = standInForEngine(on, files, WHO_ELSE)
  await startSession($)

  const answer = await start($, 'SQ-8')

  expect(answer.startsWith('SQ-8 is now doing.')).toBe(true)
  expect(answer.endsWith(
    '\nSomeone else may already be on PAY-41: dana has open pull request #140 on fix/PAY-41-retry (https://example.test/o/r/pull/140); Lee last committed to origin/PAY-41-spike. SQ-8 started all the same; pass this on to the person.',
  )).toBe(true)
  expect(files.get(`${TICKETS}/SQ-8.md`)).toContain('\nstatus: doing\n')
  expect(calls.filter(call => call.command.startsWith('gh')).map(call => call.timeoutMs)).toEqual([3000])
})

test('with no remote, no tracker command line or a lookup that runs out of time, the views and start read as before', async ($, on) => {
  const noRemote = boardOf([...TEAM_BOARD, KEYED_TICKET])
  const calls = standInForEngine(on, noRemote, { ...TEAM_TRACKER, ...WHO_ELSE })
  await startSession($)

  const waiting = await view($, 'waiting')
  const started = await start($, 'SQ-8')

  expect(waiting).toBe(waitingText([...TEAM_BOARD, KEYED_TICKET], undefined, undefined, undefined, { stories: [], projectName: 'repo' }))
  expect(started).not.toContain('Someone else')
  expect(calls).toEqual([])
})

test('lookups that cannot start or run out of time leave the waiting view and the start answer as they were', async ($, on) => {
  const everyLookupFails: CommandTable = Object.fromEntries(Object.keys({ ...TEAM_TRACKER, ...WHO_ELSE }).map(command => [command, FAILS]))
  const calls = standInForEngine(on, boardOf([...TEAM_BOARD, KEYED_TICKET], WITH_A_REMOTE), everyLookupFails)
  await startSession($)

  const waiting = await view($, 'waiting')
  const started = await start($, 'SQ-8')

  expect(waiting).toBe(waitingText([...TEAM_BOARD, KEYED_TICKET], undefined, undefined, undefined, { stories: [], projectName: 'repo' }))
  expect(started).not.toContain('Someone else')
  expect(calls.some(call => call.command.startsWith('gh'))).toBe(true)
})

const LEFT_RUNNING = (agentId: string): string[] => [`${STAMP} started worker sonnet/medium`, `${STAMP} agent ${agentId} build requested sonnet/medium resolved sonnet`]

test('a ticket with no tracker key and no pull request starts no process in start, finish or any view, even with a remote', async ($, on) => {
  const board = [
    ticketOf('SQ-9', { title: 'Fix the footer', branch: 'main' }),
    ticketOf('SQ-10', { title: 'Trace uploads', status: 'doing', branch: 'main' }, LEFT_RUNNING('a10')),
    ticketOf('SQ-11', { title: 'Show the sync time', status: 'done', branch: 'main' }),
  ]
  const files = boardOf(board, WITH_A_REMOTE)
  files.set(`${ROOT}/.sidequest/board.json`, JSON.stringify({ version: 1, nextTicket: 12, nextStory: 1, settings: { verify: 'npm test' } }))
  const calls = standInForEngine(on, files)
  await startSession($)

  for (const name of ['summary', 'waiting', 'now', 'list', 'frontier']) await view($, name)
  await start($, 'SQ-9')
  await $.tool.call({ tool: 'mcp__sidequest__finish', id: 'SQ-9', outcome: 'done', result: 'Fixed.' })

  expect(calls).toEqual([])
})

const LAST_COMMIT = (branch: string): string => `git log -1 --format=%h%x09%ce%x09%cn%x09%s ${branch}`

test('interrupted work on a branch someone else committed to last is not offered to resume, and the line says whose it is', async ($, on) => {
  const board = [
    ticketOf('SQ-12', { title: 'Retry failed uploads', status: 'doing', issue: 'PAY-41', branch: 'main' }, LEFT_RUNNING('a12')),
    ticketOf('SQ-13', { title: 'Show the count', status: 'doing', issue: 'PAY-42', branch: 'main' }, LEFT_RUNNING('a13')),
  ]
  standInForEngine(on, boardOf(board, WITH_A_REMOTE), {
    'git config user.email': 'me@example.com\n',
    [LAST_COMMIT('worktree-agent-a12')]: 'abc1111\tsam@example.com\tSam\tFix the retry\n',
    [LAST_COMMIT('worktree-agent-a13')]: 'abc2222\tme@example.com\tMe\tCount\n',
  })
  await startSession($)

  const summary = await view($, 'summary')
  const now = await view($, 'now')

  expect(summary).toContain('\nInterrupted, nothing runs them in this session: SQ-13 (no run in this session). Earlier work, not a request:')
  expect(summary).toContain("\nPAY-41 SQ-12 (branch main) was interrupted on a branch Sam committed to last: it is Sam's work now, so it is not offered to resume.")
  expect(now).toContain(
    [
      'Nothing is running.',
      'PAY-41 (branch main)',
      "- interrupted, Sam's work now: Retry failed uploads (SQ-12)",
      'PAY-42 (branch main)',
      '- interrupted, no run in this session: Show the count (SQ-13)',
    ].join('\n'),
  )
})

test('when git cannot say who committed last, interrupted work is offered as before', async ($, on) => {
  const board = [ticketOf('SQ-14', { title: 'Retry failed uploads', status: 'doing', issue: 'PAY-41', branch: 'main' }, LEFT_RUNNING('a14'))]
  standInForEngine(on, boardOf(board, WITH_A_REMOTE), { 'git config user.email': 'me@example.com\n', [LAST_COMMIT('worktree-agent-a14')]: FAILS })
  await startSession($)

  expect(await view($, 'summary')).toContain('\nInterrupted, nothing runs them in this session: SQ-14 (no run in this session).')
  expect(await view($, 'now')).not.toContain('someone else committed to last')
})
