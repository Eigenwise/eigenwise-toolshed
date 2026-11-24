import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, ToolCallResult } from 'claude-code'

import type { BoardCard } from '../types'
import { boardPaneLines, olderTicketLines, paneLinesAsText } from './views/pane-sections'
import type { PaneContent } from './views/pane-sections'

const ROOT = '/repo'
const TICKETS = `${ROOT}/.sidequest/tickets`
const NOW = Date.parse('2026-11-19T10:00:00Z')
const WORKTREE = `${ROOT}/.claude/worktrees/agent-abc`

const portablePath = (path: string): string => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

const ticketFile = (id: string, title: string, status: string, log: string[] = [], blockedBy: string[] = []): string =>
  [
    '---',
    `id: ${id}`,
    `title: ${title}`,
    `status: ${status}`,
    'kind: build',
    'mode: afk',
    'category: build',
    `blockedBy: [${blockedBy.join(', ')}]`,
    'created: 2026-11-01',
    'updated: 2026-11-01',
    '---',
    '',
    '## What',
    `${title} works.`,
    '',
    '## Log',
    ...log.map(line => `- ${line}`),
    '',
  ].join('\n')

const SENT_BACK_RUN = ['2026-11-18T09:00Z started worker sonnet/medium', '2026-11-18T09:40Z finished done branch worktree-agent-abc commits 2']

type StandIn = { scriptCalls: string[][]; toasts: string[] }

const entriesUnder = (files: Map<string, string>, folder: string) => {
  const prefix = `${folder}/`

  return [...files.keys()]
    .filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
    .map(path => ({ name: path.slice(prefix.length), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false }))
}

const ran = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const standInForEngine = (on: On, files: Map<string, string>, scriptAnswer = '{}'): StandIn => {
  const standIn: StandIn = { scriptCalls: [], toasts: [] }
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
    if (e.argv[0] !== 'node') return ran(`${ROOT}/.git\n`)
    standIn.scriptCalls.push([...e.argv])

    return ran(scriptAnswer)
  })
  on('store.get', () => ({ value: true }))
  on('store.set', () => ({ value: undefined }))
  on('env.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('session.id', () => ({ value: 'session-1' }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__sidequest__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_, e) => {
    standIn.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' } }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  return standIn
}

const startSession = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

const typePrompt = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

const textOf = (answer: ToolCallResult): string => (typeof answer.result === 'string' ? answer.result : `deny: ${answer.deny}`)

const view = async ($: Engine, name: string): Promise<string> => textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: name }))

const drop = ($: Engine, id: string) => $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'drop', id }] })

const logOf = (files: Map<string, string>, id: string): string => files.get(`${TICKETS}/${id}.md`)?.split('## Log')[1] ?? ''

const droppableBoard = (): Map<string, string> =>
  new Map([
    [`${TICKETS}/SQ-1.md`, ticketFile('SQ-1', 'Retry failed uploads', 'ready', SENT_BACK_RUN)],
    [`${TICKETS}/SQ-2.md`, ticketFile('SQ-2', 'Show retry count', 'ready', [], ['SQ-1'])],
  ])

const MERGED_AND_CLEAN = JSON.stringify({
  worktrees: [{ path: WORKTREE, branch: 'worktree-agent-abc', verdict: 'safe', reasons: [] }],
  branches: [],
  removals: [{ path: WORKTREE, isRemoved: true, branch: 'worktree-agent-abc', branchDeletion: { isDeleted: true }, linksTakenAway: [] }],
  branchRemovals: [],
})

const UNMERGED = JSON.stringify({
  worktrees: [{ path: WORKTREE, branch: 'worktree-agent-abc', verdict: 'keep', reasons: ['2 commits on no remote and not merged into main'] }],
  branches: [],
  removals: [],
  branchRemovals: [],
})

test('drop on a ticket with a merged branch and a clean worktree removes both and says so', async ($, on) => {
  const files = droppableBoard()
  const standIn = standInForEngine(on, files, MERGED_AND_CLEAN)
  await startSession($)
  await typePrompt($, 'drop the upload retry, we are not doing it')

  const answer = textOf(await drop($, 'SQ-1'))

  expect(answer).toBe(
    [
      'dropped SQ-1. SQ-2 is blocked by SQ-1, which is now dropped: patch its blockedBy if it should go on without it.',
      `SQ-1: removed its worktree ${WORKTREE} and branch worktree-agent-abc.`,
    ].join('\n'),
  )
  expect(standIn.scriptCalls.map(argv => argv.slice(2))).toEqual([['--json', '--remove-safe', '--branch=worktree-agent-abc']])
  expect(files.get(`${TICKETS}/SQ-1.md`)).toContain('status: dropped')
  expect(logOf(files, 'SQ-1')).toContain(`dropped on the person's words: "drop the upload retry, we are not doing it"`)
})

test('drop on a ticket with unmerged commits keeps the branch and names it, and the ticket is offered nowhere', async ($, on) => {
  const files = droppableBoard()
  standInForEngine(on, files, UNMERGED)
  await startSession($)
  await typePrompt($, 'drop SQ-1')

  const answer = textOf(await drop($, 'SQ-1'))

  expect(answer).toContain(`SQ-1: kept its worktree ${WORKTREE} and branch worktree-agent-abc: 2 commits on no remote and not merged into main.`)
  expect(await view($, 'frontier')).toBe(['Nothing is ready to start.', 'SQ-2 waits for SQ-1, which is dropped.'].join('\n'))
  expect(await view($, 'summary')).toContain(
    [
      '0 waiting on you, 1 ready to start, 0 in progress, 0 being checked. Nothing is ready to start: of the 1 ready, none can start yet.',
      'SQ-2 waits for SQ-1, which is dropped.',
    ].join('\n'),
  )
  expect(await view($, 'now')).not.toContain('SQ-1')
  expect(await view($, 'list')).toBe(['SQ-1 dropped build Retry failed uploads', 'SQ-2 ready build Show retry count (blocked by dropped SQ-1)'].join('\n'))
})

test('drop on a ticket that never ran starts no process and says it had nothing of its own, and a move brings it back', async ($, on) => {
  const files = new Map([[`${TICKETS}/SQ-1.md`, ticketFile('SQ-1', 'Retry failed uploads', 'ready')]])
  const standIn = standInForEngine(on, files)
  await startSession($)
  await typePrompt($, 'drop it')

  expect(textOf(await drop($, 'SQ-1'))).toBe('dropped SQ-1. SQ-1 had no branch or worktree of its own.')
  expect(standIn.scriptCalls).toEqual([])
  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'move', id: 'SQ-1', status: 'ready' }] })
  expect(await view($, 'frontier')).toBe('SQ-1 ready build Retry failed uploads')
})

test('setting aside an interrupted ticket says its branch and worktree are kept', async ($, on) => {
  const files = new Map([[`${TICKETS}/SQ-1.md`, ticketFile('SQ-1', 'Retry failed uploads', 'doing', SENT_BACK_RUN)]])
  const standIn = standInForEngine(on, files)
  await startSession($)
  await typePrompt($, 'set that aside')

  const answer = textOf(await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'move', id: 'SQ-1', status: 'parked' }] }))

  expect(answer).toBe('moved SQ-1 to parked. SQ-1 is set aside: its branch worktree-agent-abc and its worktree are kept.')
  expect(standIn.scriptCalls).toEqual([])
})

test('the closing view lists what this session changed and one count line for the rest, with no old title in it', async ($, on) => {
  const files = new Map([
    [`${TICKETS}/SQ-1.md`, ticketFile('SQ-1', 'Old ready work', 'ready')],
    [`${TICKETS}/SQ-2.md`, ticketFile('SQ-2', 'Old doing work', 'doing')],
    [`${TICKETS}/SQ-3.md`, ticketFile('SQ-3', 'Old question', 'needs-you')],
    [`${TICKETS}/SQ-4.md`, ticketFile('SQ-4', 'Old parked idea', 'parked')],
    [`${TICKETS}/SQ-5.md`, ticketFile('SQ-5', 'Old finished work', 'done')],
    [`${TICKETS}/SQ-6.md`, ticketFile('SQ-6', 'Old work to finish', 'ready')],
  ])
  standInForEngine(on, files)
  await startSession($)
  await typePrompt($, 'add upload retries and finish the cleanup')
  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'create', title: 'Retry failed uploads' }] })
  await $.tool.call({ tool: 'mcp__sidequest__start', id: 'SQ-6' })
  await $.tool.call({ tool: 'mcp__sidequest__finish', id: 'SQ-6', outcome: 'done', result: 'It works.' })

  const closing = await view($, 'closing')

  expect(closing).toBe(
    [
      'What this session changed on the board:',
      '- SQ-6 Old work to finish: built, being checked, nothing was checked',
      '- SQ-7 Retry failed uploads: ready to start',
      'Also on the board from before: 1 open, 1 stopped, 1 waiting on you, 1 set aside.',
    ].join('\n'),
  )
  for (const oldTitle of ['Old ready work', 'Old doing work', 'Old question', 'Old parked idea', 'Old finished work']) expect(closing).not.toContain(oldTitle)
})

test('a session that changed nothing says so in the closing view, and an empty board says only that', async ($, on) => {
  standInForEngine(on, new Map())
  await startSession($)

  expect(await view($, 'closing')).toBe('This session changed nothing on the board.')
})

const DAY = 24 * 60 * 60 * 1000

const cardTouched = (number: number, status: string, daysAgo: number): BoardCard => ({
  id: `SQ-${number}`,
  title: `Ticket ${number}`,
  status,
  category: 'build',
  updated: '2026-11-01',
  lastTouched: new Date(NOW - daysAgo * DAY).toISOString().slice(0, 16).concat('Z'),
})

const quietContent = (cards: readonly BoardCard[]): PaneContent => ({
  cards,
  running: [],
  sessionWork: { isWorking: false, steps: 0 },
  finishedAgents: [],
  worktreeCount: 0,
  touchedHere: new Set(cards.map(card => card.id)),
  showsIntro: false,
  columns: 80,
  now: NOW,
  whatYouCouldDo: [],
})

test('the pane groups open tickets nobody touched for a week under one line at the end, and the line opens to them', () => {
  const cards = [cardTouched(1, 'ready', 10), cardTouched(2, 'review', 8), cardTouched(3, 'ready', 2), cardTouched(4, 'needs-you', 20), cardTouched(5, 'parked', 30)]

  expect(paneLinesAsText(boardPaneLines(quietContent(cards)))).toBe(
    ['Waits on you', '  SQ-4 Ticket 4  waiting 20 days, no question written yet', '', 'Nothing is running.', '', 'Next', '  SQ-3 Ticket 3', '', 'Also on the board: 1 set aside', '', '2 tickets nobody touched for a week'].join('\n'),
  )
  expect(paneLinesAsText(olderTicketLines(quietContent(cards)))).toBe(
    ['Untouched for a week', '  SQ-1 Ticket 1  ready to start, last touched 10 days ago', '  SQ-2 Ticket 2  built, being checked, last touched 8 days ago'].join('\n'),
  )
})

const PANE = {
  plugin: 'sidequest',
  component: 'Pane',
  requestId: 'board',
  props: { title: 'Board', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

test('set aside and drop pressed on an older ticket move it through the tool path and log the person pressed it', async ($, on) => {
  const files = new Map([
    [`${TICKETS}/SQ-1.md`, ticketFile('SQ-1', 'Retry failed uploads', 'ready', ['2026-11-05T09:00Z note looked at it'])],
    [`${TICKETS}/SQ-2.md`, ticketFile('SQ-2', 'Trace upload flow', 'review', ['2026-11-06T09:00Z finished done commits 1'])],
  ])
  const standIn = standInForEngine(on, files)
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Button', key: 'older' }))?.text).toContain('2 tickets nobody touched for a week')
  await ui.press({ key: 'older' })
  await ui.press({ key: 'drop-SQ-1' })
  await ui.press({ key: 'set-aside-SQ-2' })

  expect(files.get(`${TICKETS}/SQ-1.md`)).toContain('status: dropped')
  expect(logOf(files, 'SQ-1')).toContain('2026-11-19T10:00Z dropped, pressed on the board by the person')
  expect(files.get(`${TICKETS}/SQ-2.md`)).toContain('status: parked')
  expect(logOf(files, 'SQ-2')).toContain('2026-11-19T10:00Z moved review to parked, pressed on the board by the person')
  expect(standIn.toasts).toEqual([
    'SQ-1 dropped. SQ-1 had no branch or worktree of its own.',
    'SQ-2 set aside. SQ-2 is set aside: its branch and its worktree are kept.',
  ])
  await ui.unmount()
})
