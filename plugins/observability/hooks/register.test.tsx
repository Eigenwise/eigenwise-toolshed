import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'

const TYPED_IN_COMPOSER = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }
const REPOSITORY = { root: '/work/demo', remote: null, internal: false, name: 'demo' }
const LEDGER_FOLDER = '/cfg/observability/ledger'
const LEDGER_PATH = `${LEDGER_FOLDER}/demo-7b8bd8.session-1.jsonl`
const BOARD_PATH = '/cfg/observability/board.html'
const NOW = Date.parse('2026-11-20T12:00:00.000Z')

const portablePath = (path: string) => path.replaceAll('\\', '/').replace(/^[A-Za-z]:/, '')

type SessionOptions = {
  cost?: { usd: number } | undefined
  env?: Record<string, string>
  statuses?: string[]
  isWriteFailing?: () => boolean
  store?: Record<string, unknown>
  sessionId?: () => string
  processRuns?: string[][]
}

const listingOf = (files: Map<string, string>, folder: string) =>
  [...files.keys()]
    .filter(path => path.startsWith(`${folder}/`) && !path.slice(folder.length + 1).includes('/'))
    .map(path => ({ name: path.slice(folder.length + 1), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false }))

function fakeSession(on: On, options: SessionOptions = { cost: { usd: 0.75 } }) {
  mock.store(on, options.store ?? {})
  mock.env(on, options.env ?? { CLAUDE_CONFIG_DIR: '/cfg' })
  on('session.repo', () => ({ value: REPOSITORY }))
  const files = new Map<string, string>()
  on('fs.exists', (_, event) => ({ value: files.has(portablePath(event.path)) }))
  on('fs.read', (_, event) => ({ value: files.get(portablePath(event.path)) ?? '' }))
  on('fs.list', (_, event) => ({ value: listingOf(files, portablePath(event.path)) }))
  on('fs.write', (_, event) => {
    if (options.isWriteFailing?.()) return { deny: 'disk full' }
    files.set(portablePath(event.path), event.text)
    return { value: undefined }
  })
  on('process.run', (_, event) => {
    options.processRuns?.push([...event.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  mock.clock(on, { now: NOW })
  on('ui.status', (_, event) => {
    options.statuses?.push(event.text ?? '')
    return { value: undefined }
  })
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-1' }))
  on('prompt.submit', (_, event) => ({ text: event.text }))
  on('turn.complete', (_, event) => ({ text: event.answer }))
  on('session.usage', () => ({ value: { startedAt: 1000, context: { window: 200000, tokens: 5000, percent: 2.5 }, rateLimits: [], cost: options.cost } }))
  on('session.id', () => ({ value: options.sessionId?.() ?? 'session-1' }))
  on('session.turns', () => ({ value: 1 }))
  on('session.model', () => ({ value: 'claude-opus' }))
  on('session.version', () => ({ value: { version: '2.1.325' } }))
  return files
}

const rowsIn = (files: Map<string, string>, path: string) =>
  (files.get(path) ?? '')
    .trim()
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line))

const rowsOf = (files: Map<string, string>) => rowsIn(files, LEDGER_PATH)

const track = async ($: Engine, args: string) => (await $.command.run({ command: 'track', args, ...TYPED_IN_COMPOSER })).text ?? ''

const board = async ($: Engine, origin: PromptOrigin) =>
  (await $.command.run({ command: 'usage-page', args: '', origin, presentation: TYPED_IN_COMPOSER.presentation })).text ?? ''

const finishTurn = ($: Engine, turnId: string) => $.turn.complete({ answer: 'done', durationMs: 900, isAborted: false, turnId, reason: 'answer' })

const submit = ($: Engine, text: string, origin: PromptOrigin) => $.prompt.submit({ text, origin, wait: false })

test('track reports, switches on and switches off recording for the project, and says where the ledger is', async ($, on) => {
  fakeSession(on)

  expect(await track($, 'status')).toBe(`observability: not recording turns for /work/demo. Switched on with /track on, it records into ${LEDGER_PATH}`)
  expect(await track($, 'on')).toBe(`observability: recording turns for /work/demo, into ${LEDGER_PATH}`)
  expect(await track($, '')).toContain(`into ${LEDGER_PATH}`)
  expect(await track($, 'off')).toContain('not recording')
  expect(await track($, 'sideways')).toBe('Usage: /track on|off|status')
})

test('a command name another plugin holds costs that one command, and the other still runs', async ($, on) => {
  const statuses: string[] = []
  fakeSession(on, { cost: { usd: 0.75 }, statuses })
  on('command.register', (_, event) => {
    if (event.name === 'usage-page') throw new Error('"/usage-page" refused: another plugin registered it already')
    return { value: { command: event.name } }
  })

  on('session.start', (_, event) => ({ cwd: event.cwd }))

  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })

  expect(statuses).toEqual(["observability: /usage-page already belongs to another plugin here, so observability's does not run"])
  expect(await track($, 'on')).toBe(`observability: recording turns for /work/demo, into ${LEDGER_PATH}`)
})

test('after a refused command the session start still reads the cost so far, so the first turn costs its own share', async ($, on) => {
  const files = fakeSession(on, { cost: { usd: 0.75 }, store: { 'track:/work/demo': true } })
  on('command.register', (_, event) => {
    if (event.name === 'usage-page') throw new Error('"/usage-page" refused: another plugin registered it already')
    return { value: { command: event.name } }
  })
  on('session.start', (_, event) => ({ cwd: event.cwd }))

  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })
  await submit($, 'fix it now', { kind: 'composer' })
  await finishTurn($, 't1')

  expect(rowsOf(files)[0].turnCostUsd).toBe(0)
})

test('with both command names held elsewhere the status line names both', async ($, on) => {
  const statuses: string[] = []
  fakeSession(on, { cost: { usd: 0.75 }, statuses })
  on('command.register', () => {
    throw new Error('refused: another plugin registered it already')
  })
  on('session.start', (_, event) => ({ cwd: event.cwd }))

  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })

  expect(statuses).toEqual(["observability: /track and /usage-page already belong to another plugin here, so observability's do not run"])
})

test('the commands are the bare names track and usage-page, never board', async ($, on) => {
  fakeSession(on)
  const registered: string[] = []
  on('command.register', (_, event) => {
    registered.push(event.name)
    return { value: { command: event.name } }
  })

  on('session.start', (_, event) => ({ cwd: event.cwd }))

  await $.session.start({ cwd: '/work/demo', surface: 'terminal', isInteractive: true })

  expect(registered).toEqual(['track', 'usage-page'])
})

test('nothing is written while recording is off', async ($, on) => {
  const files = fakeSession(on)

  await submit($, 'SQ-12 fix it now', { kind: 'composer' })
  await finishTurn($, 't1')

  expect([...files.keys()]).toEqual([])
})

test('nothing is written after recording is switched off again', async ($, on) => {
  const files = fakeSession(on)
  await track($, 'on')
  await track($, 'off')

  await finishTurn($, 't1')

  expect([...files.keys()]).toEqual([])
})

test('a project the older plugin switched on keeps recording after the update', async ($, on) => {
  const files = fakeSession(on, { cost: { usd: 0.75 }, store: { 'track:/work/demo': true } })

  await finishTurn($, 't1')

  expect(rowsOf(files).length).toBe(1)
  expect(await track($, 'status')).toContain('observability: recording turns for /work/demo')
})

test('one row per completed turn while recording is on', async ($, on) => {
  const files = fakeSession(on)
  await track($, 'on')

  await submit($, 'SQ-12 fix it now\nplease', { kind: 'composer' })
  await finishTurn($, 't1')
  await finishTurn($, 't2')

  const rows = rowsOf(files)
  expect([...files.keys()]).toEqual([LEDGER_PATH])
  expect(rows.length).toBe(2)
  expect(rows[0]).toMatchObject({ v: 1, name: 'SQ-12 fix it now', ticket: 'SQ-12', project: 'demo-7b8bd8', session: 'session-1', reason: 'answer', durationMs: 900, model: 'claude-opus', costUsd: 0.75 })
  expect(rows[1].turnCostUsd).toBe(0)
})

test('two sessions in one project each write their own file, so neither loses the other’s rows', async ($, on) => {
  let sessionId = 'session-1'
  const files = fakeSession(on, { cost: { usd: 0.75 }, sessionId: () => sessionId })
  await track($, 'on')

  await finishTurn($, 't1')
  sessionId = 'session-2'
  await finishTurn($, 't2')
  sessionId = 'session-1'
  await finishTurn($, 't3')

  expect(rowsIn(files, LEDGER_PATH).length).toBe(2)
  expect(rowsIn(files, `${LEDGER_FOLDER}/demo-7b8bd8.session-2.jsonl`).length).toBe(1)
})

test('the session is named only from a prompt the person typed', async ($, on) => {
  const files = fakeSession(on)
  await track($, 'on')

  await submit($, 'Message from another session', { kind: 'peer' })
  await submit($, 'A background task finished', { kind: 'task-notification' })
  await submit($, 'PL-4 the person’s own words', { kind: 'composer' })
  await finishTurn($, 't1')

  expect(rowsOf(files)[0]).toMatchObject({ name: 'PL-4 the person’s own words', ticket: 'PL-4' })
})

test('a headless run names its session from its prompt', async ($, on) => {
  const files = fakeSession(on)
  await track($, 'on')

  await submit($, 'Run the nightly check', { kind: 'sdk' })
  await finishTurn($, 't1')

  expect(rowsOf(files)[0].name).toBe('Run the nightly check')
})

test('a row leaves the cost out when the engine gives none', async ($, on) => {
  const files = fakeSession(on, { cost: undefined })
  await track($, 'on')

  await finishTurn($, 't1')

  const [row] = rowsOf(files)
  expect(row.v).toBe(1)
  expect(row).not.toHaveProperty('costUsd')
  expect(row).not.toHaveProperty('turnCostUsd')
})

const spawnRoutedAgent = async ($: Engine) => {
  await $.agent.spawn({
    tool_use_id: 'toolu-1',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    prompt: '[route:build] do it',
    description: 'do it',
    parentModel: 'claude-opus',
    background: false,
    fork: false,
  })
}

test('spawned agents carry their routing when Sidequest publishes runs', async ($, on) => {
  const files = fakeSession(on)
  on('state.get', { plugin: 'sidequest', key: 'runs' }, () => ({
    value: { value: { 'agent-1': { ticket: 'SQ-7', category: 'build', model: 'claude-sonnet-5-5', requestedModel: 'sonnet', effort: 'medium' } }, version: 1 },
  }))
  await track($, 'on')

  await spawnRoutedAgent($)
  await finishTurn($, 't1')

  const [row] = rowsOf(files)
  expect(row.agents).toEqual({ 'general-purpose': 1 })
  expect(row.spawns).toEqual([
    { agentId: 'agent-1', agentType: 'general-purpose', resolvedModel: 'claude-sonnet-5-5', ticket: 'SQ-7', category: 'build', model: 'claude-sonnet-5-5', requestedModel: 'sonnet' },
  ])
})

test('without Sidequest the row has no spawns field', async ($, on) => {
  const files = fakeSession(on)
  await track($, 'on')

  await spawnRoutedAgent($)
  await finishTurn($, 't1')

  const [row] = rowsOf(files)
  expect(row.agents).toEqual({ 'general-purpose': 1 })
  expect(row).not.toHaveProperty('spawns')
})

test('a later turn does not inherit the ticket an earlier prompt named', async ($, on) => {
  const files = fakeSession(on)
  await track($, 'on')

  await submit($, 'SQ-12 fix it now', { kind: 'composer' })
  await finishTurn($, 't1')
  await submit($, 'Something else', { kind: 'composer' })
  await finishTurn($, 't2')

  const rows = rowsOf(files)
  expect(rows[0].ticket).toBe('SQ-12')
  expect(rows[1]).not.toHaveProperty('ticket')
  expect(rows[1].name).toBe('SQ-12 fix it now')
})

test('a clear starts the next task with a fresh name and ticket', async ($, on) => {
  const files = fakeSession(on)
  on('session.end', () => ({ sessionId: 'session-1' }))
  await track($, 'on')

  await submit($, 'First task', { kind: 'composer' })
  await finishTurn($, 't1')
  await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: { id: 'session-1' } })
  await submit($, 'Second task', { kind: 'composer' })
  await finishTurn($, 't2')

  expect(rowsOf(files).map(row => row.name)).toEqual(['First task', 'Second task'])
})

test('a ledger past 3 MiB is rolled aside before the new row', async ($, on) => {
  const files = fakeSession(on)
  const bigLine = `${JSON.stringify({ at: '2026-11-01T00:00:00.000Z', pad: 'é'.repeat(1024 * 1024) })}\n`
  files.set(LEDGER_PATH, bigLine.repeat(2))
  await track($, 'on')

  await finishTurn($, 't1')

  const rolled = [...files.keys()].filter(key => key !== LEDGER_PATH)
  expect(rolled.length).toBe(1)
  expect(rolled[0]).toMatch(/demo-7b8bd8\.session-1\.\d+\.jsonl$/)
  expect(rowsOf(files).length).toBe(1)
})

test('a ledger another session or the older plugin wrote is never rewritten', async ($, on) => {
  const files = fakeSession(on)
  const olderLedger = `${LEDGER_FOLDER}/demo-7b8bd8.jsonl`
  const olderRow = `${JSON.stringify({ at: '2026-11-01T00:00:00.000Z' })}\n`
  files.set(olderLedger, olderRow)
  await track($, 'on')

  await finishTurn($, 't1')

  expect(files.get(olderLedger)).toBe(olderRow)
  expect(rowsOf(files).length).toBe(1)
})

test('with no config folder and no home nothing is written and the person is told', async ($, on) => {
  const statuses: string[] = []
  const files = fakeSession(on, { env: {}, statuses })
  await track($, 'on')

  await finishTurn($, 't1')

  expect([...files.keys()]).toEqual([])
  expect(statuses.join(' ')).toContain('no config or home folder')
})

test('a failed ledger write says why, and the next good write clears the status', async ($, on) => {
  const statuses: string[] = []
  let isDiskFull = true
  const files = fakeSession(on, { statuses, isWriteFailing: () => isDiskFull })
  await track($, 'on')

  await finishTurn($, 't1')
  isDiskFull = false
  await finishTurn($, 't2')

  expect(statuses[0]).toContain('could not write the ledger')
  expect(statuses[0]).toContain('disk full')
  expect(statuses.at(-1)).toBe('')
  expect(rowsOf(files).length).toBe(1)
})

const olderRow = (name: string, at: string) => JSON.stringify({ v: 1, at, project: 'demo-7b8bd8', session: name, startedAt: Date.parse(at), name, reason: 'answer', quality: { ccMax: 8 } })

test('a finished turn never writes the usage page, so a run that ends early leaves no page half written', async ($, on) => {
  const files = fakeSession(on)
  await track($, 'on')

  await finishTurn($, 't1')
  await finishTurn($, 't2')

  expect(files.has(BOARD_PATH)).toBe(false)
})

test('the usage page from the terminal is written in one write and opened', async ($, on) => {
  const processRuns: string[][] = []
  const files = fakeSession(on, { env: { CLAUDE_CONFIG_DIR: '/cfg', OS: 'Windows_NT' }, processRuns })
  files.set(`${LEDGER_FOLDER}/demo-7b8bd8.session-1.jsonl`, `${olderRow('Per-session ledger', '2026-11-19T10:00:00.000Z')}\n`)

  expect(await board($, { kind: 'composer' })).toBe(`observability: usage page written to ${BOARD_PATH}`)
  expect(files.get(BOARD_PATH)).toContain('Per-session ledger')
  expect(processRuns.length).toBe(1)
})

test('the usage page asked for from a phone, a headless run or a plugin is written and not opened', async ($, on) => {
  const processRuns: string[][] = []
  const files = fakeSession(on, { env: { CLAUDE_CONFIG_DIR: '/cfg', OS: 'Windows_NT' }, processRuns })
  const elsewhere: PromptOrigin[] = [{ kind: 'bridge' }, { kind: 'sdk' }, { kind: 'plugin', name: 'other' }]

  for (const origin of elsewhere) expect(await board($, origin)).toBe(`observability: usage page written to ${BOARD_PATH} on this computer; open it there.`)

  expect(files.has(BOARD_PATH)).toBe(true)
  expect(processRuns).toEqual([])
})

test('the usage page reads both ledger forms, and the older plugin’s folder under HOME when USERPROFILE differs', async ($, on) => {
  const files = fakeSession(on, { env: { HOME: '/home-folder', USERPROFILE: '/profile-folder' } })
  const olderFolder = '/home-folder/.claude/observability/ledger'
  files.set(`${olderFolder}/demo-7b8bd8.jsonl`, `${olderRow('Older single ledger', '2026-11-18T10:00:00.000Z')}\n`)
  files.set(`${olderFolder}/demo-7b8bd8.1762200000000.jsonl`, `${olderRow('Older rolled aside', '2026-11-17T10:00:00.000Z')}\n`)
  files.set('/profile-folder/.claude/observability/ledger/demo-7b8bd8.session-1.jsonl', `${olderRow('Per-session ledger', '2026-11-19T10:00:00.000Z')}\n`)

  expect(await board($, { kind: 'sdk' })).toContain('/profile-folder/.claude/observability/board.html')

  const page = files.get('/profile-folder/.claude/observability/board.html') ?? ''
  expect(page).toContain('Older single ledger')
  expect(page).toContain('Older rolled aside')
  expect(page).toContain('Per-session ledger')
})
