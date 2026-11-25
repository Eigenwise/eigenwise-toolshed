import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, ToolCallResult } from 'claude-code'

import { newTicket, serializeTicket } from './tickets'
import type { Ticket } from './tickets'

const ROOT = '/repo'
const TICKETS = `${ROOT}/.sidequest/tickets`
const NOW = Date.parse('2026-11-16T10:02:00Z')
const STAMP = '2026-11-16T09:00Z'
const NOT_MERGED_DIFF = (branch: string): string => `diff --name-only main...${branch} -- . :(exclude,attr:linguist-generated)`

const portablePath = (path: string): string => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

const entriesUnder = (files: Map<string, string>, folder: string) => {
  const prefix = `${folder}/`

  return [...files.keys()]
    .filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
    .map(path => ({ name: path.slice(prefix.length), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false }))
}

// Git answers come from the table; anything else fails, the way a missing branch does. Finding the board is not
// counted: it happens once per session, before any tool.
const standInForEngine = (on: On, files: Map<string, string>, gitTable: Record<string, string> = {}): string[] => {
  const gitCalls: string[] = []
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
    const isLocatingTheBoard = e.argv.includes('--git-common-dir')
    const command = e.argv.slice(1).join(' ')
    if (!isLocatingTheBoard) gitCalls.push(command)
    const stdout = isLocatingTheBoard ? `${ROOT}/.git\n${ROOT}/.git\n` : gitTable[command]

    return { value: { exitCode: stdout === undefined ? 1 : 0, stdout: stdout ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home' : undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__sidequest__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('store.get', () => ({ value: true }))

  return gitCalls
}

const textOf = (answer: ToolCallResult): string => (typeof answer.result === 'string' ? answer.result : `deny: ${answer.deny}`)

const startSession = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

const ranBy = (agentId: string): string[] => [`${STAMP} started worker sonnet/medium`, `${STAMP} agent ${agentId} build requested sonnet/medium resolved sonnet`]

const boardOf = (tickets: readonly Ticket[]): Map<string, string> =>
  new Map([[`${ROOT}/.git/HEAD`, 'ref: refs/heads/main\n'], [`${ROOT}/.git/info/exclude`, '.claude/worktrees/\n'], ...tickets.map((ticket): [string, string] => [`${TICKETS}/${ticket.id}.md`, serializeTicket(ticket)])])

const ticketOf = (id: string, fields: Parameters<typeof newTicket>[1], log: string[] = []): Ticket => ({
  ...newTicket(id, { branch: 'main', ...fields }, STAMP),
  log,
})

const finish = async ($: Engine, id: string, changedFiles: string[]) =>
  textOf(await $.tool.call({ tool: 'mcp__sidequest__finish', id, outcome: 'done', result: 'Retries work.', checked: 'npm test exit 0', changedFiles }))

test('finish names an open ticket whose unmerged branch changed the same file, once for that pair', async ($, on) => {
  const files = boardOf([
    ticketOf('SQ-61', { title: 'Retry failed uploads', status: 'doing' }, ranBy('a61')),
    ticketOf('SQ-62', { title: 'Show retry count', status: 'review' }, ranBy('a62')),
    ticketOf('SQ-63', { title: 'Pick a backoff' }),
  ])
  standInForEngine(on, files, { [NOT_MERGED_DIFF('worktree-agent-a62')]: 'src/retry.ts\npackage-lock.json\nsrc/count.ts\n' })
  await startSession($)

  const first = await finish($, 'SQ-61', ['src/retry.ts', 'package-lock.json'])
  const second = await finish($, 'SQ-61', ['src/retry.ts'])

  expect(first.endsWith(
    '\nSQ-62 (branch main) also changes src/retry.ts on its branch worktree-agent-a62, which is not merged yet; carry on unless they really conflict.',
  )).toBe(true)
  expect(second).not.toContain('carry on')
  expect(second).not.toContain('SQ-62')
  expect(files.get(`${TICKETS}/SQ-62.md`)).toBe(serializeTicket(ticketOf('SQ-62', { title: 'Show retry count', status: 'review' }, ranBy('a62'))))
})

test('a lockfile or an ignored file in common adds nothing, and the files are read from the return record when finish names none', async ($, on) => {
  const files = boardOf([
    ticketOf('SQ-71', { title: 'Bump the client', status: 'doing' }, [...ranBy('a71'), `${STAMP} returned build run after 4m`, `${STAMP} changed package-lock.json, dist/client.js`]),
    ticketOf('SQ-72', { title: 'Add a client option', status: 'doing' }, ranBy('a72')),
  ])
  const gitCalls = standInForEngine(on, files, {
    [NOT_MERGED_DIFF('worktree-agent-a72')]: 'package-lock.json\ndist/client.js\n',
    'check-ignore --no-index -- dist/client.js': 'dist/client.js\n',
  })
  await startSession($)

  const answer = textOf(await $.tool.call({ tool: 'mcp__sidequest__finish', id: 'SQ-71', outcome: 'done', result: 'Bumped.' }))

  expect(answer).not.toContain('carry on')
  expect(gitCalls).toEqual([NOT_MERGED_DIFF('worktree-agent-a72'), 'check-ignore --no-index -- dist/client.js'])
})

test('more than two tickets on the same file names two and counts the rest, and a file list names two files and counts the rest', async ($, on) => {
  const others = ['SQ-92', 'SQ-93', 'SQ-94'].map(id => ticketOf(id, { title: `Work ${id}`, status: 'doing' }, ranBy(id.toLowerCase())))
  const files = boardOf([ticketOf('SQ-91', { title: 'Rename the upload module', status: 'doing' }, ranBy('a91')), ...others])
  const changed = 'src/a.ts\nsrc/b.ts\nsrc/c.ts\n'
  standInForEngine(on, files, Object.fromEntries(['sq-92', 'sq-93', 'sq-94'].map(agent => [NOT_MERGED_DIFF(`worktree-agent-${agent}`), changed])))
  await startSession($)

  const answer = await finish($, 'SQ-91', ['src/a.ts', 'src/b.ts', 'src/c.ts'])

  expect(answer.endsWith(
    '\nSQ-92 (branch main) also changes src/a.ts, src/b.ts and 1 more file on its branch worktree-agent-sq-92, which is not merged yet; SQ-93 (branch main) also changes src/a.ts, src/b.ts and 1 more file on its branch worktree-agent-sq-93, which is not merged yet; 1 more open ticket does the same; carry on unless they really conflict.',
  )).toBe(true)
})

test('creating a ticket with a tracker key another open ticket carries names that ticket once', async ($, on) => {
  const files = boardOf([ticketOf('SQ-81', { title: 'PAY-41 Retry failed uploads', issue: 'PAY-41' }), ticketOf('SQ-82', { title: 'PAY-41 Old try', issue: 'PAY-41', status: 'done' })])
  files.set(`${ROOT}/.sidequest/board.json`, JSON.stringify({ version: 1, nextTicket: 83, nextStory: 1, settings: {} }))
  const gitCalls = standInForEngine(on, files)
  await startSession($)

  const created = textOf(await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'create', title: 'PAY-41 Show the retry count' }] }))
  const again = textOf(await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'patch', id: 'SQ-83', what: 'The count shows.' }] }))

  expect(created).toBe('created SQ-83.\nPAY-41 SQ-81 (branch main) is open with the same tracker key; carry on unless they really conflict.')
  expect(again).toBe('patched SQ-83.')
  expect(files.get(`${TICKETS}/SQ-81.md`)).toBe(serializeTicket(ticketOf('SQ-81', { title: 'PAY-41 Retry failed uploads', issue: 'PAY-41' })))
  expect(gitCalls).toEqual([])
})

test('starting a ticket with a tracker key another open ticket carries names that ticket, and the same story does not count', async ($, on) => {
  const files = boardOf([
    ticketOf('SQ-84', { title: 'Retry failed uploads', issue: 'PAY-52' }),
    ticketOf('SQ-85', { title: 'An older try', issue: 'PAY-52', status: 'parked' }),
    ticketOf('SQ-86', { title: 'Its sibling', issue: 'PAY-52', story: 'ST-1' }),
    ticketOf('SQ-87', { title: 'Another sibling', issue: 'PAY-52', story: 'ST-1' }),
  ])
  standInForEngine(on, files)
  await startSession($)

  const started = textOf(await $.tool.call({ tool: 'mcp__sidequest__start', id: 'SQ-84' }))
  const sibling = textOf(await $.tool.call({ tool: 'mcp__sidequest__start', id: 'SQ-86' }))

  expect(started.endsWith(
    '\nPAY-52 SQ-85 (branch main) is open with the same tracker key; PAY-52 SQ-86 (branch main) is open with the same tracker key; 1 more open ticket does the same; carry on unless they really conflict.',
  )).toBe(true)
  expect(sibling.endsWith('\nPAY-52 SQ-85 (branch main) is open with the same tracker key; carry on unless they really conflict.')).toBe(true)
  expect(sibling).not.toContain('SQ-84 (')
  expect(sibling).not.toContain('SQ-87')
})

test('four created tickets of one story that share a key with one older open ticket name that ticket once', async ($, on) => {
  const files = boardOf([ticketOf('SQ-90', { title: 'PAY-60 Earlier try', issue: 'PAY-60' })])
  files.set(`${ROOT}/.sidequest/board.json`, JSON.stringify({ version: 1, nextTicket: 91, nextStory: 1, settings: {} }))
  standInForEngine(on, files)
  await startSession($)

  const created = textOf(
    await $.tool.call({
      tool: 'mcp__sidequest__ticket',
      operations: ['One', 'Two', 'Three', 'Four'].map(name => ({ op: 'create', title: `PAY-60 ${name}` })),
    }),
  )

  expect(created.endsWith('\nPAY-60 SQ-90 (branch main) is open with the same tracker key; carry on unless they really conflict.')).toBe(true)
  expect(created).not.toContain('more open ticket')
})

test('a board where no other open ticket has a branch or a shared key answers finish, ticket and start as before and starts no process', async ($, on) => {
  const files = boardOf([
    ticketOf('SQ-51', { title: 'PAY-7 Retry failed uploads', issue: 'PAY-7', status: 'doing' }, ranBy('a51')),
    ticketOf('SQ-52', { title: 'PAY-8 Show the count', issue: 'PAY-8' }),
    ticketOf('SQ-53', { title: 'Pick a backoff', status: 'parked' }),
    ticketOf('SQ-54', { title: 'PAY-9 Done long ago', issue: 'PAY-9', status: 'done' }, ranBy('a54')),
  ])
  files.set(`${ROOT}/.sidequest/board.json`, JSON.stringify({ version: 1, nextTicket: 55, nextStory: 1, settings: { verify: 'npm test' } }))
  const gitCalls = standInForEngine(on, files)
  await startSession($)

  const created = textOf(await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'create', title: 'PAY-9 Follow up' }] }))
  const started = textOf(await $.tool.call({ tool: 'mcp__sidequest__start', id: 'SQ-52' }))
  const finished = await finish($, 'SQ-51', ['src/retry.ts'])

  expect(created).toBe('created SQ-55.')
  expect(started.startsWith('SQ-52 is now doing. The board logs what the agent returns on the ticket by itself;')).toBe(true)
  expect(started).toContain('}\nThe brief is also kept in')
  expect(finished).toBe('SQ-51 moved to review after 1h 2m.')
  expect(gitCalls).toEqual([])
})
