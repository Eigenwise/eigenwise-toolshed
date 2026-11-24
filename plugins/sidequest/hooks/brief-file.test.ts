import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, ToolCallResult } from 'claude-code'

import { DEFAULT_BOARD_CONFIG } from './board-config'
import { NO_PROVIDERS } from './routing'
import { startTicket as startTicketOn } from './run-tools'
import type { BoardFiles } from './store'
import { newTicket } from './tickets'
import type { Ticket } from './tickets'
import type { WaveEntry } from './wave-entry'

const ROOT = '/work/photo-library'
const BRIEFS = `${ROOT}/.sidequest/briefs`
const NOW = Date.parse('2026-11-20T10:02:00Z')

const portablePath = (path: string): string => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

const entriesUnder = (files: Map<string, string>, folder: string) => {
  const prefix = `${folder}/`

  return [...files.keys()]
    .filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
    .map(path => ({ name: path.slice(prefix.length), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false }))
}

const gitAnswer = (subcommand: string | undefined): { exitCode: number; stdout: string } =>
  subcommand === 'rev-parse' ? { exitCode: 0, stdout: `${ROOT}/.git\n` } : { exitCode: 1, stdout: '' }

const standInForEngine = (on: On, files: Map<string, string>, unwritablePart?: string): void => {
  on('state.set', (_, e, next) => next(e))
  on('fs.read', (_, e) => {
    const text = files.get(portablePath(e.path))

    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', (_, e) => {
    if (unwritablePart !== undefined && portablePath(e.path).includes(unwritablePart)) return { deny: `EACCES ${e.path}` }
    files.set(portablePath(e.path), e.text)

    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    const entries = entriesUnder(files, portablePath(e.path))

    return entries.length > 0 ? { value: entries } : { deny: `ENOENT ${e.path}` }
  })
  on('process.run', (_, e) => ({ value: { ...gitAnswer(e.argv[1]), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__sidequest__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
}

const boardWithPrefix = (prefix: string): Map<string, string> =>
  new Map([[`${ROOT}/.sidequest/board.json`, JSON.stringify({ version: 1, prefix, nextTicket: 1, nextStory: 1 })]])

const textOf = (answer: ToolCallResult): string => (typeof answer.result === 'string' ? answer.result : `deny: ${answer.deny}`)

const startSession = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

const createTickets = async ($: Engine, count: number): Promise<void> => {
  const operations = Array.from({ length: count }, (_, index) => ({
    op: 'create',
    title: `Retry failed uploads ${index + 1}`,
    what: 'Uploads retry.',
    doneWhen: '- [ ] retry test passes',
  }))
  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations })
}

const startTicket = async ($: Engine, id: string, forWave = true): Promise<string> =>
  textOf(await $.tool.call({ tool: 'mcp__sidequest__start', id, ...(forWave ? { forWave } : {}) }))

const agentCallIn = (answer: string): { prompt: string } => JSON.parse(answer.slice(answer.indexOf('{'), answer.indexOf('\n}') + 2))

const WINDOWS_BRIEF_PATH = 'C:\\work\\photo "library"\\.sidequest\\briefs\\PL-9.md'

const filesWithTickets = (tickets: Ticket[]): BoardFiles => ({ config: DEFAULT_BOARD_CONFIG, configText: undefined, tickets, stories: [] })

const waveAnswerFor = (ticket: Ticket): string => {
  const outcome = startTicketOn(
    { id: ticket.id, forWave: true },
    filesWithTickets([ticket]),
    NO_PROVIDERS,
    '2026-11-20T10:01Z',
    { briefPath: WINDOWS_BRIEF_PATH },
  )

  return 'text' in outcome.answer ? outcome.answer.text : `refused: ${outcome.answer.refusal}`
}

test('a brief file that cannot be written is said, and the ticket still starts', async ($, on) => {
  const files = boardWithPrefix('PL')
  standInForEngine(on, files, '/briefs/')
  await startSession($)
  await createTickets($, 1)

  const answer = await startTicket($, 'PL-1')

  expect(answer).toContain('The brief file could not be written')
  expect(files.get(`${ROOT}/.sidequest/tickets/PL-1.md`)).toContain('status: doing')
})

const lineAfter = (answer: string, label: string): string =>
  answer.split('\n').find(line => line.startsWith(label))?.slice(label.length) ?? '(no such line)'

const entryIn = (answer: string): WaveEntry => JSON.parse(lineAfter(answer, 'Entry for this ticket: '))

for (const prefix of ['SQ', 'PL']) {
  test(`${prefix}-1 with forWave keeps the brief the plain start prints in a file and gives the wave entry for it`, async ($, on) => {
    const files = boardWithPrefix(prefix)
    standInForEngine(on, files)
    await startSession($)
    await createTickets($, 1)

    const printed = agentCallIn(await startTicket($, `${prefix}-1`, false))
    const answer = await startTicket($, `${prefix}-1`)
    const entry = entryIn(answer)

    expect(portablePath(entry.briefFile)).toBe(`${BRIEFS}/${prefix}-1.md`)
    expect(files.get(`${BRIEFS}/${prefix}-1.md`)).toBe(printed.prompt)
    expect(printed.prompt.startsWith(`Ticket ${prefix}-1: Retry failed uploads 1`)).toBe(true)
    expect(entry).toMatchObject({ id: `${prefix}-1`, title: 'Retry failed uploads 1', agentType: 'sidequest:worker', worktree: true, review: true })
  })
}

test('the brief folder ignores itself, so a committed board never shows a brief in git status', async ($, on) => {
  const files = boardWithPrefix('PL')
  standInForEngine(on, files)
  await startSession($)
  await createTickets($, 1)

  await startTicket($, 'PL-1')

  expect(files.get(`${BRIEFS}/.gitignore`)).toBe('*\n')
})

test('starting a ticket again overwrites its brief, so the folder holds one file for each ticket and nothing more', async ($, on) => {
  const files = boardWithPrefix('PL')
  standInForEngine(on, files)
  await startSession($)
  await createTickets($, 2)

  await startTicket($, 'PL-1')
  await startTicket($, 'PL-2')
  await startTicket($, 'PL-1')
  await startTicket($, 'PL-1')

  expect(entriesUnder(files, BRIEFS).map(entry => entry.name).sort()).toEqual(['.gitignore', 'PL-1.md', 'PL-2.md'])
})

test('the wave answer prints neither the brief nor the Agent call, and a ticket not run in a wave writes no file and prints both', async ($, on) => {
  const files = boardWithPrefix('PL')
  standInForEngine(on, files)
  await startSession($)
  await createTickets($, 2)

  const inWave = await startTicket($, 'PL-1')
  const alone = await startTicket($, 'PL-2', false)

  expect(inWave).not.toContain('## What')
  expect(inWave).not.toContain('Make this Agent call')
  expect(inWave.startsWith('PL-1 is now doing.')).toBe(true)
  expect(alone).toContain('Make this Agent call as given:')
  expect(alone).toContain('## What')
  expect(files.get(`${BRIEFS}/PL-2.md`)).toBe(agentCallIn(alone).prompt)
})

const createTicketOfKind = ($: Engine, kind: string) =>
  $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'create', title: 'Look into retries', kind, what: 'Find out.', doneWhen: '- [ ] answer' }] })

const KEPT_BRIEF_LINE = `The brief is also kept in ${BRIEFS}/PL-1.md: name that file to the reviewer`

test('a build ticket start ends with the kept brief line after the Agent call, and a research ticket gets the file and no line', async ($, on) => {
  const files = boardWithPrefix('PL')
  standInForEngine(on, files)
  await startSession($)
  await createTickets($, 1)
  await createTicketOfKind($, 'research')

  const build = await startTicket($, 'PL-1', false)
  const research = await startTicket($, 'PL-2', false)

  expect(build.indexOf(KEPT_BRIEF_LINE)).toBeGreaterThan(build.lastIndexOf('}'))
  expect(research).not.toContain('The brief is also kept in')
  expect(files.has(`${BRIEFS}/PL-2.md`)).toBe(true)
})

test('the worktree folder notice is on the first start and not on the second', async ($, on) => {
  const files = boardWithPrefix('PL')
  files.set(`${ROOT}/.git/info/exclude`, '# kept\n')
  standInForEngine(on, files)
  await startSession($)
  await createTickets($, 2)

  const first = await startTicket($, 'PL-1', false)
  const second = await startTicket($, 'PL-2', false)

  expect(first).toContain('Added .claude/worktrees/ to .git/info/exclude')
  expect(second).not.toContain('Added .claude/worktrees/')
  expect(files.get(`${ROOT}/.git/info/exclude`)).toBe('# kept\n.claude/worktrees/\n')
})

test('the answer carries the review route of the board, so a wave needs no routing call', async ($, on) => {
  const files = boardWithPrefix('PL')
  standInForEngine(on, files)
  await startSession($)
  await createTickets($, 1)

  const answer = await startTicket($, 'PL-1')
  const reviewTier = DEFAULT_BOARD_CONFIG.tiers[DEFAULT_BOARD_CONFIG.categories.review?.tier ?? '']

  expect(JSON.parse(lineAfter(answer, 'reviewRoute: '))).toEqual({ model: reviewTier?.model, effort: reviewTier?.effort })
})

test('the entry parses back with every field, for a title with a double quote and a path with backslashes', () => {
  const ticket = newTicket('PL-9', { title: 'Fix the "retry" count', category: 'build' }, '2026-11-20T10:00Z')
  const answer = waveAnswerFor(ticket)

  expect(entryIn(answer)).toEqual({
    id: 'PL-9',
    title: 'Fix the "retry" count',
    briefFile: WINDOWS_BRIEF_PATH,
    agentType: 'sidequest:worker',
    model: 'sonnet',
    effort: 'medium',
    worktree: true,
    review: true,
  })
})

test('a quick ticket and an outside-code ticket are entered with review false', () => {
  const quick = entryIn(waveAnswerFor(newTicket('PL-9', { title: 'Typo', category: 'quick' }, '2026-11-20T10:00Z')))
  const outside = entryIn(waveAnswerFor(newTicket('PL-9', { title: 'Check a script', category: 'outside-code' }, '2026-11-20T10:00Z')))

  expect([quick.review, outside.review]).toEqual([false, false])
  expect(outside.agentType).toBe('sidequest:outside-code-reviewer')
})

// The routing hook sets the same model and effort from a route tag that the workflow names explicitly, so the tag only changes the log's category: the entry carries none.
test('a ticket whose category has no route is entered on the fallback route, and the explicit model and effort decide the run', () => {
  const entry = entryIn(waveAnswerFor(newTicket('PL-9', { title: 'Tidy', category: 'misc' }, '2026-11-20T10:00Z')))

  expect(entry).toMatchObject({ agentType: 'sidequest:worker', model: 'sonnet', effort: 'medium' })
})
