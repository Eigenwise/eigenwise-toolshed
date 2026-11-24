import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, ToolCallResult } from 'claude-code'

import { DEFAULT_BOARD_CONFIG } from './board-config'
import { newTicket } from './tickets'
import type { Ticket } from './tickets'
import { bandLine, boardCards } from './views/board-view'
import { boardPaneLines, paneLinesAsText } from './views/pane-sections'

const ROOT = '/repo'
const TICKETS = `${ROOT}/.sidequest/tickets`
const NOW = Date.parse('2026-11-20T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000

const portablePath = (path: string): string => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

const dayAgo = (days: number): string => new Date(NOW - days * DAY).toISOString().slice(0, 10)
const stampAgo = (days: number): string => `${new Date(NOW - days * DAY).toISOString().slice(0, 16)}Z`

type TicketFields = {
  status?: string
  mode?: string
  blockedBy?: string[]
  daysOld?: number
  log?: string[]
  forYou?: string
}

const ticketFile = (id: string, title: string, fields: TicketFields = {}): string =>
  [
    '---',
    `id: ${id}`,
    `title: ${title}`,
    `status: ${fields.status ?? 'ready'}`,
    'kind: build',
    `mode: ${fields.mode ?? 'afk'}`,
    'category: build',
    `blockedBy: [${(fields.blockedBy ?? []).join(', ')}]`,
    `created: ${dayAgo(fields.daysOld ?? 0)}`,
    `updated: ${dayAgo(fields.daysOld ?? 0)}`,
    '---',
    '',
    ...(fields.forYou === undefined ? [] : ['## For you', fields.forYou, '']),
    '## What',
    `${title} works.`,
    '',
    '## Log',
    ...(fields.log ?? []).map(line => `- ${line}`),
    '',
  ].join('\n')

const entriesUnder = (files: Map<string, string>, folder: string) => {
  const prefix = `${folder}/`

  return [...files.keys()]
    .filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
    .map(path => ({ name: path.slice(prefix.length), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false }))
}

const ran = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

type StandIn = { reads: string[]; workingFolder: string; afterRead?: (path: string) => void }

const standInForEngine = (on: On, files: Map<string, string>): StandIn => {
  const standIn: StandIn = { reads: [], workingFolder: ROOT }
  on('fs.read', (_, e) => {
    const path = portablePath(e.path)
    standIn.reads.push(path)
    const text = files.get(path)
    standIn.afterRead?.(path)

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
  on('process.run', () => ran(`${ROOT}/.git\n`))
  on('session.cwd', () => ({ value: standIn.workingFolder }))
  on('store.get', () => ({ value: true }))
  on('store.set', () => ({ value: undefined }))
  on('env.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('session.id', () => ({ value: 'session-1' }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__sidequest__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))

  return standIn
}

const boardOf = (tickets: readonly [string, string, TicketFields?][]): Map<string, string> =>
  new Map(tickets.map(([id, title, fields]) => [`${TICKETS}/${id}.md`, ticketFile(id, title, fields)]))

const startSession = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

const typePrompt = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

const textOf = (answer: ToolCallResult): string => (typeof answer.result === 'string' ? answer.result : `deny: ${answer.deny}`)

const view = async ($: Engine, name: string): Promise<string> => textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: name }))

const writeTickets = async ($: Engine, operations: unknown[]): Promise<string> => textOf(await $.tool.call({ tool: 'mcp__sidequest__ticket', operations }))

const startTicket = async ($: Engine, id: string): Promise<string> => textOf(await $.tool.call({ tool: 'mcp__sidequest__start', id }))

const BLOCKED_BOARD = boardOf([
  ['SQ-1', 'Parked blocker', { status: 'parked' }],
  ['SQ-2', 'Dropped blocker', { status: 'dropped' }],
  ['SQ-4', 'Blocked by parked', { blockedBy: ['SQ-1'] }],
  ['SQ-5', 'Blocked by dropped', { blockedBy: ['SQ-2'] }],
  ['SQ-6', 'Blocked by missing', { blockedBy: ['SQ-3'] }],
  ['SQ-7', 'Blocked by ready work', { blockedBy: ['SQ-4'] }],
  ['SQ-8', 'Finished long ago', { status: 'done' }],
])

test('the summary and the frontier say which ready ticket waits for which and why, three named and the rest counted', async ($, on) => {
  standInForEngine(on, BLOCKED_BOARD)
  await startSession($)

  const summary = (await view($, 'summary')).split('\n')

  expect(summary.slice(0, 5)).toEqual([
    '0 waiting on you, 4 ready to start, 0 in progress, 0 being checked. Nothing is ready to start: of the 4 ready, none can start yet.',
    'SQ-4 waits for SQ-1, which is parked.',
    'SQ-5 waits for SQ-2, which is dropped.',
    'SQ-6 waits for SQ-3, which is not on the board.',
    'And 1 more like these.',
  ])
  expect(await view($, 'frontier')).toBe(
    [
      'Nothing is ready to start.',
      'SQ-4 waits for SQ-1, which is parked.',
      'SQ-5 waits for SQ-2, which is dropped.',
      'SQ-6 waits for SQ-3, which is not on the board.',
      'And 1 more like these.',
    ].join('\n'),
  )
})

test('start says a blocker is not done, and that a done or dropped ticket goes back to doing, and starts it all the same', async ($, on) => {
  const files = BLOCKED_BOARD
  standInForEngine(on, files)
  await startSession($)
  await typePrompt($, 'start the blocked ones and the old one')

  const blocked = await startTicket($, 'SQ-4')
  const finished = await startTicket($, 'SQ-8')
  const dropped = await startTicket($, 'SQ-2')

  expect(blocked.startsWith('SQ-4 waits for SQ-1, which is parked. It is started all the same. SQ-4 is now doing.')).toBe(true)
  expect(finished.startsWith('SQ-8 was done: this start puts it back to doing. SQ-8 is now doing.')).toBe(true)
  expect(dropped.startsWith('SQ-2 was dropped: this start puts it back to doing. SQ-2 is now doing.')).toBe(true)
  for (const answer of [blocked, finished, dropped]) expect(answer).toContain('Make this Agent call as given:')
  expect(files.get(`${TICKETS}/SQ-4.md`)).toContain('status: doing')
})

test('finish with no check, or a check that says it was not checked, says nothing was checked in its answer, its log and the closing view', async ($, on) => {
  const files = boardOf([
    ['SQ-1', 'Retry failed uploads', { status: 'doing', log: [`${stampAgo(0.1)} started worker sonnet/medium`] }],
    ['SQ-2', 'Show retry count', { status: 'doing', log: [`${stampAgo(0.1)} started worker sonnet/medium`] }],
    ['SQ-3', 'Log the retries', { status: 'doing', log: [`${stampAgo(0.1)} started worker sonnet/medium`] }],
  ])
  files.set(`${ROOT}/.sidequest/board.json`, JSON.stringify({ settings: { verify: 'npm test' } }))
  standInForEngine(on, files)
  await startSession($)

  const finish = async (id: string, checked?: string) =>
    textOf(await $.tool.call({ tool: 'mcp__sidequest__finish', id, outcome: 'done', result: 'Done.', ...(checked === undefined ? {} : { checked }) }))
  const unchecked = await finish('SQ-1')
  const saidNotChecked = await finish('SQ-2', 'not checked: the database is not running here')
  const checked = await finish('SQ-3', 'npm test exit 0')

  expect(unchecked).toBe('SQ-1 moved to review after 2h 24m. Nothing was checked, so nobody has seen this work pass a check yet.')
  expect(saidNotChecked).toBe('SQ-2 moved to review after 2h 24m. Nothing was checked, so nobody has seen this work pass a check yet.')
  expect(checked).toBe('SQ-3 moved to review after 2h 24m.')
  expect(files.get(`${TICKETS}/SQ-1.md`)).toContain('2026-11-20T12:00Z nothing was checked\n')
  expect(files.get(`${TICKETS}/SQ-2.md`)).toContain('2026-11-20T12:00Z nothing was checked\n')
  expect(files.get(`${TICKETS}/SQ-3.md`)).not.toContain('nothing was checked')
  expect(await view($, 'closing')).toBe(
    [
      'What this session changed on the board:',
      '- SQ-1 Retry failed uploads: built, being checked, nothing was checked',
      '- SQ-2 Show retry count: built, being checked, nothing was checked',
      '- SQ-3 Log the retries: built, being checked',
    ].join('\n'),
  )
})

const QUESTION = 'Question: Ship option one?\nWhy now: it blocks nothing yet.\nOptions:\n- Yes: ships it. Costs: a day.\n- No: skips it. Costs: nothing.\nRecommended: A\nIf you never answer: it stays here.'

test('the summary names the inbox and its oldest age, and the waiting view, now, the band and the pane say how long questions waited', async ($, on) => {
  const files = boardOf([
    ['SQ-1', 'Side idea one', { status: 'inbox', daysOld: 60 }],
    ['SQ-2', 'Side idea two', { status: 'inbox', daysOld: 3 }],
    ['SQ-3', 'Decide option one', { status: 'needs-you', daysOld: 30, log: [`${stampAgo(30)} finished needs-you`], forYou: QUESTION }],
  ])
  standInForEngine(on, files)
  await startSession($)

  const summary = (await view($, 'summary')).split('\n')
  const waiting = await view($, 'waiting')
  const now = await view($, 'now')

  expect(summary).toContain('2 in the inbox, the oldest 60 days old: Side idea one (SQ-1), Side idea two (SQ-2).')
  expect(waiting).toContain('\n\nShip option one?\n   Waiting 30 days.\n   Why now: it blocks nothing yet.')
  expect(now).toContain('- Answer: Ship option one? (waiting 30 days)')

  const ticket: Ticket = { ...newTicket('SQ-3', { title: 'Decide option one', status: 'needs-you', forYou: QUESTION }, stampAgo(30)), log: [`${stampAgo(30)} finished needs-you`] }
  const cards = boardCards([ticket], DEFAULT_BOARD_CONFIG)
  const activity = { agents: {}, runs: {}, waits: {}, doingTickets: [], returnedTickets: [], oldestWaitingMs: 30 * DAY }
  const pane = { cards, running: [], sessionWork: { isWorking: false, steps: 0 }, finishedAgents: [], worktreeCount: 0, touchedHere: new Set(['SQ-3']), showsIntro: false, columns: 100, now: NOW, whatYouCouldDo: [] }

  expect(bandLine({ needsYou: 1, ready: 0, doing: 0, review: 0 }, activity, 120).warnings).toBe('1 ticket needs you, waiting 30 days')
  expect(paneLinesAsText(boardPaneLines(pane))).toContain('  SQ-3 Ship option one?  waiting 30 days, recommended: Yes')
})

const manyTickets = (count: number): Map<string, string> => {
  const files = new Map<string, string>()
  for (let number = 1; number <= count; number += 1) {
    const status = number % 10 === 0 ? 'ready' : number % 25 === 1 ? 'parked' : 'done'
    files.set(`${TICKETS}/SQ-${number}.md`, ticketFile(`SQ-${number}`, `Work item ${number}`, { status }))
  }

  return files
}

test('on a big board the list leaves settled work out and counts it, the summary names ten ready ids, and a start reads the board once', async ($, on) => {
  const files = manyTickets(240)
  const standIn = standInForEngine(on, files)
  await startSession($)

  const list = (await view($, 'list')).split('\n')
  const summary = await view($, 'summary')

  expect(list).toHaveLength(25)
  expect(list[0]).toBe('SQ-10 ready build Work item 10')
  expect(list.at(-1)).toBe('and 206 done, 10 parked: list with a status to see them')
  expect(summary).toContain('Ready to start: SQ-10, SQ-20, SQ-30, SQ-40, SQ-50, SQ-60, SQ-70, SQ-80, SQ-90, SQ-100, and 14 more.')

  standIn.reads.length = 0
  await startTicket($, 'SQ-10')

  expect(standIn.reads.filter(path => path === `${TICKETS}/SQ-11.md`)).toHaveLength(1)
})

test('a board of a handful of tickets lists every ticket, settled ones included', async ($, on) => {
  standInForEngine(on, boardOf([['SQ-1', 'One', { status: 'done' }], ['SQ-2', 'Two', { status: 'parked' }], ['SQ-3', 'Three']]))
  await startSession($)

  expect(await view($, 'list')).toBe(['SQ-1 done build One', 'SQ-2 parked build Two', 'SQ-3 ready build Three'].join('\n'))
})

test('a stop in a session that remembers creating nothing says so and names the ready and inbox tickets created in the last day', async ($, on) => {
  const files = boardOf([
    ['SQ-1', 'Old ready work', { daysOld: 5 }],
    ['SQ-2', 'Filed today', { daysOld: 0 }],
    ['SQ-3', 'Filed into the inbox today', { status: 'inbox', daysOld: 0 }],
    ['SQ-4', 'Running today', { status: 'doing', daysOld: 0 }],
  ])
  standInForEngine(on, files)
  await startSession($)
  await typePrompt($, 'stop, forget that')

  const answer = await writeTickets($, [{ op: 'stop' }])

  expect(answer).toBe(
    'Nothing changed. This session does not remember which tickets it created, so nothing was parked: that is lost when a session is resumed or reloaded. Created in the last day and ready or in the inbox, so maybe the ones meant: SQ-2 (Filed today), SQ-3 (Filed into the inbox today). To park them, move each to parked, or call stop with their story.',
  )
  expect(files.get(`${TICKETS}/SQ-2.md`)).toContain('status: ready')
})

test('a create while the working folder is outside the board project says which board it went to, and says nothing at home', async ($, on) => {
  const standIn = standInForEngine(on, new Map())
  await startSession($)

  const atHome = await writeTickets($, [{ op: 'create', title: 'Filed at home' }])
  standIn.workingFolder = '/other-repo'
  const elsewhere = await writeTickets($, [{ op: 'create', title: 'Filed from elsewhere' }])
  const note = await writeTickets($, [{ op: 'note', id: 'REPO-1', text: 'A note from elsewhere.' }])

  expect(atHome).not.toContain('This went to the board')
  expect(elsewhere).toContain('This went to the board at /repo/.sidequest, the one this session started with: the working folder now, /other-repo, is outside that project.')
  expect(note).toBe('noted REPO-1.')
})

test('a note on a ticket that changed on disk twice is not called noted', async ($, on) => {
  const files = boardOf([['SQ-1', 'One'], ['SQ-2', 'Two']])
  const path = `${TICKETS}/SQ-1.md`
  const standIn = standInForEngine(on, files)
  await startSession($)
  let readsOfIt = 0
  standIn.afterRead = readPath => {
    if (readPath !== path) return
    readsOfIt += 1
    if (readsOfIt === 1 || readsOfIt === 3) files.set(path, `${files.get(path) ?? ''}- a line added by hand\n`)
  }

  const answer = await writeTickets($, [
    { op: 'note', id: 'SQ-1', text: 'Checked it.' },
    { op: 'note', id: 'SQ-2', text: 'Checked it too.' },
  ])

  expect(answer).toBe(
    'noted SQ-2.\nSQ-1 changed on disk while this call wrote it, and again after the change was redone on the new text, so nothing was written to SQ-1. Read it again and repeat the change.',
  )
})
