import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, ToolCallResult } from 'claude-code'

const PROJECT = '/repo'
const OTHER_FOLDER = '/elsewhere'
const NOW = Date.parse('2026-11-20T12:00:00Z')

const portablePath = (path: string): string => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

const ticketFile = (id: string): string =>
  [
    '---',
    `id: ${id}`,
    `title: ${id} work`,
    'status: ready',
    'kind: build',
    'mode: afk',
    'category: build',
    'blockedBy: []',
    'created: 2026-11-20',
    'updated: 2026-11-20',
    '---',
    '',
    '## What',
    'It works.',
    '',
    '## Log',
    '',
  ].join('\n')

const ran = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

type SessionFolders = { root: string | undefined; workingFolder: string }

const standInForEngine = (on: On, files: Map<string, string>, folders: SessionFolders): void => {
  on('fs.read', (_, e) => {
    const text = files.get(portablePath(e.path))

    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', (_, e) => {
    files.set(portablePath(e.path), e.text)

    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    const prefix = `${portablePath(e.path)}/`
    const entries = [...files.keys()]
      .filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map(path => ({ name: path.slice(prefix.length), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false }))

    return entries.length > 0 ? { value: entries } : { deny: `ENOENT ${e.path}` }
  })
  on('process.run', (_, e) => (e.init?.cwd === PROJECT ? ran(`${PROJECT}/.git\n`) : ran('', 128)))
  on('session.cwd', () => ({ value: folders.workingFolder }))
  on('session.root', () => (folders.root === undefined ? { deny: 'no root' } : { value: folders.root }))
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
}

const projectBoard = (): Map<string, string> =>
  new Map(['SQ-1', 'SQ-2', 'SQ-3'].map(id => [`${PROJECT}/.sidequest/tickets/${id}.md`, ticketFile(id)]))

const textOf = (answer: ToolCallResult): string => (typeof answer.result === 'string' ? answer.result : `deny: ${answer.deny}`)

const view = async ($: Engine, name: string): Promise<string> => textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: name }))

const startIn = ($: Engine, cwd: string) => $.session.start({ cwd, surface: 'terminal', isInteractive: true })

test('a rerun of session.start from a folder the shell moved to still finds the board of the session root', async ($, on) => {
  standInForEngine(on, projectBoard(), { root: PROJECT, workingFolder: OTHER_FOLDER })
  await startIn($, OTHER_FOLDER)

  expect(await view($, 'summary')).toContain('0 waiting on you, 3 ready to start')
})

test('a reload with no session.start finds the board of the session root, not of the folder the shell is in', async ($, on) => {
  standInForEngine(on, projectBoard(), { root: PROJECT, workingFolder: OTHER_FOLDER })

  expect(await view($, 'summary')).toContain('0 waiting on you, 3 ready to start')
})

test('a host that gives no root falls back to the working folder', async ($, on) => {
  standInForEngine(on, projectBoard(), { root: undefined, workingFolder: PROJECT })

  expect(await view($, 'summary')).toContain('0 waiting on you, 3 ready to start')
})

test('a board with no ticket says which folder it read, in the summary and the list', async ($, on) => {
  standInForEngine(on, new Map(), { root: PROJECT, workingFolder: PROJECT })
  await startIn($, PROJECT)

  const sentence = `No ticket files in ${PROJECT}/.sidequest.`

  expect(await view($, 'summary')).toContain(sentence)
  expect(await view($, 'list')).toContain(sentence)
})

test('a board with tickets says nothing about the folder it read', async ($, on) => {
  standInForEngine(on, projectBoard(), { root: PROJECT, workingFolder: PROJECT })
  await startIn($, PROJECT)

  expect(await view($, 'summary')).not.toContain('No ticket files')
  expect(await view($, 'list')).not.toContain('No ticket files')
})
