import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { TIDY_REQUEST_LINE } from './worktree-count'

const ROOT = '/repo'
const WORKTREES = `${ROOT}/.git/worktrees`

const PANE = {
  plugin: 'sidequest',
  component: 'Pane',
  requestId: 'board',
  surface: 'terminal',
  props: {
    title: 'Board',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const portablePath = (path: string): string => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

type EngineStandIn = { toasts: string[]; submitted: string[]; session: { id: string } }

const worktreeFolders = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ name: `wt-${index}`, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }))

const standInForEngine = (on: On, linkedWorktrees: number): EngineStandIn => {
  const standIn: EngineStandIn = { toasts: [], submitted: [], session: { id: 'session-1' } }
  on('fs.read', (_, e) => ({ deny: `ENOENT ${e.path}` }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', (_, e) => (portablePath(e.path) === WORKTREES ? { value: worktreeFolders(linkedWorktrees) } : { deny: `ENOENT ${e.path}` }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: `${ROOT}/.git\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('env.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: Date.parse('2026-11-18T10:00:00Z') }))
  on('session.id', () => ({ value: standIn.session.id }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__sidequest__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.toast', (_, e) => {
    standIn.toasts.push(e.text)

    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    standIn.submitted.push(e.text)

    return { text: e.text }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  return standIn
}

const startSession = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

test('five linked worktrees raise one toast per session naming the tidy skill', async ($, on) => {
  const standIn = standInForEngine(on, 5)
  await startSession($)
  await startSession($)

  expect(standIn.toasts).toEqual([
    '5 worktrees sit beside this checkout. The tidy skill (/sidequest:tidy) says which are finished and removes those on your yes.',
  ])

  standIn.session.id = 'session-2'
  await startSession($)
  expect(standIn.toasts.length).toBe(2)
})

test('four linked worktrees raise no toast and draw no row', async ($, on) => {
  const standIn = standInForEngine(on, 4)
  await startSession($)

  expect(standIn.toasts).toEqual([])
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Button', key: 'tidy-worktrees' })).toBeUndefined()
  await ui.unmount()
})

test('the board pane shows the count and its Tidy press asks the session in the person\'s name', async ($, on) => {
  const standIn = standInForEngine(on, 7)
  await startSession($)

  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /leftover git worktrees/ }))?.text).toBe('7 leftover git worktrees from finished work')
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Nothing is running.')
  await ui.press({ key: 'tidy-worktrees' })
  await ui.unmount()

  expect(standIn.submitted).toEqual([TIDY_REQUEST_LINE])
})
