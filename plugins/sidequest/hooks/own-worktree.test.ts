import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, ToolCallResult } from 'claude-code'

import { namesARepository, noGitAnswerNote, ownWorktreeSection } from './own-worktree'
import type { WaveEntry } from './wave-entry'

const ROOT = '/work/projects'
const BRIEFS = `${ROOT}/.sidequest/briefs`
const NOW = Date.parse('2026-11-20T10:02:00Z')
const WHY_NO_ISOLATION = "The board's folder has no git, so the host cannot make a worktree from here."
const NAMES_NO_REPOSITORY = "The ticket's text names no repository folder."

const portablePath = (path: string): string => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

const childrenUnder = (files: Map<string, string>, folder: string) => {
  const prefix = `${folder}/`
  const names = new Map<string, 'file' | 'dir'>()
  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    const slash = rest.indexOf('/')
    names.set(slash === -1 ? rest : rest.slice(0, slash), slash === -1 ? 'file' : 'dir')
  }

  return [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false }))
}

const gitAnswer = (subcommand: string | undefined, isRepository: boolean): { exitCode: number; stdout: string } => {
  if (subcommand !== 'rev-parse') return { exitCode: 1, stdout: '' }

  return isRepository ? { exitCode: 0, stdout: `${ROOT}/.git\n` } : { exitCode: 128, stdout: '' }
}

const standInForEngine = (on: On, files: Map<string, string>, isRepository: boolean): void => {
  on('state.set', (_, e, next) => next(e))
  on('fs.read', (_, e) => {
    const text = files.get(portablePath(e.path))

    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', (_, e) => {
    files.set(portablePath(e.path), e.text)

    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    const entries = childrenUnder(files, portablePath(e.path))

    return entries.length > 0 ? { value: entries } : { deny: `ENOENT ${e.path}` }
  })
  on('process.run', (_, e) => ({ value: { ...gitAnswer(e.argv[1], isRepository), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__sidequest__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
}

const folderWithTwoRepositories = (): Map<string, string> =>
  new Map([
    [`${ROOT}/.sidequest/board.json`, JSON.stringify({ version: 1, prefix: 'PL', nextTicket: 1, nextStory: 1 })],
    [`${ROOT}/photo-app/.git/HEAD`, 'ref: refs/heads/main'],
    [`${ROOT}/photo-api/.git`, 'gitdir: elsewhere'],
    [`${ROOT}/notes/todo.md`, 'nothing'],
  ])

const textOf = (answer: ToolCallResult): string => (typeof answer.result === 'string' ? answer.result : `deny: ${answer.deny}`)

const startSession = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

const createTicket = ($: Engine, what: string) =>
  $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'create', title: 'Retry failed uploads', what, doneWhen: '- [ ] retry test passes' }] })

const startTicket = async ($: Engine, forWave = false): Promise<string> =>
  textOf(await $.tool.call({ tool: 'mcp__sidequest__start', id: 'PL-1', ...(forWave ? { forWave } : {}) }))

const agentCallIn = (answer: string): { prompt: string; isolation?: string } =>
  JSON.parse(answer.slice(answer.indexOf('{'), answer.indexOf('\n}') + 2))

const lineAfter = (answer: string, label: string): string =>
  answer.split('\n').find(line => line.startsWith(label))?.slice(label.length) ?? '(no such line)'

test('a start on a board whose folder has no git returns no isolation, says why, and the brief tells the worker to make its own worktree', async ($, on) => {
  standInForEngine(on, folderWithTwoRepositories(), false)
  await startSession($)
  await createTicket($, 'In photo-app, uploads retry.')

  const answer = await startTicket($)
  const call = agentCallIn(answer)

  expect(call.isolation).toBe(undefined)
  expect(answer).toContain(WHY_NO_ISOLATION)
  expect(answer).toContain("its brief tells the worker to make its own worktree in the repository the ticket's work is in")
  expect(answer).not.toContain(NAMES_NO_REPOSITORY)
  expect(call.prompt).toContain(ownWorktreeSection(ROOT)[0])
  expect(call.prompt.indexOf('## No git here')).toBeLessThan(call.prompt.indexOf('## What'))
})

test('a ticket that names no repository folder is started all the same, and the answer says to add it before the call', async ($, on) => {
  standInForEngine(on, folderWithTwoRepositories(), false)
  await startSession($)
  await createTicket($, 'Uploads retry.')

  const answer = await startTicket($)

  expect(answer).toContain(WHY_NO_ISOLATION)
  expect(answer).toContain(`${NAMES_NO_REPOSITORY} Add it to the ticket`)
  expect(answer).toContain('"subagent_type": "sidequest:worker"')
})

test('a wave entry for such a ticket asks for no isolation, and the brief file carries the section', async ($, on) => {
  const files = folderWithTwoRepositories()
  standInForEngine(on, files, false)
  await startSession($)
  await createTicket($, 'In photo-api, uploads retry.')

  const answer = await startTicket($, true)
  const entry: WaveEntry = JSON.parse(lineAfter(answer, 'Entry for this ticket: '))

  expect(entry.worktree).toBe(false)
  expect(answer).toContain(WHY_NO_ISOLATION)
  expect(files.get(`${BRIEFS}/PL-1.md`)).toContain(ownWorktreeSection(ROOT)[0])
})

test('a board inside a repository starts as it always did: isolation, no section, no note', async ($, on) => {
  standInForEngine(on, folderWithTwoRepositories(), true)
  await startSession($)
  await createTicket($, 'Uploads retry.')

  const answer = await startTicket($)
  const call = agentCallIn(answer)

  expect(call.isolation).toBe('worktree')
  expect(call.prompt).not.toContain('No git here')
  expect(answer).not.toContain('has no git')
})

test('a wave entry for a board inside a repository still asks for isolation', async ($, on) => {
  standInForEngine(on, folderWithTwoRepositories(), true)
  await startSession($)
  await createTicket($, 'Uploads retry.')

  const entry: WaveEntry = JSON.parse(lineAfter(await startTicket($, true), 'Entry for this ticket: '))

  expect(entry.worktree).toBe(true)
})

test('a repository folder counts as named only as a whole word of the ticket text', () => {
  const ticket = { title: 'Retry uploads', what: 'The photo-app folder keeps retrying.', doneWhen: '' }

  expect(namesARepository(ticket, ['photo-app', 'photo-api'])).toBe(true)
  expect(namesARepository(ticket, ['photo'])).toBe(false)
  expect(namesARepository({ ...ticket, what: 'See C:\\work\\photo-app\\src.' }, ['photo-app'])).toBe(true)
  expect(namesARepository(ticket, [])).toBe(false)
})

test('the note adds the missing repository only when no repository is named', () => {
  expect(noGitAnswerNote(true)).not.toContain(NAMES_NO_REPOSITORY)
  expect(noGitAnswerNote(false)).toContain(NAMES_NO_REPOSITORY)
})
