import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentSpawnInput, On, ToolCallResult, ToolSpec } from 'claude-code'

import { boardConfigProblems, DEFAULT_BOARD_CONFIG, mergeBoardConfig } from './board-config'
import { boardIdsOf, EARLIER_BOARD_IDS, isTicketIdOn } from './board-ids'
import { choosePrefix, prefixCandidatesFor } from './board-prefix'
import { trackerKeyFor } from './branch-and-issue'
import { newTicket, parseTicket, serializeTicket } from './tickets'
import { SIDEQUEST_TOOLS } from './tool-specs'
import { boardCards } from './views/board-view'
import { boardPaneLines, paneLinesAsText } from './views/pane-sections'
import { boardToolRow } from './views/tool-rows'

const ROOT = '/work/photo-library'
const TICKETS = `${ROOT}/.sidequest/tickets`
const STORIES = `${ROOT}/.sidequest/stories`
const BOARD_JSON = `${ROOT}/.sidequest/board.json`
const NOW = Date.parse('2026-11-16T10:02:00Z')
const EXCLUDE_NOTICE = 'Added .sidequest/ to .git/info/exclude so the board stays out of git: it is personal, and a team shares work through its tracker.'

const prefixNote = (prefix: string, passedOver = ''): string =>
  `This board numbers its tickets ${prefix}-1, ${prefix}-2 and on, and its stories ${prefix}-S1 and on: ${prefix} comes from the folder name photo-library.${passedOver} The prefix is kept as "prefix" in .sidequest/board.json. To use other letters, change it there now, before there are many tickets.`

const portablePath = (path: string): string => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

const entriesUnder = (files: Map<string, string>, folder: string) => {
  const prefix = `${folder}/`

  return [...files.keys()]
    .filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
    .map(path => ({ name: path.slice(prefix.length), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false }))
}

const gitAnswer = (argv: readonly string[], branchNames: readonly string[]): { exitCode: number; stdout: string } => {
  if (argv[1] === 'rev-parse') return { exitCode: 0, stdout: `${ROOT}/.git\n` }
  if (argv[1] === 'for-each-ref') return { exitCode: 0, stdout: branchNames.map(name => `${name}\n`).join('') }
  if (argv[1] === 'ls-files') return { exitCode: 0, stdout: '' }

  return { exitCode: 1, stdout: '' }
}

type StandIn = { files: Map<string, string>; tools: ToolSpec[]; stateWrites: Map<string, unknown> }

const standInForEngine = (on: On, files: Map<string, string>, branchNames: readonly string[] = ['main']): StandIn => {
  const tools: ToolSpec[] = []
  const stateWrites = new Map<string, unknown>()
  on('state.set', (_, e, next) => {
    stateWrites.set(`${e.plugin}.${e.key}`, e.value)

    return next(e)
  })
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
  on('process.run', (_, e) => ({ value: { ...gitAnswer(e.argv, branchNames), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('tool.register', (_, e) => {
    tools.push(e)

    return { value: { tool: `mcp__sidequest__${e.name}` } }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('agent.spawn', (_, e) => ({ model: e.model ?? 'fable', agentId: 'agent-1' }))

  return { files, tools, stateWrites }
}

const startSession = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

const textOf = (answer: ToolCallResult): string => (typeof answer.result === 'string' ? answer.result : `deny: ${answer.deny}`)

const writeToBoard = async ($: Engine, operations: Record<string, unknown>[]): Promise<string> =>
  textOf(await $.tool.call({ tool: 'mcp__sidequest__ticket', operations }))

const boardView = async ($: Engine, view: string): Promise<string> => textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view }))

const spawnInput = (prompt: string, description: string): AgentSpawnInput => ({
  tool_use_id: 'toolu_1',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'opus',
  background: false,
  fork: false,
  subagentType: 'sidequest:worker',
  prompt,
  description,
})

const boardJsonOf = (files: Map<string, string>): Record<string, unknown> => JSON.parse(files.get(BOARD_JSON) ?? '{}')

test('the first ticket on a new board takes a prefix from the folder name, the board file keeps it, and the next ticket and a story carry it', async ($, on) => {
  const { files } = standInForEngine(on, new Map())
  await startSession($)

  const first = await writeToBoard($, [{ op: 'create', title: 'Retry failed uploads' }])
  const next = await writeToBoard($, [
    { op: 'create', title: 'Show the retry count', blockedBy: ['PL-1'] },
    { op: 'story', title: 'Uploads', destination: 'Uploads survive a flaky network.' },
  ])
  const patched = await writeToBoard($, [{ op: 'patch', id: 'PL-2', story: 'pl-s1' }, { op: 'patch', id: 'PL-S1', outOfScope: 'Resumable uploads.' }])

  expect(first).toBe(`created PL-1. ${prefixNote('PL')}\n${EXCLUDE_NOTICE}`)
  expect(boardJsonOf(files).prefix).toBe('PL')
  expect(next).toBe('created PL-2, created PL-S1.')
  expect(patched).toBe('patched PL-2, patched PL-S1. PL-2: story "pl-s1" was read as "PL-S1".')
  expect(files.get(`${TICKETS}/PL-2.md`)).toContain('story: PL-S1\nblockedBy: [PL-1]\n')
  expect(files.get(`${STORIES}/PL-S1.md`)).toContain('Resumable uploads.')
})

test('a prefix a tracker key in a branch name already uses is passed over, and the answer says why', async ($, on) => {
  const { files } = standInForEngine(on, new Map(), ['main', 'feature/PL-41-retry', 'origin/PL-7-spike'])
  await startSession($)

  const first = await writeToBoard($, [{ op: 'create', title: 'Retry failed uploads' }])

  expect(first).toBe(
    `created PH-1. ${prefixNote('PH', ' PL was passed over because the tracker key PL-41 uses it, so a board id never reads as a tracker issue.')}\n${EXCLUDE_NOTICE}`,
  )
  expect(boardJsonOf(files).prefix).toBe('PH')
})

test('a tracker key at the start of a title in the first write counts too, and the issue of that ticket is the key', async ($, on) => {
  const { files } = standInForEngine(on, new Map(), ['main', 'feature/PL-41-retry'])
  await startSession($)

  const first = await writeToBoard($, [{ op: 'create', title: 'PH-3 Retry failed uploads' }])

  expect(first.startsWith('created PHO-1. ')).toBe(true)
  expect(first).toContain(' PL was passed over because the tracker key PL-41 uses it, PH was passed over because the tracker key PH-3 uses it, so')
  expect(files.get(`${TICKETS}/PHO-1.md`)).toContain('\nissue: PH-3\n')
})

test('the choice skips every prefix a tracker key uses and names the first key seen for each', () => {
  const choice = choosePrefix({ folderName: 'photo-library', trackerKeys: ['PL-41', 'PL-7', 'PH-3'] })

  expect(choice.prefix).toBe('PHO')
  expect(choice.passedOver).toEqual([
    { prefix: 'PL', key: 'PL-41' },
    { prefix: 'PH', key: 'PH-3' },
  ])
})

test('the short form is the initials of a name of several words, the start of a one-word name, and letters only', () => {
  expect(prefixCandidatesFor('photo-library').slice(0, 4)).toEqual(['PL', 'PH', 'PHO', 'PHOT'])
  expect(prefixCandidatesFor('MyPaymentsService')[0]).toBe('MPS')
  expect(prefixCandidatesFor('payments')[0]).toBe('PAY')
  expect(prefixCandidatesFor('acme')[0]).toBe('ACME')
  expect(prefixCandidatesFor('web-app-v2')[0]).toBe('WAV')
  expect(prefixCandidatesFor('2024')[0]).toBe('SQ')
  expect(prefixCandidatesFor('x').every(prefix => /^[A-Z]{2,4}$/.test(prefix))).toBe(true)
})

const EARLIER_TICKET = serializeTicket({ ...newTicket('SQ-1', { title: 'Old work', status: 'done' }, '2026-11-10T09:00Z') })

test('a board with SQ tickets and no prefix keeps SQ and ST, writes no prefix and answers exactly as before', async ($, on) => {
  const earlierBoard = JSON.stringify({ version: 1, nextTicket: 2, nextStory: 1 })
  const { files, tools } = standInForEngine(on, new Map([[`${TICKETS}/SQ-1.md`, EARLIER_TICKET], [BOARD_JSON, earlierBoard]]), ['feature/SQ-9-x'])
  await startSession($)

  const created = await writeToBoard($, [{ op: 'create', title: 'Retry failed uploads' }, { op: 'story', title: 'Uploads' }])
  const started = textOf(await $.tool.call({ tool: 'mcp__sidequest__start', id: 'SQ-2' }))

  expect(created).toBe('created SQ-2, created ST-1.')
  expect(boardJsonOf(files)).toEqual({ version: 1, nextTicket: 3, nextStory: 2 })
  expect(files.has(`${STORIES}/ST-1.md`)).toBe(true)
  expect(started.startsWith('SQ-2 is now doing.')).toBe(true)
  expect(started).toContain('"name": "sq-2"')
  expect(started).toContain('"prompt": "Ticket SQ-2: Retry failed uploads')
  expect(tools).toEqual([...SIDEQUEST_TOOLS])
})

test('start, finish, the waiting view and the pane work on a board with another prefix, and its agent is logged on its ticket', async ($, on) => {
  const { files, stateWrites } = standInForEngine(on, new Map([[BOARD_JSON, JSON.stringify({ version: 1, prefix: 'TN', nextTicket: 1, nextStory: 1 })]]))
  await startSession($)
  await writeToBoard($, [
    { op: 'create', title: 'Retry failed uploads' },
    { op: 'create', title: 'Pick a backoff', status: 'needs-you', forYou: { question: 'How long between retries?', steps: 'Say a number of seconds.' } },
  ])

  const started = textOf(await $.tool.call({ tool: 'mcp__sidequest__start', id: 'TN-1' }))
  const call = JSON.parse(started.slice(started.indexOf('{'), started.lastIndexOf('}') + 1))
  await $.agent.spawn(spawnInput(call.prompt, call.description))
  await $.turn.complete({ answer: '- `result`: Uploads retry.\n- `needs`: nothing', durationMs: 60000, isAborted: false, turnId: 'agent-turn', agentId: 'agent-1', reason: 'answer' })
  const finished = textOf(await $.tool.call({ tool: 'mcp__sidequest__finish', id: 'TN-1', outcome: 'done', result: 'Uploads retry.' }))
  const waiting = await boardView($, 'waiting')
  const tickets = ['TN-1', 'TN-2'].map(id => parseTicket(files.get(`${TICKETS}/${id}.md`) ?? '', id))
  const pane = paneLinesAsText(
    boardPaneLines({
      cards: boardCards(tickets, mergeBoardConfig({ prefix: 'TN' })),
      running: [],
      sessionWork: { isWorking: false, steps: 0 },
      finishedAgents: [],
      worktreeCount: 0,
      touchedHere: new Set(['TN-1', 'TN-2']),
      showsIntro: false,
      columns: 80,
      now: NOW,
      whatYouCouldDo: [],
    }),
  )

  expect(started.startsWith('TN-1 is now doing.')).toBe(true)
  expect(call.name).toBe('tn-1')
  expect(call.prompt.startsWith('Ticket TN-1: Retry failed uploads')).toBe(true)
  expect(stateWrites.get('sidequest.runs')).toEqual({
    'agent-1': { ticket: 'TN-1', category: 'build', requestedModel: 'sonnet', model: 'sonnet', effort: 'medium', toolUseId: 'toolu_1' },
  })
  expect(files.get(`${TICKETS}/TN-1.md`)).toContain('agent agent-1 build requested sonnet/medium resolved sonnet')
  expect(files.get(`${TICKETS}/TN-1.md`)).toContain('returned build run after 1m, agent agent-1\n- 2026-11-16T10:02Z result Uploads retry.')
  expect(finished.startsWith('TN-1 moved to review')).toBe(true)
  expect(waiting).toContain('How long between retries?')
  expect(waiting).toContain('Ticket TN-2.')
  expect(pane).toContain('Waits on you\n  TN-2 How long between retries?')
  expect(pane).toContain('Being checked\n  TN-1 Retry failed uploads')
})

test('the tool descriptions show the board own prefix, and a new board shows the one its first ticket would take', async ($, on) => {
  const { tools } = standInForEngine(on, new Map())
  await startSession($)
  const ticketTool = JSON.stringify(tools.find(tool => tool.name === 'ticket'))
  const startTool = JSON.stringify(tools.find(tool => tool.name === 'start'))

  expect(ticketTool).toContain('tickets like PL-12, stories like PL-S3')
  expect(ticketTool).toContain('like PL-12 then PL-13, and PL-S3 then PL-S4')
  expect(startTool).toContain('The ticket to start, like PL-12.')
  expect(`${ticketTool}${startTool}`).not.toMatch(/\b(?:SQ|ST)-\d/)
})

test('a transcript row reads the ticket ref in the board own prefix, and the write row whatever the prefix', () => {
  const tn = boardIdsOf('TN')
  const spawned = { tool: 'Agent', input: { prompt: 'Ticket TN-4: Retry', description: 'TN-4 retry', subagent_type: 'sidequest:worker' }, isErrored: false }
  const written = { tool: 'mcp__sidequest__ticket', input: { operations: [] }, output: 'created TN-4, created TN-S2.', isErrored: false }

  expect(boardToolRow(spawned, undefined, tn)).toBe('TN-4 retry: worker')
  expect(boardToolRow(spawned, undefined, EARLIER_BOARD_IDS)).toBe(undefined)
  expect(boardToolRow({ ...spawned, input: { ...spawned.input, prompt: 'PAY-41 retry' } }, undefined, tn)).toBe(undefined)
  expect(boardToolRow(written, undefined, tn)).toBe('TN-4 created, story TN-S2 created')
})

test('a key shaped like this board ids is never the tracker issue, and on another board it is', () => {
  const isOnTn = (id: string) => isTicketIdOn(boardIdsOf('TN'), id)
  const isOnEarlierBoard = (id: string) => isTicketIdOn(EARLIER_BOARD_IDS, id)

  expect(trackerKeyFor('TN-3 Retry failed uploads', 'fix/PAY-41-retry', isOnTn)).toBe('PAY-41')
  expect(trackerKeyFor('TN-3 Retry failed uploads', 'main', isOnEarlierBoard)).toBe('TN-3')
  expect(trackerKeyFor('SQ-3 Retry failed uploads', 'main', isOnTn)).toBe('SQ-3')
})

test('a prefix written by hand in small letters is read in capitals, and one that is not letters is named and ignored', () => {
  expect(mergeBoardConfig({ prefix: ' tn ' }).prefix).toBe('TN')
  expect(mergeBoardConfig({ prefix: 'T-N' }).prefix).toBe(undefined)
  expect(boardConfigProblems(JSON.stringify({ prefix: 'T-N' }))).toEqual(['"prefix" must be one to ten letters, like TN, so it is ignored.'])
  expect(boardConfigProblems(JSON.stringify({ prefix: 'TN' }))).toEqual([])
  expect(DEFAULT_BOARD_CONFIG.prefix).toBe(undefined)
})
