import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, ToolCallResult } from 'claude-code'
import type { ProcessRunResult } from 'claude-code'

import { withBareRepositoryRoot } from './board-root'
import { boardLocationFrom } from './store'

const gitAnswerOf = (stdout: string, exitCode = 0): ProcessRunResult => ({
  exitCode,
  stdout,
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

const BARE_CONFIG = '[core]\n\trepositoryformatversion = 0\n\tbare = true\n'
const ORDINARY_CONFIG = '[core]\n\trepositoryformatversion = 0\n\tbare = false\n'

const rootFor = (cwd: string, gitFolders: string, configText?: string): string =>
  withBareRepositoryRoot(boardLocationFrom(cwd, gitAnswerOf(gitFolders)), configText).root

test('an ordinary repository and a linked worktree of one keep the main checkout as the root', () => {
  expect(rootFor('/repo', '/repo/.git\n/repo/.git\n', ORDINARY_CONFIG)).toBe('/repo')
  expect(rootFor('/repo/src', '/repo/.git\n/repo/.git\n', ORDINARY_CONFIG)).toBe('/repo')
  expect(rootFor('/trees/feature', '/repo/.git\n/repo/.git/worktrees/feature\n', ORDINARY_CONFIG)).toBe('/repo')
})

test('a folder with no git keeps the working folder as the root', () => {
  expect(withBareRepositoryRoot(boardLocationFrom('/loose', gitAnswerOf('', 128)), undefined)).toEqual({ root: '/loose' })
  expect(withBareRepositoryRoot(boardLocationFrom('/loose', undefined), undefined)).toEqual({ root: '/loose' })
})

test('two worktrees of one bare repository get one root, the bare folder', () => {
  const first = rootFor('/p/wt1', '/p/uploads.git\n/p/uploads.git/worktrees/wt1\n', BARE_CONFIG)
  const second = rootFor('/p/wt2', '/p/uploads.git\n/p/uploads.git/worktrees/wt2\n', BARE_CONFIG)

  expect(first).toBe('/p/uploads.git')
  expect(second).toBe(first)
  expect(rootFor('/p/uploads.git', '/p/uploads.git\n/p/uploads.git\n', BARE_CONFIG)).toBe(first)
})

test('a git folder that is not a .git folder and is not bare keeps the working folder, as a submodule does', () => {
  const submodule = '/super/.git/modules/sub\n/super/.git/modules/sub\n'

  expect(rootFor('/super/sub', submodule, ORDINARY_CONFIG)).toBe('/super/sub')
  expect(rootFor('/super/sub', submodule, undefined)).toBe('/super/sub')
})

const PARENT = '/p'
const BARE = `${PARENT}/uploads.git`

const portablePath = (path: string): string => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

const entriesUnder = (files: Map<string, string>, folder: string) => {
  const prefix = `${folder}/`

  return [...files.keys()]
    .filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
    .map(path => ({ name: path.slice(prefix.length), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false }))
}

const standInForBareRepository = (on: On, files: Map<string, string>): void => {
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
    const worktree = portablePath(e.init?.cwd ?? '').split('/').at(-1)
    const answer = e.argv.includes('--git-common-dir') ? gitAnswerOf(`${BARE}\n${BARE}/worktrees/${worktree}\n`) : gitAnswerOf('', 128)

    return { value: answer }
  })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home' : undefined }))
  on('clock.now', () => ({ value: Date.parse('2026-11-20T10:02:00Z') }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__sidequest__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('store.get', () => ({ value: true }))
}

const textOf = (answer: ToolCallResult): string => (typeof answer.result === 'string' ? answer.result : `deny: ${answer.deny}`)

const startIn = ($: Engine, cwd: string) => $.session.start({ cwd, surface: 'terminal', isInteractive: true })

const create = ($: Engine, title: string) => $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'create', title }] })

test('sessions in two worktrees of a bare repository file into one board inside the bare folder, with one numbering and a prefix from the project name', async ($, on) => {
  const files = new Map<string, string>([[`${BARE}/config`, BARE_CONFIG]])
  standInForBareRepository(on, files)

  await startIn($, `${PARENT}/wt1`)
  const first = textOf(await create($, 'From the first worktree'))
  await startIn($, `${PARENT}/wt2`)
  const second = textOf(await create($, 'From the second worktree'))

  expect(first).toContain('created UPL-1.')
  expect(first).toContain('UPL comes from the folder name uploads.')
  expect(second).toBe('created UPL-2.')
  expect([...files.keys()].filter(path => path.includes('.sidequest')).sort()).toEqual([
    `${BARE}/.sidequest/board.json`,
    `${BARE}/.sidequest/tickets/UPL-1.md`,
    `${BARE}/.sidequest/tickets/UPL-2.md`,
  ])
  expect([...files.keys()].some(path => path.startsWith(`${PARENT}/wt`))).toBe(false)
  expect([...files.keys()].some(path => path.endsWith('info/exclude'))).toBe(false)
})
