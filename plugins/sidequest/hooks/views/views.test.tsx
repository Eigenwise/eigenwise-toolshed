import { expect, test } from 'claude-code/testing'
import type { Engine, FoundElement } from 'claude-code/testing'
import type { AgentSpawnInput, On, RenderSurface } from 'claude-code'

import type { BoardCard, FinishedAgent } from '../../types'
import { DEFAULT_BOARD_CONFIG, mergeBoardConfig } from '../board-config'
import { newStory, newTicket } from '../tickets'
import { whatThePersonCouldDo } from '../what-can-move'
import { approvedByHuman } from '../human-answers'
import { heldThingsFor, waitsForWords } from '../shared-things'
import { bandCounts, bandLine, boardCards, ticketDetail } from './board-view'
import { clockTime } from '../session-activity'
import { NOTHING_IS_RUNNING, YES_ON_THE_PLAN, boardPaneLines, fittedRow, moreFinishedLines, paneLinesAsText, withScrollCue } from './pane-sections'
import type { PaneContent, PaneLine } from './pane-sections'

const ROOT = '/repo'
const TICKETS = `${ROOT}/.sidequest/tickets`
const NOW = Date.parse('2026-11-16T10:02:00Z')
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
// Four mounts in one test ran past the 5 s default on a slow Windows runner (CI run 44288588237).
const EVERY_SURFACE = { timeoutMs: 20_000 }

const PANE = {
  plugin: 'sidequest',
  component: 'Pane',
  requestId: 'board',
  props: {
    title: 'Board',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

// An inline pane at 80 terminal columns, inside its frame.
const PANE_AT_80 = { ...PANE, props: { ...PANE.props, placement: 'inline', bodyColumns: 78 } } as const

const BAND = {
  plugin: 'sidequest',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const portablePath = (path: string): string => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

const ticketFile = (id: string, title: string, status: string, log: string[] = []): string =>
  [
    '---',
    `id: ${id}`,
    `title: ${title}`,
    `status: ${status}`,
    'kind: build',
    'mode: afk',
    'category: build',
    'created: 2026-11-15',
    'updated: 2026-11-15',
    '---',
    '',
    '## What',
    `${title} works.`,
    '',
    '## Log',
    ...log.map(line => `- ${line}`),
    '',
  ].join('\n')

const seededBoard = (): Map<string, string> =>
  new Map([
    [`${TICKETS}/SQ-1.md`, ticketFile('SQ-1', 'Retry failed uploads', 'ready')],
    [`${TICKETS}/SQ-2.md`, ticketFile('SQ-2', 'Trace upload flow', 'doing', ['2026-11-16T09:00Z started worker sonnet/medium'])],
    [`${TICKETS}/SQ-3.md`, ticketFile('SQ-3', 'Pick a backoff', 'needs-you', ['2026-11-16T09:30Z asked the person'])],
  ])

// A key ending in a slash stands for a folder.
const entryOf = (name: string) =>
  name.endsWith('/')
    ? { name: name.slice(0, -1), kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }
    : { name, kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false }

const entriesUnder = (files: Map<string, string>, folder: string) => {
  const prefix = `${folder}/`

  return [...files.keys()]
    .filter(path => path.startsWith(prefix) && !path.slice(prefix.length).replace(/\/$/, '').includes('/'))
    .map(path => entryOf(path.slice(prefix.length)))
}

type EngineStandIn = {
  store: Map<string, unknown>
  toasts: string[]
  openedPanes: string[]
  rowsAskedFor: (number | undefined)[]
  focusAskedFor: (true | undefined)[]
  clockReads: number
  notifications: { text: string; key?: string }[]
  submitted: string[]
  viewedAgents: (string | undefined)[]
  placedRows: string[]
  commandsAnotherPluginHolds: string[]
}

const standInForEngine = (on: On, files: Map<string, string>, isPlaced = true): EngineStandIn => {
  const standIn: EngineStandIn = { store: new Map(), toasts: [], openedPanes: [], rowsAskedFor: [], focusAskedFor: [], clockReads: 0, notifications: [], submitted: [], viewedAgents: [], placedRows: [], commandsAnotherPluginHolds: [] }
  on('store.get', (_, e) => ({ value: standIn.store.get(e.key) }))
  on('store.set', (_, e) => {
    standIn.store.set(e.key, e.value)

    return { value: undefined }
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
  on('process.run', () => ({
    value: { exitCode: 0, stdout: `${ROOT}/.git\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('env.get', () => ({ value: undefined }))
  on('clock.now', () => {
    standIn.clockReads += 1

    return { value: NOW }
  })
  on('tool.register', (_, e) => ({ value: { tool: `mcp__sidequest__${e.name}` } }))
  on('command.register', (_, e) => {
    if (standIn.commandsAnotherPluginHolds.includes(e.name)) throw new Error(`"/${e.name}" refused: another plugin registered it already`)

    return { value: { command: e.name } }
  })
  on('ui.open', (_, e) => {
    standIn.openedPanes.push(e.id)
    standIn.rowsAskedFor.push(e.rows)
    standIn.focusAskedFor.push(e.focus)

    return { value: isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'no-surface' } }
  })
  on('ui.place', (_, e) => {
    standIn.placedRows.push(e.id)

    return { value: { isPlaced: true, requestId: `placed-${e.id}` } }
  })
  on('ui.toast', (_, e) => {
    standIn.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.notify', (_, e) => {
    standIn.notifications.push({ text: e.text, ...(e.key === undefined ? {} : { key: e.key }) })

    return { value: { isSent: true, channel: 'terminal_bell' } }
  })
  on('prompt.submit', (_, e) => {
    standIn.submitted.push(e.text)

    return { text: e.text }
  })
  on('ui.view', (_, e) => {
    standIn.viewedAgents.push(e.agentId)

    return { value: {} }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  return standIn
}

// The session asks the person again: the ticket waits on them anew after what they sent from the board.
const askAgain = ($: Engine, id: string) => $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'patch', id, status: 'needs-you' }] })

const startSession = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

const runBoardCommand = ($: Engine) =>
  $.command.run({ command: 'board', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

test('a ticket opens from the pane with set aside, drop and back, and no status to pick', EVERY_SURFACE, async ($, on) => {
  const files = seededBoard()
  const standIn = standInForEngine(on, files)
  await startSession($)
  await runBoardCommand($)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Button', key: 'SQ-2' }))?.text).toContain('stopped, nothing runs it')

    await ui.press({ key: 'SQ-1' })
    expect((await ui.find({ type: 'Text', text: /^Retry failed uploads$/ }))?.text).toBe('Retry failed uploads')
    expect(await ui.find({ type: 'Button', key: 'set-aside' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'drop' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'back' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^Set aside: / }))?.text).toBe(
      'Set aside: stays on the board and nothing starts it until you say so. Its files, branch and worktree stay as they are. Drop: off the board, never offered again. It has no worktree or branch of its own, so nothing on disk changes.',
    )
    for (const status of ['inbox', 'ready', 'doing', 'review', 'needs-you', 'done', 'parked']) {
      expect(await ui.find({ type: 'Button', key: `move-${status}` })).toBeUndefined()
    }
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
  expect(standIn.toasts).toEqual([])
})

const checkpointFile = (id: string, title: string): string =>
  ticketFile(id, title, 'ready').replace('kind: build', 'kind: review').replace('mode: afk', 'mode: hitl')

test('approve pressed on a checkpoint tells the session once, and a ticket that is no checkpoint has no approve', async ($, on) => {
  const files = seededBoard()
  files.set(`${TICKETS}/SQ-4.md`, checkpointFile('SQ-4', 'Look at the upload flow'))
  const standIn = standInForEngine(on, files)
  await startSession($)
  await runBoardCommand($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'SQ-1' })
  expect(await ui.find({ type: 'Button', key: 'approve' })).toBeUndefined()
  await ui.press({ key: 'back' })
  await ui.press({ key: 'SQ-4' })
  expect((await ui.find({ type: 'Text', text: /^Approve: / }))?.text).toContain('Approve: you looked and it is right, so what it blocks carries on.')
  await ui.press({ key: 'approve' })

  expect(standIn.submitted).toEqual([
    'I approved SQ-4 (Look at the upload flow) on the board. Carry on with what it was holding up.',
  ])
  expect(files.get(`${TICKETS}/SQ-4.md`)).toContain('status: done')
  expect(files.get(`${TICKETS}/SQ-4.md`)).toContain('approved by human in the board')
  expect(await ui.find({ type: 'Button', key: 'approve' })).toBeUndefined()
  await ui.unmount()
})

test('set aside and drop pressed in a ticket view write the file as the person, and the view then offers what is left', async ($, on) => {
  const files = seededBoard()
  standInForEngine(on, files)
  await startSession($)
  await runBoardCommand($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'SQ-1' })
  await ui.press({ key: 'set-aside' })
  expect(files.get(`${TICKETS}/SQ-1.md`)).toContain('status: parked')
  expect(files.get(`${TICKETS}/SQ-1.md`)).toContain('moved ready to parked, pressed on the board by the person')
  expect(await ui.find({ type: 'Button', key: 'set-aside' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'drop' })).toBeDefined()

  await ui.press({ key: 'drop' })
  expect(files.get(`${TICKETS}/SQ-1.md`)).toContain('status: dropped')
  expect(await ui.find({ type: 'Button', key: 'drop' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeDefined()
  await ui.unmount()
})

test('a ticket that waits on the person with no question says so above the answer field', async ($, on) => {
  standInForEngine(on, seededBoard())
  await startSession($)
  await runBoardCommand($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'SQ-3' })

  expect((await ui.find({ type: 'Text', text: /no question was written/ }))?.text).toBe(
    'This ticket waits on you, but no question was written for it. Ask the session what it needs, or type what you decide.',
  )
  expect(await ui.find({ type: 'Input', key: 'answer' })).toBeDefined()
  await ui.press({ key: 'back' })
  await ui.press({ key: 'SQ-1' })
  expect(await ui.find({ type: 'Text', text: /no question was written/ })).toBeUndefined()
  await ui.unmount()
})

test('as a widget the pane draws only the counts', async ($, on) => {
  standInForEngine(on, seededBoard())
  await startSession($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, placement: 'widget' } })

  expect((await ui.find({ type: 'Text' }))?.text).toBe('1 need you, 1 ready to start, 1 in progress, 0 being checked')
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
})

const standInForEngineDrawing = (on: On): void => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
}

test('the band stays away from an empty board', EVERY_SURFACE, async ($, on) => {
  standInForEngine(on, new Map())
  standInForEngineDrawing(on)
  await startSession($)

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ type: 'Button', key: 'open' })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: 'engine' })).toBeDefined()
    await band.unmount()
  }
})

test('with the board command held by another plugin the band offers the board on an empty board too', EVERY_SURFACE, async ($, on) => {
  const standIn = standInForEngine(on, new Map())
  standIn.commandsAnotherPluginHolds.push('board')
  standInForEngineDrawing(on)
  await startSession($)

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect((await band.find({ type: 'Button', key: 'open' }))?.props.label).toBe('open board')
    await band.press({ key: 'open' })
    await band.unmount()
  }
  expect(standIn.openedPanes).toEqual(['board', 'board', 'board', 'board'])
})

test('the band shows the live counts and opens the board', EVERY_SURFACE, async ($, on) => {
  const standIn = standInForEngine(on, seededBoard())
  standInForEngineDrawing(on)
  await startSession($)

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect((await band.find({ type: 'Text', text: /needs you/ }))?.text).toBe('1 ticket needs you')
    expect((await band.find({ type: 'Text', text: /ready/ }))?.text).toBe('1 ticket ready to start, 1 stopped')
    expect((await band.find({ type: 'Button', key: 'open' }))?.props.label).toBe('open board')
    await band.press({ key: 'open' })
    await band.unmount()
  }
  expect(standIn.openedPanes).toEqual(['board', 'board', 'board', 'board'])
})

test('the band only calls a doing ticket running while an agent is alive', async () => {
  const oneDoing = { needsYou: 0, ready: 0, doing: 1, review: 0 }

  const opusAgent = { model: 'claude-opus-5-5', description: 'look' }
  const run = { category: 'build', model: 'claude-opus-5-5', effort: 'high', requestedModel: 'opus' }
  const activity = { agents: {}, runs: {}, doingTickets: ['SQ-2'], returnedTickets: [], waits: {} }
  const unrelatedAgentAlive = { ...activity, agents: { 'agent-1': opusAgent }, runs: { 'agent-1': run } }
  const ownAgentAlive = { ...unrelatedAgentAlive, runs: { 'agent-1': { ...run, ticket: 'SQ-2' } } }
  const ownAgentReturned = { ...activity, returnedTickets: ['SQ-2'] }

  expect(bandCounts(oneDoing, activity)).toBe('1 ticket stopped')
  expect(bandCounts(oneDoing, ownAgentReturned)).toBe('1 ticket back, result not written up yet')
  expect(bandCounts(oneDoing, unrelatedAgentAlive)).toBe('1 ticket stopped  1 agent running on opus')
  expect(bandCounts(oneDoing, ownAgentAlive)).toBe('1 ticket running  1 agent running on opus')
  expect(bandCounts({ ...oneDoing, doing: 0 }, { ...unrelatedAgentAlive, doingTickets: [] })).toBe('1 agent running on opus')
})

test('every part of the band says what it counts', async () => {
  const nothingOnTheBoard = { needsYou: 0, ready: 0, doing: 0, review: 0 }
  const agentsOn = (models: readonly string[]) => Object.fromEntries(models.map((model, index) => [`agent-${index}`, { model, description: 'look' }]))
  const withAgents = (models: readonly string[]) => ({ agents: agentsOn(models), runs: {}, doingTickets: [], returnedTickets: [], waits: {} })
  const sevenOnOneModel = withAgents(Array.from({ length: 7 }, () => 'claude-opus-5-5'))
  const sevenOnTwoModels = withAgents([...Array.from({ length: 5 }, () => 'claude-opus-5-5'), 'claude-sonnet-5-5', 'claude-sonnet-5-5'])

  expect(bandCounts(nothingOnTheBoard, sevenOnOneModel)).toBe('7 agents running on opus')
  expect(bandCounts(nothingOnTheBoard, sevenOnTwoModels)).toBe('7 agents running: 5 opus, 2 sonnet')
  expect(bandCounts({ needsYou: 0, ready: 3, doing: 0, review: 2 }, withAgents([]))).toBe('3 tickets ready to start, 2 being checked')
  expect(bandCounts({ needsYou: 0, ready: 0, doing: 0, review: 1 }, withAgents([]))).toBe('1 ticket being checked')

  const longWaiting = { ...withAgents([]), oldestWaitingMs: 30 * 24 * 60 * 60 * 1000 }
  expect(bandLine({ ...nothingOnTheBoard, needsYou: 3 }, withAgents([]), 120).warnings).toBe('3 tickets need you')
  expect(bandLine({ ...nothingOnTheBoard, needsYou: 3 }, longWaiting, 120).warnings).toBe('3 tickets need you, the oldest waiting 30 days')
  expect(bandLine({ ...nothingOnTheBoard, needsYou: 3 }, sevenOnTwoModels, 30)).toEqual({ warnings: '3 need you', counts: '7 agents running' })
})

test('the band counts running agents by model, routed or not', async ($, on) => {
  standInForEngine(on, new Map())
  standInForEngineDrawing(on)
  const models = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5']
  on('agent.spawn', (_, e) => ({ model: models[e.workflow?.agentIndex ?? 0] ?? 'haiku', agentId: `agent-${e.workflow?.agentIndex}` }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await startSession($)
  const spawn = (agentIndex: number) =>
    $.agent.spawn({
      tool_use_id: 'toolu_1',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'opus',
      background: true,
      fork: false,
      subagentType: 'Explore',
      prompt: 'look',
      description: 'look',
      model: 'opus',
      workflow: { runId: 'wf_1', agentIndex },
    })

  await Promise.all([spawn(0), spawn(1), spawn(2)])
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /agents/ }))?.text).toBe('3 agents running: 2 sonnet, 1 opus')
  await band.unmount()

  for (const agentIndex of [0, 1, 2]) {
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', agentId: `agent-${agentIndex}`, reason: 'answer' })
  }
  const quiet = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await quiet.find({ type: 'Button', key: 'open' })).toBeUndefined()
  await quiet.unmount()
})

const ownerBoard = (): Map<string, string> => {
  const files = new Map([[`${TICKETS}/SQ-1.md`, ticketFile('SQ-1', 'Decide how much the helper may do alone', 'parked')]])
  for (const number of [1, 2, 3, 4, 5, 6]) files.set(`${ROOT}/.git/worktrees/wt-${number}/`, '')

  return files
}

test('a board with one parked ticket and six worktrees says nothing runs, what shows up here, the count, then housekeeping', async ($, on) => {
  const standIn = standInForEngine(on, ownerBoard())
  standIn.store.set('boardIntroSeen', true)
  await startSession($)

  const ui = await $.ui.mount({ ...PANE_AT_80, surface: 'terminal' })

  expect((await ui.find({ type: 'Text' }))?.text).toBe(NOTHING_IS_RUNNING)
  const texts = (await ui.findAll({ type: 'Text' })).map(element => element.text)
  expect(texts.slice(0, 4)).toEqual([
    NOTHING_IS_RUNNING,
    ' ',
    'Work bigger than a quick fix gets a ticket. This pane then shows who is on',
    'what, what waits on you, what is next and what got done.',
  ])
  expect(texts).toContain('Also on the board: 1 set aside')
  expect(texts.filter(text => /^(NOW|WAITS ON YOU|NEXT|DONE)$/.test(text))).toEqual([])
  expect((await ui.findAll({})).at(-1)?.key).toBe('tidy-worktrees')
  expect(texts.at(-1)).toBe('6 leftover git worktrees from finished work')
  await ui.unmount()
})

test('the parked count opens a plain list of what is set aside, and Back returns', async ($, on) => {
  standInForEngine(on, ownerBoard())
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'set-aside' })
  expect((await ui.find({ type: 'Text', text: 'SET ASIDE' }))?.text).toBe('SET ASIDE')
  expect((await ui.find({ type: 'Button', key: 'SQ-1' }))?.text).toContain('SQ-1 Decide how much the helper may do alone')
  await ui.press({ key: 'back-from-set-aside' })
  expect(await ui.find({ type: 'Text', text: 'SET ASIDE' })).toBeUndefined()
  await ui.unmount()
})

const STORIES = `${ROOT}/.sidequest/stories`

const storyFile = (id: string, title: string, analysis: string): string =>
  [
    '---',
    `id: ${id}`,
    `title: ${title}`,
    'created: 2026-11-16',
    'updated: 2026-11-16',
    '---',
    '',
    '## Destination',
    `${title} for everyone.`,
    '',
    ...(analysis === '' ? [] : ['## Analysis', analysis, '']),
    '## Decisions',
    '',
  ].join('\n')

const ticketOfStory = (id: string, title: string, storyId: string): string =>
  ticketFile(id, title, 'ready').replace('category: build', `category: build\nstory: ${storyId}`)

test('a story with an analysis and no ticket heads the pane, opens on its destination and analysis, and Back returns', async ($, on) => {
  const files = seededBoard()
  files.set(`${STORIES}/ST-1.md`, storyFile('ST-1', 'Tags on items', 'Asked: tags.\n\n### Today\nNo tags yet.'))
  standInForEngine(on, files)
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: 'THE PLAN' }))?.text).toBe('THE PLAN')
  expect((await ui.find({ type: 'Button', key: 'story-ST-1' }))?.text).toBe('Tags on items  analysis and decisions')
  expect(await ui.find({ type: 'Text', text: /ST-1/ })).toBeUndefined()
  await ui.press({ key: 'story-ST-1' })
  expect((await ui.find({ type: 'Text', text: /^Tags on items$/ }))?.text).toBe('Tags on items')
  expect((await ui.find({ type: 'Text', text: 'Tags on items for everyone.' }))?.text).toBe('Tags on items for everyone.')
  expect((await ui.find({ type: 'Markdown' }))?.text).toBe('Asked: tags.\n\n### Today\nNo tags yet.')
  expect((await ui.findAll({})).at(-1)?.key).toBe('back-from-story')

  await ui.press({ key: 'back-from-story' })
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'SQ-1' })).toBeDefined()
  await ui.unmount()
})

test('a story heading over its tickets opens the story, and one with no analysis says so in one line', async ($, on) => {
  const files = new Map([
    [`${TICKETS}/SQ-1.md`, ticketOfStory('SQ-1', 'Add tag field', 'ST-1')],
    [`${TICKETS}/SQ-2.md`, ticketOfStory('SQ-2', 'Add due date', 'ST-2')],
    [`${STORIES}/ST-1.md`, storyFile('ST-1', 'Tags on items', 'Asked: tags.')],
    [`${STORIES}/ST-2.md`, storyFile('ST-2', 'Due dates', '')],
  ])
  standInForEngine(on, files)
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Button', key: 'story-ST-1' }))?.text).toBe('Tags on items')
  await ui.press({ key: 'story-ST-2' })
  expect((await ui.find({ type: 'Text', text: 'Due dates for everyone.' }))?.text).toBe('Due dates for everyone.')
  expect((await ui.find({ type: 'Text', text: 'Nothing was written up for this plan yet.' }))?.text).toBe('Nothing was written up for this plan yet.')
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  await ui.unmount()
})

test('a story analysis taller than the pane says the arrow keys scroll', async ($, on) => {
  const files = seededBoard()
  files.set(`${STORIES}/ST-1.md`, storyFile('ST-1', 'Tags on items', Array.from({ length: 40 }, (_, index) => `Line ${index}`).join('\n')))
  standInForEngine(on, files)
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, isFocused: true }, surface: 'terminal' })

  await ui.press({ key: 'story-ST-1' })
  expect((await ui.find({ type: 'Text', text: /^More below/ }))?.text).toBe('More below: the arrow keys scroll')
  await ui.unmount()
})

test('the board is drawn although another plugin holds the board command, and the person is told once', async ($, on) => {
  const standIn = standInForEngine(on, seededBoard())
  standIn.commandsAnotherPluginHolds.push('board')

  await startSession($)

  expect(standIn.toasts).toEqual(['Sidequest: /board already belongs to another plugin in this session. The board still opens with "open board" above the message box.'])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Retry failed uploads/ }))?.text).toContain('Retry failed uploads')
  await ui.unmount()
})

test('writing an analysis opens the pane on that story', async ($, on) => {
  const standIn = standInForEngine(on, seededBoard())
  await startSession($)

  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'story', title: 'Tags on items', destination: 'Items carry tags.', analysis: 'Asked: tags.' }] })

  expect(standIn.openedPanes).toEqual(['board'])
  expect(standIn.rowsAskedFor).toEqual([20])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Markdown' }))?.text).toBe('Asked: tags.')
  expect((await ui.find({ type: 'Text', text: 'Items carry tags.' }))?.text).toBe('Items carry tags.')

  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'patch', id: 'ST-1', destination: 'Items carry two tags.' }] })
  expect((await ui.find({ type: 'Text', text: 'Items carry two tags.' }))?.text).toBe('Items carry two tags.')
  await ui.unmount()
})

const PLAN_SEND_WORDS = 'Send puts your picks and your words in the chat as your one message, and on the plan. Or answer in the chat by number.'

const UPLOAD_QUESTIONS = [
  { question: 'How many retries?', recommended: 'retries: 2', otherCosts: 'Three makes a failure show a minute later.' },
  { question: 'Where does it live?', recommended: ['`uploadWithRetry(file)`', 'a policy object beside the upload'] },
]
const IN_SHORT = 'Asked: failed uploads retry.\n\nToday a failure is reported at once.\n\nA. retry in the upload (recommended)\nB. retry at every call site'
const POINTER_LINE = 'The analysis and 2 decisions are on the board (/board opens it). Pick there and Send, or type yes to take the recommended answers.'

const writeUploadsPlan = async ($: Engine): Promise<string> => {
  const written = await $.tool.call({
    tool: 'mcp__sidequest__ticket',
    operations: [{ op: 'story', title: 'Uploads', inShort: IN_SHORT, destination: 'Uploads retry.', analysis: 'Asked: retry.', questions: UPLOAD_QUESTIONS }],
  })

  return typeof written.result === 'string' ? written.result : ''
}

test('with the board placed, a story written with questions ends the reply with the three-line instruction and the pointer line, and no decisions block, and the plan opens without the keyboard', async ($, on) => {
  const standIn = standInForEngine(on, seededBoard())
  await startSession($)

  const reply = await writeUploadsPlan($)

  expect(reply.endsWith(`Say only this in the chat, three lines at most:\n\n${POINTER_LINE}`)).toBe(true)
  expect(reply).not.toContain('Two decisions for you')
  expect(reply).not.toContain('How many retries?')
  expect(reply).not.toContain('Today a failure is reported at once.')
  expect(reply).toContain('Question 2 has no otherCosts (written anyway)')
  expect(standIn.openedPanes).toEqual(['board'])
  expect(standIn.focusAskedFor).toEqual([undefined])
})

test('a write that opens no plan never asks for the keyboard either', async ($, on) => {
  const standIn = standInForEngine(on, seededBoard())
  await startSession($)

  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'create', title: 'Tidy the upload helper' }] })

  expect(standIn.openedPanes).toEqual(['board'])
  expect(standIn.focusAskedFor).toEqual([undefined])
})

const noBoardEnding = (reply: string): string => reply.slice(reply.indexOf('No board pane is placed'))

test('with no pane, a story written with questions ends the reply with the short version and then the decisions block', async ($, on) => {
  standInForEngine(on, seededBoard(), false)
  await startSession($)

  const reply = await writeUploadsPlan($)
  const ending = noBoardEnding(reply)

  expect(ending.startsWith(`No board pane is placed, so show the person this text in the chat as it is:\n\n${IN_SHORT}\n\nTwo decisions for you\n\n1. How many retries?`)).toBe(true)
  expect(ending.split('\n').at(-1)).toBe('Answer by number, or yes takes both recommended answers. The reasoning for each is in the plan on the board (/board opens it).')
  expect(reply).not.toContain(POINTER_LINE)
  expect(reply.indexOf('Question 2 has no otherCosts')).toBeLessThan(reply.indexOf('No board pane is placed'))
})

test('a follow-up group of decisions with no analysis opens the plan and points the chat at the board', async ($, on) => {
  const standIn = standInForEngine(on, seededBoard())
  await startSession($)
  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'story', title: 'Uploads', inShort: IN_SHORT }] })

  const written = await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'patch', id: 'ST-1', questions: UPLOAD_QUESTIONS.slice(0, 1) }] })
  const reply = typeof written.result === 'string' ? written.result : ''

  expect(reply.endsWith('The analysis and 1 decision are on the board (/board opens it). Pick there and Send, or type yes to take the recommended answer.')).toBe(true)
  expect(standIn.focusAskedFor).toEqual([undefined, undefined])
})

test('the plan view draws each decision as markdown, so a part in backticks is code, then one words field and Send', async ($, on) => {
  const files = seededBoard()
  standInForEngine(on, files)
  await startSession($)
  await writeUploadsPlan($)
  expect(files.get(`${STORIES}/ST-1.md`)).toContain('## Decisions for you\n1. How many retries?')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const decisionLines = (await ui.findAll({ type: 'Markdown' })).filter(element => /^decision-/.test(element.key ?? '')).map(element => element.text)
  expect(decisionLines).toEqual([
    '1. How many retries?',
    'Recommended: retries: 2',
    'Otherwise: Three makes a failure show a minute later.',
    '2. Where does it live?',
    'Recommended:',
    '- `uploadWithRetry(file)`',
    '- a policy object beside the upload',
  ])
  expect(await ui.find({ type: 'Text', text: /`/ })).toBeUndefined()
  const texts = (await ui.findAll({ type: 'Text' })).map(element => element.text)
  expect(texts.slice(texts.indexOf('Decisions for you') + 1)).toEqual([PLAN_SEND_WORDS, 'Uploads retry.'])
  expect((await ui.findAll({ type: 'Input' })).map(input => input.key)).toEqual(['decisions-words'])
  const keysInOrder = (await ui.findAll({})).map(element => element.key)
  expect(keysInOrder.indexOf('decision-1-answer')).toBeLessThan(keysInOrder.indexOf('decisions-words'))
  expect(keysInOrder.indexOf('decisions-words')).toBeLessThan(keysInOrder.indexOf('send-decisions'))

  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'patch', id: 'ST-1', questions: [] }] })
  expect(files.get(`${STORIES}/ST-1.md`)).not.toContain('Decisions for you')
  expect(await ui.find({ type: 'Text', text: PLAN_SEND_WORDS })).toBeUndefined()
  expect((await ui.findAll({ type: 'Input' })).map(input => input.key)).toEqual(['say-about-story'])
  const keysWithNoDecisions = (await ui.findAll({})).map(element => element.key)
  expect(keysWithNoDecisions.indexOf('analysis')).toBeLessThan(keysWithNoDecisions.indexOf('say-about-story'))
  await ui.unmount()
})

test('the row that says how many decisions wait on the plan opens the plan view at its decisions, and goes once they are answered', async ($, on) => {
  const files = seededBoard()
  standInForEngine(on, files)
  await startSession($)
  const questions = [
    { question: 'How many retries?', recommended: 'retries: 2', otherCosts: 'Three is slower.' },
    { question: 'Where does it live?', recommended: 'uploadWithRetry(file)', otherCosts: 'A wrapper at every call site.' },
  ]
  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'story', title: 'Uploads', destination: 'Uploads retry.', analysis: 'Asked: retry.', questions }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'back-from-story' })

  expect((await ui.find({ type: 'Button', key: 'decisions-ST-1' }))?.text).toBe('2 decisions on the plan')
  await ui.press({ key: 'decisions-ST-1' })
  expect(await ui.find({ key: 'decisions-for-you' })).toBeDefined()
  expect((await ui.find({ type: 'Markdown', text: '1. How many retries?' }))?.text).toBe('1. How many retries?')

  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'patch', id: 'ST-1', questions: [] }] })
  await ui.press({ key: 'back-from-story' })
  expect(await ui.find({ type: 'Button', key: 'decisions-ST-1' })).toBeUndefined()
  await ui.unmount()
})

test('the plan view answers its decisions with the recommended answers picked and one send', async ($, on) => {
  const files = seededBoard()
  const standIn = standInForEngine(on, files)
  await startSession($)
  const questions = [
    { question: 'How many retries?', recommended: 'retries: 2', otherCosts: 'Three is slower.' },
    { question: 'Where does it live?', recommended: 'uploadWithRetry(file)' },
  ]
  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'story', title: 'Uploads', destination: 'Uploads retry.', analysis: 'Asked: retry.', questions }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Button', key: 'decision-0-answer' }))?.text).toBe('● recommended  ○ the other answer')
  await ui.press({ key: 'decision-1-answer' })
  expect((await ui.find({ type: 'Button', key: 'decision-1-answer' }))?.text).toBe('○ recommended  ● the other answer')
  await ui.press({ key: 'send-decisions' })
  await ui.unmount()

  expect(standIn.submitted).toEqual(['My answers on ST-1 (Uploads), from the board: 2: the other answer; 1: the recommended answer.'])
  expect(files.get(`${STORIES}/ST-1.md`)).toContain('answered by human in the board: 2: the other answer; 1: the recommended answer.')
})

test('Enter in the words under the decisions sends nothing and keeps the words, and Send then sends them with the picks', async ($, on) => {
  const files = seededBoard()
  const standIn = standInForEngine(on, files)
  await startSession($)
  const questions = [{ question: 'How many retries?', recommended: 'retries: 2', otherCosts: 'Three is slower.' }]
  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'story', title: 'Uploads', destination: 'Uploads retry.', analysis: 'Asked: retry.', questions }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.input({ key: 'decisions-words', text: 'but the store stays' })
  expect(standIn.submitted).toEqual([])
  expect((await ui.find({ type: 'Input', key: 'decisions-words' }))?.props.value).toBe('but the store stays')
  expect((await ui.find({ type: 'Input', key: 'decisions-words' }))?.props.submitLabel).toBe('keep')

  await ui.input({ key: 'decisions-words', text: 'but the store stays dumb', kind: 'change' })
  await ui.press({ key: 'send-decisions' })
  await ui.unmount()

  expect(standIn.submitted).toEqual(['My answers on ST-1 (Uploads), from the board: 1: the recommended answer.\nIn my words: but the store stays dumb'])
})

test('words typed under the decisions and never entered go out with the picks when Send is pressed, once', async ($, on) => {
  const files = seededBoard()
  const standIn = standInForEngine(on, files)
  await startSession($)
  const questions = [{ question: 'How many retries?', recommended: 'retries: 2', otherCosts: 'Three is slower.' }]
  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'story', title: 'Uploads', destination: 'Uploads retry.', analysis: 'Asked: retry.', questions }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.input({ key: 'decisions-words', text: 'but the store stays dumb', kind: 'change' })
  await ui.press({ key: 'send-decisions' })
  await ui.unmount()

  expect(standIn.submitted).toHaveLength(1)
  expect(standIn.submitted[0]).toContain('1: the recommended answer')
  expect(standIn.submitted[0]).toContain('but the store stays dumb')
})

test('the message of a send names a switched decision by its other answer, the rest by number, and the words last on their own line', async ($, on) => {
  const files = seededBoard()
  const standIn = standInForEngine(on, files)
  await startSession($)
  const questions = [
    { question: 'How many retries?', recommended: 'retries: 2', otherCosts: 'Three tries make a failed upload show a minute later. It also doubles the load on a server that is already struggling.' },
    { question: 'Where does it live?', recommended: 'uploadWithRetry(file)', otherCosts: 'A wrapper at every call site.' },
    { question: 'Log each retry?', recommended: 'Yes', otherCosts: 'Nobody sees a retry happen.' },
    { question: 'Tell the person?', recommended: 'Only after the last try', otherCosts: 'A toast for every try.' },
  ]
  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'story', title: 'Uploads', destination: 'Uploads retry.', analysis: 'Asked: retry.', questions }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'decision-0-answer' })
  await ui.input({ key: 'decisions-words', text: 'keep the store dumb', kind: 'change' })
  await ui.press({ key: 'send-decisions' })
  await ui.unmount()

  expect(standIn.submitted).toEqual([
    'My answers on ST-1 (Uploads), from the board: 1: Three tries make a failed upload show a minute later; 2, 3 and 4: the recommended answers.\nIn my words: keep the store dumb',
  ])
  expect(files.get(`${STORIES}/ST-1.md`)).toContain(
    'answered by human in the board: 1: Three tries make a failed upload show a minute later; 2, 3 and 4: the recommended answers. In my words: keep the store dumb',
  )
})

test('with every decision left on its recommended answer the message says so in one clause', async ($, on) => {
  const standIn = standInForEngine(on, seededBoard())
  await startSession($)
  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'story', title: 'Uploads', destination: 'Uploads retry.', analysis: 'Asked: retry.', questions: RETRY_QUESTIONS }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'send-decisions' })
  await ui.unmount()

  expect(standIn.submitted).toEqual(['My answers on ST-1 (Uploads), from the board: Both: the recommended answers.'])
})

const storyButtonKeys = async (ui: { findAll: (query: { type: string }) => Promise<{ key?: string }[]> }) =>
  (await ui.findAll({ type: 'Button' })).map(button => button.key).filter(key => key !== undefined && /^(story|yes|decisions)-ST-1$/.test(key))

test('a plan that waits for its yes draws the waiting row and its plan row with keys of their own, and both open the plan', async ($, on) => {
  const files = seededBoard()
  files.set(`${STORIES}/ST-1.md`, storyFile('ST-1', 'Tags on items', 'Asked: tags.').replace('updated: 2026-11-16', 'updated: 2026-11-16\nawaitsYes: true'))
  standInForEngine(on, files)
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await storyButtonKeys(ui)).toEqual(['yes-ST-1', 'story-ST-1'])
  for (const key of ['yes-ST-1', 'story-ST-1']) {
    await ui.press({ key })
    expect((await ui.find({ type: 'Text', text: 'Tags on items for everyone.' }))?.text).toBe('Tags on items for everyone.')
    await ui.press({ key: 'back-from-story' })
  }
  await ui.unmount()
})

test('a plan with open decisions draws the decisions row and its plan row with keys of their own, and both open the plan', async ($, on) => {
  const files = seededBoard()
  standInForEngine(on, files)
  await startSession($)
  const questions = [{ question: 'How many retries?', recommended: 'retries: 2', otherCosts: 'Three is slower.' }]
  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'story', title: 'Uploads', destination: 'Uploads retry.', analysis: 'Asked: retry.', questions }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'back-from-story' })

  expect(await storyButtonKeys(ui)).toEqual(['decisions-ST-1', 'story-ST-1'])
  for (const key of ['decisions-ST-1', 'story-ST-1']) {
    await ui.press({ key })
    expect((await ui.find({ type: 'Text', text: 'Uploads retry.' }))?.text).toBe('Uploads retry.')
    await ui.press({ key: 'back-from-story' })
  }
  await ui.unmount()
})

const PATH = [
  { what: 'The upload is sent', file: 'src/upload.ts', line: 12 },
  { what: 'A failure is reported', file: 'src/report.ts', line: 40, note: 'retry goes here' },
  { what: 'The person sees it', file: 'src/toast.ts', line: 7 },
]

const bordered = async (ui: { findAll: (query: { type: string }) => Promise<{ props: Record<string, unknown> }[]> }) =>
  (await ui.findAll({ type: 'Box' })).filter(box => box.props.borderStyle !== undefined)

test('the plan view draws the path as bordered boxes with arrows and the excerpts as code in a 50-column pane, and with the board placed the path is not placed in the transcript', async ($, on) => {
  const standIn = standInForEngine(on, seededBoard())
  await startSession($)
  const excerpts = [{ file: 'src/upload.ts', firstLine: 12, lines: 'export const upload = (file: File) =>\n  send(file)' }]

  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'story', title: 'Uploads', destination: 'Uploads retry.', analysis: 'Asked: retry.', path: PATH, excerpts }] })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 50 }, surface: 'terminal' })

  expect((await bordered(ui)).length).toBe(3)
  expect((await ui.findAll({ type: 'Text', text: '↓' })).length).toBe(2)
  expect((await ui.find({ type: 'Text', text: 'src/report.ts:40' }))?.text).toBe('src/report.ts:40')
  const code = await ui.find({ type: 'Code' })
  expect(code?.props).toMatchObject({ source: excerpts[0]?.lines, startLine: 12, language: 'ts' })
  await ui.unmount()

  expect(standIn.placedRows).toEqual([])
})

test('with no board placed the first path is placed in the transcript once', async ($, on) => {
  const standIn = standInForEngine(on, seededBoard(), false)
  await startSession($)

  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'story', title: 'Uploads', destination: 'Uploads retry.', analysis: 'Asked: retry.', path: PATH }] })

  expect(standIn.placedRows).toEqual(['path-ST-1'])
  const placed = await $.ui.mount({ plugin: 'sidequest', component: 'Placed', props: { id: 'path-ST-1', plugin: 'sidequest' }, surface: 'terminal' })
  expect((await bordered(placed)).length).toBe(3)
  await placed.unmount()

  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'patch', id: 'ST-1', path: PATH.slice(0, 2) }] })
  expect(standIn.placedRows).toEqual(['path-ST-1'])
})

const PLAN_PARTS = ['in-short', 'decisions-for-you', 'path', 'analysis', 'excerpts', 'already-decided']
const DESTINATION = 'Uploads retry.'

const planPartOf = (element: { key?: string; type: string; text: string }): string[] => {
  if (element.type === 'Text' && element.text === DESTINATION) return ['destination']

  return element.key !== undefined && PLAN_PARTS.includes(element.key) ? [element.key] : []
}

const planPartsInOrder = async (ui: { findAll: (query: { key?: string }) => Promise<{ key?: string; type: string; text: string }[]> }): Promise<string[]> =>
  (await ui.findAll({})).flatMap(planPartOf)

test('the plan view starts with the short version, then its open decisions, and ends with the excerpts, and with none open goes from the short version to the path and ends with what was decided', async ($, on) => {
  standInForEngine(on, seededBoard())
  await startSession($)
  const excerpts = [{ file: 'src/retry.ts', firstLine: 3, lines: 'export const retries = 0' }]
  const questions = [{ question: 'How many retries?', recommended: 'retries: 2', otherCosts: 'Three is slower.' }]
  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'story', title: 'Uploads', inShort: IN_SHORT, destination: 'Uploads retry.', analysis: 'Asked: retry.', path: PATH, excerpts, questions }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await planPartsInOrder(ui)).toEqual(['in-short', 'decisions-for-you', 'destination', 'path', 'analysis', 'excerpts'])
  expect((await ui.find({ key: 'in-short' }))?.text).toBe(IN_SHORT)

  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'patch', id: 'ST-1', questions: [], decisions: [{ question: 'How many retries?', answer: 'retries: 2' }] }] })
  expect(await planPartsInOrder(ui)).toEqual(['in-short', 'destination', 'path', 'analysis', 'excerpts', 'already-decided'])
  expect((await ui.find({ type: 'Markdown', text: 'How many retries?' }))?.text).toContain('Answer: retries: 2')
  await ui.unmount()
})

test('the path boxes share one width, a changed step is marked, and an excerpt names its file once', async ($, on) => {
  standInForEngine(on, seededBoard())
  await startSession($)
  const excerpts = [{ file: 'src/retry.ts', firstLine: 3, lines: 'export const retries = 0' }]
  const path = [PATH[0], { ...PATH[1], changed: true }, PATH[2]]
  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'story', title: 'Uploads', destination: 'Uploads retry.', analysis: 'Asked: retry.', path, excerpts }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ key: 'path' }))?.props).toMatchObject({ alignSelf: 'flex-start', alignItems: 'stretch' })
  expect((await bordered(ui)).map(box => box.props.width)).toEqual([undefined, undefined, undefined])
  expect((await bordered(ui)).map(box => box.props.borderColor)).toEqual([undefined, 'claude', undefined])
  expect((await ui.findAll({ type: 'Text', text: 'A failure is reported (changed)' })).length).toBe(1)
  expect((await ui.findAll({ type: 'Text', text: '(changed)' })).length).toBe(1)
  expect((await ui.findAll({ type: 'Text', text: 'src/retry.ts' })).map(text => text.text)).toEqual(['src/retry.ts:3'])
  expect((await ui.find({ type: 'Code' }))?.props.path).toBeUndefined()
  await ui.unmount()
})

const WAITING_FOR_YES = { id: 'ST-1', title: 'Search archived notes', openQuestions: 0, awaitsYes: true } as const

test('a plan whose playback waits for the yes shows under Waits on you, first in the pane, in both layouts', () => {
  const byStatus = boardPaneLines({ ...quietContent([cardWith(1, 'ready')]), storiesToRead: [WAITING_FOR_YES] })
  const piece = (handle: string, order: number) => ({ handle, order })
  const twoPieces = [{ ...cardWith(1, 'ready'), piece: piece('PAY-41 Refunds', 0) }, { ...cardWith(2, 'ready'), piece: piece('PAY-57 Ledger', 1) }]
  const running = [{ agentId: 'agent-1', what: 'Build it', ticket: 'SQ-1', model: 'sonnet', canBeViewed: true }]
  const byPiece = boardPaneLines({ ...quietContent(twoPieces), running, storiesToRead: [WAITING_FOR_YES] })

  for (const lines of [byStatus, byPiece]) {
    expect(paneLinesAsText(lines).split('\n').slice(0, 3)).toEqual(['Waits on you', `  ${YES_ON_THE_PLAN}`, ''])
    expect(lines.find(line => line.kind === 'row' && line.text === YES_ON_THE_PLAN)).toMatchObject({ tone: 'waiting', press: { opens: 'story-yes', id: 'ST-1' } })
  }
  expect(paneLinesAsText(byPiece).split('\n')[3]).toBe('Now')
  expect(rowTexts(boardPaneLines({ ...quietContent([]), storiesToRead: [{ id: 'ST-1', title: 'Search archived notes', openQuestions: 0 }] }))).not.toContain(YES_ON_THE_PLAN)
})

test('the row for a plan that waits for its yes shows whole in a 45-column pane', () => {
  const row = boardPaneLines({ ...quietContent([]), storiesToRead: [WAITING_FOR_YES] }).find(line => line.kind === 'row' && line.text === YES_ON_THE_PLAN)

  expect(row?.kind === 'row' && fittedRow(row, 45 - '┃ '.length).text).toBe('Your yes on the proposed tickets')
})

test('a story patched as waiting for its yes keeps the mark in its file and shows the row, and the patch on the yes takes it away', async ($, on) => {
  const files = seededBoard()
  standInForEngine(on, files)
  await startSession($)
  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'story', title: 'Uploads', destination: 'Uploads retry.', analysis: 'Asked: retry.' }] })
  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'patch', id: 'ST-1', awaitsYes: true }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'back-from-story' })

  expect(files.get(`${STORIES}/ST-1.md`)).toContain('awaitsYes: true')
  expect((await ui.find({ type: 'Button', text: YES_ON_THE_PLAN }))?.text).toBe(YES_ON_THE_PLAN)

  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'patch', id: 'ST-1', awaitsYes: false, outOfScope: 'Downloads.' }] })
  await ui.press({ key: 'back-from-story' }).catch(() => undefined)
  expect(files.get(`${STORIES}/ST-1.md`)).not.toContain('awaitsYes')
  expect(await ui.find({ type: 'Button', text: YES_ON_THE_PLAN })).toBeUndefined()
  await ui.unmount()
})

test('the board tool returns the diagram of a story path, and the routing view says the pull request diagram was not asked yet', async ($, on) => {
  standInForEngine(on, seededBoard())
  await startSession($)
  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'story', title: 'Uploads', destination: 'Uploads retry.', path: [{ ...PATH[0], changed: true }, PATH[1]] }] })

  const diagram = await $.tool.call({ tool: 'mcp__sidequest__board', view: 'diagram', id: 'ST-1' })
  const routing = await $.tool.call({ tool: 'mcp__sidequest__board', view: 'routing' })

  expect(diagram.result).toContain('```mermaid\nflowchart TD\n  step1["The upload is sent (changed)<br/>src/upload.ts:12"]:::changed')
  expect(routing.result).toContain('pullRequestDiagram: not asked yet')
})

test('a change shown before a commit in a ticket\'s For you part is drawn as a diff, out of the words', () => {
  const forYou = '### Question\nShip this change?\n\n```diff\n@@ -1 +1 @@\n-retries = 0\n+retries = 2\n```'
  const detail = ticketDetail(newTicket('SQ-1', { title: 'Retry', mode: 'hitl', forYou }, '2026-11-16T09:56Z'))

  expect(detail.diff).toBe('@@ -1 +1 @@\n-retries = 0\n+retries = 2')
  expect(detail.forYouLines.join('\n')).not.toContain('retries')
})

test('the first time the pane opens two lines say what the sections mean, and the store remembers it', async ($, on) => {
  const standIn = standInForEngine(on, seededBoard())
  await startSession($)
  await runBoardCommand($)

  const ui = await $.ui.mount({ ...PANE_AT_80, surface: 'terminal' })

  const texts = (await ui.findAll({ type: 'Text' })).map(element => element.text)
  expect(texts.slice(0, 2)).toEqual([
    'Now is what runs this moment. Waits on you needs your answer.',
    'Next is what comes after that, Done what finished. Press a row to open it.',
  ])
  expect(standIn.store.get('boardIntroSeen')).toBe(true)
  await ui.unmount()
})

test('a finished run and a ticket that starts needing the human raise toasts by title', async ($, on) => {
  const standIn = standInForEngine(on, seededBoard())
  await startSession($)

  await $.tool.call({ tool: 'mcp__sidequest__finish', id: 'SQ-2', outcome: 'done', result: 'Traced it.' })
  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'move', id: 'SQ-1', status: 'needs-you' }] })
  await $.tool.call({ tool: 'mcp__sidequest__finish', id: 'SQ-9', outcome: 'done', result: 'No such ticket.' })

  expect(standIn.toasts).toEqual([
    'Finished: Trace upload flow (SQ-2), being checked',
    'Needs you: Retry failed uploads (SQ-1)',
  ])
  expect(standIn.openedPanes).toEqual(['board'])
})

test('where no pane can be drawn /board answers with the board as text', async ($, on) => {
  const standIn = standInForEngine(on, seededBoard(), false)
  standIn.store.set('boardIntroSeen', true)
  await startSession($)

  const answer = await runBoardCommand($)

  expect(answer.text).toBe(
    [
      'Waits on you',
      '  SQ-3 Pick a backoff  no question written yet',
      '',
      'Now',
      '  SQ-2 Trace upload flow  stopped, nothing runs it',
      '',
      'Next',
      '  SQ-1 Retry failed uploads',
    ].join('\n'),
  )
})

const cardWith = (number: number, status: string, updated = '2026-11-16'): BoardCard => ({
  id: `SQ-${number}`,
  title: `Ticket ${number}`,
  status,
  category: 'build',
  updated,
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

const rowTexts = (lines: readonly PaneLine[]): string[] => lines.flatMap(line => (line.kind === 'row' ? [line.text] : []))

test('Done keeps the three most recent, dim', () => {
  const cards = [1, 2, 3, 4, 5].map(number => cardWith(number, 'done', number < 3 ? '2026-11-16' : '2026-11-10'))

  const lines = boardPaneLines(quietContent(cards))

  expect(rowTexts(lines)).toEqual(['SQ-2 Ticket 2', 'SQ-1 Ticket 1', 'SQ-5 Ticket 5'])
  expect(lines.filter(line => line.kind === 'row').every(line => line.kind === 'row' && line.tone === 'dim')).toBe(true)
})

test('built work being checked has its own section between Now and Next, and Next lists ready, then what was started and is not running', () => {
  const cards = [cardWith(3, 'doing'), cardWith(2, 'review'), cardWith(1, 'ready'), cardWith(4, 'doing')]
  const running = [{ agentId: 'agent-1', what: 'Build it', ticket: 'SQ-4', model: 'sonnet', canBeViewed: true }]

  const lines = boardPaneLines({ ...quietContent(cards), running })

  expect(lines.map(line => (line.kind === 'row' ? `${line.text} | ${line.aside}` : line.kind === 'label' ? line.text : line.kind))).toEqual([
    'Now',
    'SQ-4 Ticket 4 | sonnet',
    'gap',
    'Being checked',
    'SQ-2 Ticket 2 | ',
    'gap',
    'Next',
    'SQ-1 Ticket 1 | ',
    'SQ-3 Ticket 3 | started earlier, nothing runs it now',
  ])
})

const EXPLAINER_START = 'Work bigger than a quick fix gets a ticket.'

const showsExplainer = (content: PaneContent): boolean => paneLinesAsText(boardPaneLines(content)).includes(EXPLAINER_START)

test('the line on what gets a ticket shows on an empty board only, never beside a plan, a running build or a waiting question', () => {
  const plan = { id: 'ST-1', title: 'Search archived notes', openQuestions: 0 }
  const build = { agentId: 'agent-1', what: 'Build it', ticket: 'SQ-4', model: 'sonnet', canBeViewed: true }

  expect(showsExplainer(quietContent([]))).toBe(true)
  expect(showsExplainer({ ...quietContent([]), storiesToRead: [plan] })).toBe(false)
  expect(showsExplainer({ ...quietContent([cardWith(4, 'doing')]), running: [build] })).toBe(false)
  expect(showsExplainer({ ...quietContent([]), storiesToRead: [{ ...plan, openQuestions: 2 }] })).toBe(false)
  expect(showsExplainer(quietContent([{ ...cardWith(3, 'needs-you'), question: 'Commit it?' }]))).toBe(false)
})

test('a plan with open questions waits on the person as one row with their count, beside what else waits, and goes once they are answered', () => {
  const plan = { id: 'ST-1', title: 'Search archived notes', openQuestions: 3 }
  const waiting = { ...cardWith(3, 'needs-you'), question: 'Commit it?' }
  const lines = boardPaneLines({ ...quietContent([waiting]), storiesToRead: [plan] })
  const rows = lines.flatMap(line => (line.kind === 'row' ? [line] : []))

  expect(paneLinesAsText(lines).split('\n').slice(0, 8)).toEqual([
    'Waits on you',
    '  3 decisions on the plan',
    '  SQ-3 Commit it?',
    '',
    NOTHING_IS_RUNNING,
    '',
    'The plan',
    '  Search archived notes  analysis and decisions',
  ])
  expect(rows.find(row => row.text === '3 decisions on the plan')?.press).toEqual({ opens: 'story-decisions', id: 'ST-1' })
  expect(rowTexts(boardPaneLines({ ...quietContent([]), storiesToRead: [{ ...plan, openQuestions: 1 }] }))).toContain('1 decision on the plan')
  expect(rowTexts(boardPaneLines({ ...quietContent([]), storiesToRead: [{ ...plan, openQuestions: 0 }] }))).not.toContain('0 decisions on the plan')
})

test('in a narrow pane a row keeps the status beside it and cuts its title, and the session row keeps what it is doing', () => {
  const started = { ...cardWith(2, 'doing'), title: 'Show the last sync time in the footer' }
  const firstRow = (lines: readonly PaneLine[]) => lines.find(line => line.kind === 'row')
  const startedRow = firstRow(boardPaneLines(quietContent([started])))
  const working = { isWorking: true, steps: 2, activity: 'running the notes tests', since: NOW }
  const sessionRow = firstRow(boardPaneLines({ ...quietContent([]), sessionWork: working }))
  const fittedStarted = startedRow?.kind === 'row' ? fittedRow(startedRow, 60) : undefined

  expect(fittedStarted?.aside).toBe('started earlier, nothing runs it now')
  expect(fittedStarted?.text.startsWith('SQ-2 Show')).toBe(true)
  expect(fittedStarted?.text.endsWith('...')).toBe(true)
  expect(sessionRow?.kind === 'row' && fittedRow(sessionRow, 60)).toEqual({ text: 'This session', aside: `running the notes tests, since ${clockTime(NOW)}` })
})

test('a cut pane says on its last visible row how many more rows there are and how to scroll', () => {
  const lines: PaneLine[] = Array.from({ length: 10 }, (_, index) => ({ kind: 'sentence', text: `row ${index}`, isDim: false }))

  const cut = withScrollCue(lines, { offset: 0, bodyRows: 4, isFocused: false })
  const scrolled = withScrollCue(lines, { offset: 6, bodyRows: 4, isFocused: true })

  expect(cut.slice(0, 4).map(line => (line.kind === 'gap' ? '' : line.text))).toEqual([
    'row 0',
    'row 1',
    'row 2',
    '7 more below: press ctrl+x, then tab, then the arrow keys',
  ])
  expect(scrolled).toHaveLength(10)
  expect(withScrollCue(lines, { offset: 5, bodyRows: 4, isFocused: true })[8]).toEqual({
    kind: 'scroll-cue',
    text: '2 more below: the arrow keys scroll',
  })
})

test('a pane row names the tracker key once and no branch, and the ticket detail keeps the branch', () => {
  const fields = { title: 'PAY-41 Retry failed payments', issue: 'PAY-41', branch: 'bugfix/PAY-41-retry', startedBy: 'session' }
  const ticket = newTicket('SQ-4', fields, '2026-11-16T10:02Z')

  expect(rowTexts(boardPaneLines(quietContent(boardCards([ticket], DEFAULT_BOARD_CONFIG))))).toEqual([
    'PAY-41 SQ-4 Retry failed payments',
  ])
  expect(ticketDetail(ticket).facts).toBe('PAY-41 SQ-4 on branch bugfix/PAY-41-retry, started by the session, ready to start, updated 2026-11-16')
})

test('the ticket view shows what, done when and the decisions it rests on, and never the log, kind, mode or category', () => {
  const fields = { title: 'Retry failed uploads', status: 'doing', kind: 'build', mode: 'afk', category: 'hard', branch: 'main', story: 'ST-1' }
  const ticket = {
    ...newTicket('SQ-203', fields, '2026-11-24T09:00Z'),
    what: 'Retry an upload three times.',
    doneWhen: '- [ ] A failed upload is retried.',
    decisions: ['D-2'],
    log: ['2026-11-24T09:05Z started worker opus/high. delivery none', '2026-11-24T09:06Z agent ac2296 hard requested opus/high resolved claude-opus-5-5'],
  }
  const story = { ...newStory('ST-1', 'Uploads', '2026-11-24T09:00Z'), decisions: '- D-1 Which queue? A: the old one.\n- D-2 How many tries? A: three.' }

  const detail = ticketDetail(ticket, story)

  expect(detail.facts).toBe('SQ-203 on branch main, in progress, story ST-1, updated 2026-11-24')
  expect(detail.body).toBe(
    '## What\nRetry an upload three times.\n\n## Done when\n- [ ] A failed upload is retried.\n\n## Already decided\n- D-2 How many tries? A: three.',
  )
  expect(ticketDetail(ticket).body).toContain('## Already decided\nD-2')
})

test('a pane row for a ticket whose title is only its tracker key reads the key once', () => {
  const ticket = newTicket('SQ-4', { title: 'PAY-41', issue: 'PAY-41' }, '2026-11-16T10:02Z')

  expect(rowTexts(boardPaneLines(quietContent(boardCards([ticket], DEFAULT_BOARD_CONFIG))))).toEqual(['PAY-41 SQ-4'])
})

test('approve from a view older than the file leaves a finished, a dropped and an ordinary ticket as they are', () => {
  const checkpoint = { ...newTicket('SQ-4', { title: 'Look at the upload flow', kind: 'review', mode: 'hitl' }, '2026-11-16T10:02Z') }

  expect(approvedByHuman(checkpoint, '2026-11-16T10:05Z')?.ticket.status).toBe('done')
  expect(approvedByHuman({ ...checkpoint, status: 'done' }, '2026-11-16T10:05Z')).toBeUndefined()
  expect(approvedByHuman({ ...checkpoint, status: 'dropped' }, '2026-11-16T10:05Z')).toBeUndefined()
  expect(approvedByHuman({ ...checkpoint, kind: 'build' }, '2026-11-16T10:05Z')).toBeUndefined()
})

test('a Waits on you row with no question carries the aside no question written yet', () => {
  const asking = newTicket('SQ-4', { title: 'Pick a login provider', status: 'needs-you' }, '2026-11-16T09:56Z')
  const lines = boardPaneLines(quietContent(boardCards([asking], DEFAULT_BOARD_CONFIG)))

  expect(paneLinesAsText(lines)).toContain('SQ-4 Pick a login provider  no question written yet')
})

test('while one ticket holds the stack the pane says how long it has run, who waits behind it, and what the person could do', () => {
  const config = mergeBoardConfig({ settings: { shared: { stack: { what: 'the local app', refresh: 'auto' } } } })
  const holding = { ...newTicket('SQ-1', { title: 'Check the login', status: 'doing', uses: ['stack'] }, '2026-11-16T09:56Z'), log: ['2026-11-16T09:56Z started worker sonnet/medium'] }
  const tickets = [
    holding,
    newTicket('SQ-2', { title: 'Fix the session timeout', uses: ['stack'] }, '2026-11-16T09:56Z'),
    newTicket('SQ-3', { title: 'Fix the footer typo' }, '2026-11-16T09:56Z'),
    newTicket('SQ-4', { title: 'Pick a login provider', status: 'needs-you', forYou: 'Question: Which login provider?' }, '2026-11-16T09:56Z'),
  ]
  const running = [{ agentId: 'agent-1', what: 'Check the login', ticket: 'SQ-1', model: 'sonnet', canBeViewed: true }]
  const content = { ...quietContent(boardCards(tickets, config)), running, whatYouCouldDo: whatThePersonCouldDo(tickets) }

  const lines = boardPaneLines(content)

  expect(paneLinesAsText(lines)).toBe(
    [
      'Waits on you',
      '  SQ-4 Which login provider?',
      '',
      'Now',
      '  SQ-1 Check the login  sonnet, 6m',
      '',
      'You could',
      '  Answer: Which login provider?',
      '',
      'Next',
      '  SQ-2 Fix the session timeout  waits on SQ-1 (stack)',
      '  SQ-3 Fix the footer typo',
    ].join('\n'),
  )
  expect(boardPaneLines({ ...content, running: [] }).some(line => line.kind === 'label' && line.text === 'You could')).toBe(false)
})

test('an answer typed on a ticket that needs the human lands in its log and in one line to the session', EVERY_SURFACE, async ($, on) => {
  const files = seededBoard()
  const standIn = standInForEngine(on, files)
  await startSession($)
  await runBoardCommand($)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'SQ-1' })
    expect(await ui.find({ type: 'Input', key: 'answer' })).toBeUndefined()
    await ui.press({ key: 'back' })
    await ui.press({ key: 'SQ-3' })
    await ui.input({ key: 'answer', text: '   ', kind: 'change' })
    await ui.press({ key: 'send-answer' })
    await ui.input({ key: 'answer', text: `Three retries,\nexponential, says ${surface}`, kind: 'change' })
    await ui.press({ key: 'send-answer' })
    await ui.press({ key: 'back' })
    await ui.unmount()
    await askAgain($, 'SQ-3')
  }

  const answers = SURFACES.map(surface => `Three retries, exponential, says ${surface}`)
  expect(standIn.submitted).toEqual(
    answers.map(answer => `My answer on SQ-3 (Pick a backoff), written on the ticket from the board: ${answer}`),
  )
  for (const answer of answers) {
    expect(files.get(`${TICKETS}/SQ-3.md`)).toContain(`- 2026-11-16T10:02Z answered by human in the board: ${answer}`)
  }
  expect(files.get(`${TICKETS}/SQ-3.md`)).toContain('status: needs-you')
})

const FOR_YOU_SECTION = [
  '## For you',
  'Question: How long should a failed upload wait before it tries again?',
  'Why now: Retries ship once this is picked.',
  'Options:',
  '- One second: Fast recovery. Costs: More load on a struggling server.',
  '- Ten seconds: A gentle server. Costs: Slower recovery.',
  'Recommended: One second',
  'If you never answer: Uploads keep failing on the first error.',
  '',
].join('\n')

const QUESTION = 'How long should a failed upload wait before it tries again?'

const ALSO_YOURS_SECTION = ['Also yours:', '- Rename the retry flag (if you say nothing: left as it is)', '- Log each retry (if you say nothing: not logged)', ''].join('\n')

const waitingTicketFile = (forYou: string): string => ticketFile('SQ-3', 'Pick a backoff', 'needs-you').replace('## What', `${forYou}\n## What`)

test('a waiting ticket opens as the question and nothing else until Show the whole ticket is pressed', async ($, on) => {
  const files = seededBoard()
  files.set(`${TICKETS}/SQ-3.md`, waitingTicketFile(FOR_YOU_SECTION))
  standInForEngine(on, files)
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 100 } })

  expect((await ui.find({ type: 'Button', key: 'SQ-3' }))?.text).toBe(`SQ-3 ${QUESTION}  recommended: One second`)
  await ui.press({ key: 'SQ-3' })

  const drawn = await ui.findAll({})
  expect(drawn.find(element => element.type === 'Text')?.text).toBe(QUESTION)
  expect(drawn.findIndex(element => /^Why now/.test(element.text))).toBeLessThan(drawn.findIndex(element => element.key === 'option-A'))
  expect(await ui.find({ type: 'Button', key: 'show-whole' })).toBeDefined()
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'drop' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'set-aside' })).toBeUndefined()

  await ui.press({ key: 'show-whole' })
  expect((await ui.find({ type: 'Markdown' }))?.text).toContain('## What')
  expect((await ui.find({ type: 'Text', text: /^Set aside: / }))?.text).toContain('Its files, branch and worktree stay as they are.')
  expect((await ui.find({ type: 'Text', text: /^Set aside: / }))?.text).toContain('Drop: off the board, never offered again. It has no worktree or branch of its own, so nothing on disk changes.')
  await ui.unmount()
})

test('one send puts the picked answer, the ticked extras and the words in the chat as one message, and on the ticket', async ($, on) => {
  const files = seededBoard()
  files.set(`${TICKETS}/SQ-3.md`, waitingTicketFile(`${FOR_YOU_SECTION}${ALSO_YOURS_SECTION}`))
  const standIn = standInForEngine(on, files)
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'SQ-3' })
  expect((await ui.find({ type: 'Button', key: 'also-1' }))?.text).toBe('[ ] Log each retry (if you say nothing: not logged)')
  await ui.press({ key: 'option-B' })
  await ui.press({ key: 'also-1' })
  expect((await ui.find({ type: 'Button', key: 'also-1' }))?.text).toBe('[x] Log each retry (if you say nothing: not logged)')
  await ui.input({ key: 'answer', text: 'and keep it under a minute' })
  expect(standIn.submitted).toEqual([])
  expect((await ui.find({ type: 'Input', key: 'answer' }))?.props.value).toBe('and keep it under a minute')
  await ui.press({ key: 'send-answer' })
  await ui.unmount()

  const line = 'B. Ten seconds. Also do: Log each retry (if you say nothing: not logged). and keep it under a minute'
  expect(standIn.submitted).toEqual([`My answer on SQ-3 (Pick a backoff), written on the ticket from the board: ${line}`])
  expect(files.get(`${TICKETS}/SQ-3.md`)).toContain(`- 2026-11-16T10:02Z answered by human in the board: ${line}`)
})

test('the pasted waiting view numbers what was left to the person', async ($, on) => {
  const files = seededBoard()
  files.set(`${TICKETS}/SQ-3.md`, waitingTicketFile(`${FOR_YOU_SECTION}${ALSO_YOURS_SECTION}`))
  standInForEngine(on, files)
  await startSession($)

  const waiting = await $.tool.call({ tool: 'mcp__sidequest__board', view: 'waiting' })
  const text = typeof waiting.result === 'string' ? waiting.result : ''

  expect(text).toContain('Also yours, say which to do too:')
  expect(text).toContain('1. Rename the retry flag (if you say nothing: left as it is)')
  expect(text).toContain('2. Log each retry (if you say nothing: not logged)')
})

test('the needs-you row shows the question, and pressing an option writes the answer on the ticket and says one line', EVERY_SURFACE, async ($, on) => {
  const files = seededBoard()
  files.set(`${TICKETS}/SQ-3.md`, ticketFile('SQ-3', 'Pick a backoff', 'needs-you').replace('## What', `${FOR_YOU_SECTION}\n## What`))
  const standIn = standInForEngine(on, files)
  await startSession($)
  await runBoardCommand($)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Button', key: 'SQ-3' }))?.text).toContain('SQ-3 How long should a failed upload wait')
    await ui.press({ key: 'SQ-3' })
    expect(await ui.find({ type: 'Text', text: 'A. One second: Fast recovery. Costs: More load on a struggling server.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Recommended: A (One second)' })).toBeDefined()
    expect(await ui.find({ type: 'Input', key: 'answer' })).toBeDefined()
    await ui.press({ key: 'option-B' })
    await ui.press({ key: 'send-answer' })
    await ui.press({ key: 'back' })
    await ui.unmount()
    await askAgain($, 'SQ-3')
  }

  expect(standIn.submitted).toEqual(
    SURFACES.map(() => 'My answer on SQ-3 (Pick a backoff), written on the ticket from the board: B. Ten seconds'),
  )
  expect(files.get(`${TICKETS}/SQ-3.md`)).toContain('- 2026-11-16T10:02Z answered by human in the board: B. Ten seconds')
  expect(files.get(`${TICKETS}/SQ-3.md`)).toContain(FOR_YOU_SECTION.trim())
})

test('words typed under a waiting ticket and never entered go out with the pick when Send is pressed, once', async ($, on) => {
  const files = seededBoard()
  files.set(`${TICKETS}/SQ-3.md`, ticketFile('SQ-3', 'Pick a backoff', 'needs-you').replace('## What', `${FOR_YOU_SECTION}\n## What`))
  const standIn = standInForEngine(on, files)
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'SQ-3' })
  await ui.press({ key: 'option-B' })
  await ui.input({ key: 'answer', text: 'and keep it under a minute', kind: 'change' })
  await ui.press({ key: 'send-answer' })
  await ui.unmount()

  expect(standIn.submitted).toHaveLength(1)
  expect(standIn.submitted[0]).toContain('B. Ten seconds')
  expect(standIn.submitted[0]).toContain('and keep it under a minute')
})

const spawnInput = (
  fields: Pick<AgentSpawnInput, 'subagentType' | 'prompt' | 'description'> & Partial<AgentSpawnInput>,
): AgentSpawnInput => ({
  tool_use_id: 'toolu_1',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'opus',
  background: true,
  fork: false,
  ...fields,
})

const endAgentTurn = ($: Engine, agentId: string) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', agentId, reason: 'answer' })

test('a scout started with only a route tag is listed in the pane with what it does and its model, and View is offered only where a main view exists', EVERY_SURFACE, async ($, on) => {
  const standIn = standInForEngine(on, seededBoard())
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-7' }))
  let scoutStatus: 'running' | 'completed' = 'running'
  on('agent.list', () => ({
    value: [
      { id: 'agent-7', description: 'Find the retry code', type: 'sidequest:scout', status: scoutStatus },
      { id: 'agent-8', description: 'A forked skill', type: 'fork', status: 'running' },
      { id: 'agent-9', description: 'Long gone', type: 'Explore', status: 'completed' },
    ],
  }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await startSession($)
  await $.agent.spawn(
    spawnInput({
      subagentType: 'sidequest:scout',
      prompt: '[route:explore] Find where uploads are retried.',
      description: 'Find the retry code',
    }),
  )

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^NOW$/ }))?.text).toBe('NOW')
    expect((await ui.find({ type: 'Text', text: /^Find the retry code/ }))?.text).toBe('Find the retry code  sonnet')
    expect(await ui.find({ type: 'Text', text: /explore|build/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Long gone/ })).toBeUndefined()
    if (surface === 'terminal') await ui.press({ key: 'view-agent-7' })
    else expect(await ui.find({ type: 'Button', key: 'view-agent-7' })).toBeUndefined()
    await ui.unmount()
  }
  expect(standIn.viewedAgents).toEqual(['agent-7'])

  scoutStatus = 'completed'
  await endAgentTurn($, 'agent-7')
  const afterwards = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await afterwards.find({ type: 'Button', key: 'view-agent-7' })).toBeUndefined()
  await afterwards.unmount()
})

type RowFlags = { isExpanded?: boolean; isErrored?: boolean }

const toolRow = (tool: string, input: unknown, output: unknown, flags: RowFlags = {}) =>
  ({
    plugin: 'sidequest',
    component: 'ToolUse',
    requestId: 'toolu_1',
    props: { tool_use_id: 'toolu_1', tool, input, output, isRunning: false, isErrored: false, isInterrupted: false, ...flags },
  }) as const

type MountedRow = Omit<Parameters<Engine['ui']['mount']>[0], 'surface'>

const rowText = async ($: Engine, surface: RenderSurface, row: MountedRow): Promise<string | undefined> => {
  const ui = await $.ui.mount({ ...row, surface })
  const text = (await ui.find({ type: 'Text' }))?.text
  await ui.unmount()

  return text
}

test('a ticket create draws as one readable row, and as the host row when expanded or failed', EVERY_SURFACE, async ($, on) => {
  standInForEngine(on, seededBoard())
  standInForEngineDrawing(on)
  await startSession($)
  const create = { operations: [{ op: 'create', title: 'Show retry count' }, { op: 'move', id: 'SQ-1', status: 'doing' }] }
  const answer = 'created SQ-4, moved SQ-1 to doing. SQ-4 is blocked by SQ-9, which is not on this board.'

  for (const surface of SURFACES) {
    expect(await rowText($, surface, toolRow('mcp__sidequest__ticket', create, answer))).toBe('board SQ-4 created, SQ-1 now in progress')
    expect(await rowText($, surface, toolRow('mcp__sidequest__ticket', create, answer, { isExpanded: true }))).toBe('engine')
  }
  expect(await rowText($, 'terminal', toolRow('mcp__sidequest__ticket', create, 'no ticket SQ-9', { isErrored: true }))).toBe('engine')
  expect(await rowText($, 'terminal', toolRow('mcp__sidequest__ticket', create, undefined))).toBe('board writing 2 board changes')
  expect(await rowText($, 'terminal', toolRow('Bash', { command: 'ls' }, undefined))).toBe('engine')
})

test('a write that created a story says which id is the story', async ($, on) => {
  standInForEngine(on, seededBoard())
  standInForEngineDrawing(on)
  await startSession($)
  const create = { operations: [{ op: 'story', title: 'Due dates' }, { op: 'create', title: 'Add a due date' }] }

  expect(await rowText($, 'terminal', toolRow('mcp__sidequest__ticket', create, 'created ST-2, created SQ-10.'))).toBe(
    'board story ST-2 created, SQ-10 created',
  )
})

test('start, finish, a board read and a routed spawn each draw as one row', async ($, on) => {
  standInForEngine(on, seededBoard())
  standInForEngineDrawing(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-3' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await startSession($)
  const started = await $.tool.call({ tool: 'mcp__sidequest__start', id: 'SQ-1' })
  const finished = await $.tool.call({ tool: 'mcp__sidequest__finish', id: 'SQ-2', outcome: 'done', result: 'Traced it.' })
  const routed = { subagent_type: 'sidequest:scout', description: 'Find the retry code', prompt: '[route:explore] Find it.' }
  await $.agent.spawn(spawnInput({ subagentType: 'sidequest:scout', prompt: routed.prompt, description: routed.description }))
  const finishedAsBlocks = [{ type: 'text', text: finished.result }]

  expect(finished.result).toMatch(/^SQ-2 moved to review after 1h 2m\. No verify command is set\./)
  expect(await rowText($, 'terminal', toolRow('mcp__sidequest__start', { id: 'SQ-1' }, started.result))).toBe(
    'board SQ-1 started: worker agent on sonnet, medium effort',
  )
  expect(await rowText($, 'terminal', toolRow('mcp__sidequest__finish', { id: 'SQ-2', outcome: 'done' }, finishedAsBlocks))).toBe(
    'board SQ-2 done, 1h 2m',
  )
  expect(await rowText($, 'terminal', toolRow('mcp__sidequest__board', { view: 'ticket', id: 'SQ-2' }, 'the file'))).toBe(
    'board read SQ-2',
  )
  expect(await rowText($, 'terminal', toolRow('mcp__sidequest__board', { view: 'planning' }, 'the routing, stories and open tickets'))).toBe(
    'board read',
  )
  const boardResult = (flags: RowFlags = {}) =>
    ({ plugin: 'sidequest', component: 'ToolResult', requestId: 'toolu_1', props: { tool_use_id: 'toolu_1', tool: 'mcp__sidequest__board', output: 'explore: scout, tier light', isErrored: false, ...flags } }) as const
  expect(await rowText($, 'terminal', boardResult())).toBe('3 open tickets, 1 waits on you')
  expect(await rowText($, 'terminal', boardResult({ isExpanded: true }))).toBe('engine')
  expect(await rowText($, 'terminal', boardResult({ isErrored: true }))).toBe('engine')
  expect(await rowText($, 'terminal', toolRow('Agent', routed, undefined))).toBe('agent Find the retry code: scout on sonnet, low effort')
  expect(await rowText($, 'terminal', toolRow('Agent', { ...routed, prompt: 'Find it.' }, undefined))).toBe('engine')
  await endAgentTurn($, 'agent-3')
})

test('a board read that says the same as the read before it draws no result line, and one that says something new does', async ($, on) => {
  const files = seededBoard()
  standInForEngine(on, files)
  standInForEngineDrawing(on)
  await startSession($)
  const readResult = (toolUseId: string) =>
    ({ plugin: 'sidequest', component: 'ToolResult', requestId: toolUseId, props: { tool_use_id: toolUseId, tool: 'mcp__sidequest__board', output: 'the summary', isErrored: false } }) as const

  await $.tool.call({ tool: 'mcp__sidequest__board', view: 'now', tool_use_id: 'toolu_read_1' })
  await $.tool.call({ tool: 'mcp__sidequest__board', view: 'now', tool_use_id: 'toolu_read_2' })
  parkedOnDisk(files)
  await $.tool.call({ tool: 'mcp__sidequest__board', view: 'now', tool_use_id: 'toolu_read_3' })

  expect(await rowText($, 'terminal', readResult('toolu_read_1'))).toBe('3 open tickets, 1 waits on you')
  expect(await rowText($, 'terminal', readResult('toolu_read_2'))).toBeUndefined()
  expect(await rowText($, 'terminal', readResult('toolu_read_3'))).toBe('2 open tickets')
})

test('a ticket that starts needing the human raises one notification naming it, and a finished run another', async ($, on) => {
  const standIn = standInForEngine(on, seededBoard())
  await startSession($)

  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'move', id: 'SQ-1', status: 'needs-you' }] })
  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'note', id: 'SQ-1', text: 'still waiting' }] })
  await $.tool.call({ tool: 'mcp__sidequest__finish', id: 'SQ-2', outcome: 'done', result: 'Traced it.' })

  expect(standIn.notifications).toEqual([
    { text: 'Needs you: Retry failed uploads (SQ-1)', key: 'needs-you-SQ-1' },
    { text: 'Finished: Trace upload flow (SQ-2), being checked', key: 'finished-SQ-2' },
  ])
})

const checkTool = ($: Engine, agentId: string) =>
  $.tool.check({ tool: 'Bash', input: { command: 'npm test' }, tool_use_id: 'toolu_9', agentId, approver: 'person' })

const stepAgent = async ($: Engine, agentId: string): Promise<void> => {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'sonnet', effort: 'medium', messageCount: 1, agentId })
  while (!(await stream.next()).done);
}

test('a subagent whose tool check is answered ask shows in the band with its ticket until its next model request', async ($, on) => {
  const standIn = standInForEngine(on, seededBoard())
  standInForEngineDrawing(on)
  const agentIds = ['agent-21', 'agent-22']
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: agentIds.shift() ?? 'agent-none' }))
  on('tool.check', () => ({ decision: 'ask' }))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await startSession($)
  const worker = { subagentType: 'sidequest:worker', prompt: 'Ticket SQ-2: Trace upload flow', description: 'SQ-2 Trace upload' }
  await $.agent.spawn(spawnInput(worker))
  await $.agent.spawn(spawnInput({ ...worker, prompt: 'Ticket SQ-1: Retry', description: 'SQ-1 Retry', permissionMode: 'auto' }))

  const verdict = await checkTool($, 'agent-21')
  await checkTool($, 'agent-21')
  await checkTool($, 'agent-22')
  await $.tool.check({ tool: 'Bash', input: { command: 'npm test' }, tool_use_id: 'toolu_8', approver: 'person' })

  expect(verdict.decision).toBe('ask')
  const band = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 160 } })
  expect((await band.find({ type: 'Text', text: /permission/ }))?.text).toBe('1 ticket needs you  SQ-2 waits on a permission for Bash')
  await band.unmount()
  expect(standIn.notifications).toEqual([{ text: 'SQ-2 waits on your permission for Bash.', key: 'permission-agent-21' }])

  await stepAgent($, 'agent-21')
  const afterwards = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await afterwards.find({ type: 'Text', text: /needs you/ }))?.text).toBe('1 ticket needs you')
  await afterwards.unmount()
  await endAgentTurn($, 'agent-21')
  await endAgentTurn($, 'agent-22')
})

const MAIN_TURN = 'main-1'

const stepMainTurn = async ($: Engine): Promise<void> => {
  const stream = $.turn.step({ turnId: MAIN_TURN, index: 0, model: 'opus', messageCount: 1 })
  while (!(await stream.next()).done);
}

const paneTexts = async ($: Engine): Promise<string[]> => {
  const ui = await $.ui.mount({ ...PANE_AT_80, surface: 'terminal' })
  const texts = (await ui.findAll({ type: 'Text' })).map(element => element.text)
  await ui.unmount()

  return texts
}

// What waits on the person comes first, so the rows of Now are read from its label down.
const textsFromNow = async ($: Engine): Promise<string[]> => {
  const texts = await paneTexts($)

  return texts.slice(Math.max(0, texts.indexOf('NOW')))
}

test('Now shows the session working on its own, a running agent, and an agent that just returned, each as a row', async ($, on) => {
  on('tool.call', { tool: 'Grep' }, () => ({ result: 'No matches found' }))
  const standIn = standInForEngine(on, seededBoard())
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-5' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await startSession($)
  const leftBehind = await textsFromNow($)
  expect(leftBehind.slice(0, 2)).toEqual(['NOW', '┃ '])
  expect(leftBehind[2]).toMatch(/^SQ-2 Trace upload .*stopped, nothing runs it$/)

  await $.turn.start({ text: 'Add a line to the readme.', turnId: MAIN_TURN })
  await stepMainTurn($)
  await stepMainTurn($)
  const working = await textsFromNow($)
  expect(working.slice(0, 3)).toEqual(['NOW', '┃ ', `This session  thinking, since ${clockTime(NOW)}`])
  expect(working).not.toContain(NOTHING_IS_RUNNING)

  await $.agent.spawn(spawnInput({ subagentType: 'sidequest:worker', prompt: 'Ticket SQ-2: Trace upload flow', description: 'Trace the upload flow' }))
  const running = await textsFromNow($)
  expect(running.slice(0, 3)).toEqual(['NOW', '┃ ', 'SQ-2 Trace upload flow  sonnet, 1h 2m'])
  expect(running.filter(text => /This session|started earlier, nothing runs it now/.test(text))).toEqual([])

  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: MAIN_TURN, reason: 'answer' })
  await $.turn.complete({ answer: '', durationMs: 80_000, isAborted: false, turnId: 't', agentId: 'agent-5', reason: 'answer' })
  const returned = await textsFromNow($)
  expect(returned[2]).toMatch(/^Just finished: SQ-2 Trace the upload flow  took \S+/)
  expect(returned).not.toContain('SQ-2 Trace upload flow  sonnet, 1h 2m')

  await $.turn.start({ text: '', turnId: 'main-2' })
  const wokenTurn = await textsFromNow($)
  expect(wokenTurn[2]).toBe(`This session  thinking, since ${clockTime(NOW)}`)
  expect(wokenTurn.filter(text => text.startsWith('Just finished'))).toHaveLength(1)

  const readsBeforeTheBurst = standIn.clockReads
  for (let call = 0; call < 5; call += 1) await $.tool.call({ tool: 'Grep', pattern: 'listActive' })
  const searching = await textsFromNow($)
  const readsAfterTheBurst = standIn.clockReads
  await textsFromNow($)
  const readsOfOneDrawing = standIn.clockReads - readsAfterTheBurst
  expect(readsAfterTheBurst - readsBeforeTheBurst - readsOfOneDrawing).toBe(1)
  expect(searching[2]).toBe(`This session  searching the code, since ${clockTime(NOW)}`)

  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'main-2', reason: 'answer' })
  await $.turn.start({ text: 'Thanks.', turnId: 'main-3' })
  expect((await textsFromNow($)).filter(text => text.startsWith('Just finished'))).toEqual([])
})

const LOOKUP_PROMPT = '[route:explore] Find where uploads are retried. Say which file holds the backoff. Then list every caller.'
const LOOKUP_REPORT = ['The retry lives in `upload.ts`.', '', '| file | line |', '| --- | --- |', '| upload.ts | 40 |'].join('\n')

const passMainTurns = async ($: Engine, count: number): Promise<void> => {
  for (let turn = 1; turn <= count; turn += 1) {
    await $.turn.start({ text: 'Next.', turnId: `main-${turn}` })
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: `main-${turn}`, reason: 'answer' })
  }
}

test('a lookup that finished stays a pressable row after later turns and opens on what it was asked, its model and time, and what it reported', async ($, on) => {
  const standIn = standInForEngine(on, seededBoard())
  const agentIds = ['agent-31', 'agent-32']
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: agentIds.shift() ?? 'agent-none' }))
  let listed = [{ id: 'agent-31', description: 'Find the retry code', type: 'sidequest:scout', status: 'completed' as const }]
  on('agent.list', () => ({ value: listed }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await startSession($)
  await $.agent.spawn(spawnInput({ subagentType: 'sidequest:scout', prompt: LOOKUP_PROMPT, description: 'Find the retry code' }))
  await $.agent.spawn(spawnInput({ subagentType: 'sidequest:worker', prompt: 'Ticket SQ-2: Trace upload flow', description: 'Trace the upload flow' }))
  await $.turn.complete({ answer: LOOKUP_REPORT, durationMs: 32_000, isAborted: false, turnId: 't1', agentId: 'agent-31', reason: 'answer' })
  await $.turn.complete({ answer: 'result: Traced it.', durationMs: 60_000, isAborted: false, turnId: 't2', agentId: 'agent-32', reason: 'answer' })
  await passMainTurns($, 3)

  const ui = await $.ui.mount({ ...PANE_AT_80, surface: 'terminal' })
  expect((await ui.find({ type: 'Button', key: 'finished-agent-31' }))?.text).toBe('Find the retry code  sonnet, took 32s')
  await ui.press({ key: 'finished-agent-31' })
  const opened = (await ui.findAll({ type: 'Text' })).map(element => element.text)
  expect(opened.slice(0, 3)).toEqual(['Find the retry code', 'On sonnet, low effort, took 32s', 'Asked: Find where uploads are retried. Say which file holds the backoff.'])
  expect(opened.join('\n')).not.toMatch(/route|explore|scout/)
  expect((await ui.find({ type: 'Markdown' }))?.text).toBe('The retry lives in `upload.ts`.\n\n- upload.ts: line 40')
  await ui.press({ key: 'view-agent-31' })
  expect(standIn.viewedAgents).toEqual(['agent-31'])
  await ui.unmount()

  listed = []
  const afterTheHostDroppedIt = await $.ui.mount({ ...PANE_AT_80, surface: 'terminal' })
  expect(await afterTheHostDroppedIt.find({ type: 'Button', key: 'view-agent-31' })).toBeUndefined()
  expect((await afterTheHostDroppedIt.findAll({ type: 'Text' })).map(element => element.text)).toContain('The full transcript is no longer available.')
  await afterTheHostDroppedIt.unmount()

  const onTheDesktop = await $.ui.mount({ ...PANE_AT_80, surface: 'desktop' })
  expect(await onTheDesktop.find({ type: 'Button', key: 'view-agent-31' })).toBeUndefined()
  expect((await onTheDesktop.findAll({ type: 'Text' })).map(element => element.text)).not.toContain('The full transcript is no longer available.')
  await onTheDesktop.press({ key: 'back-from-finished-agent' })
  await onTheDesktop.press({ key: 'finished-agent-32' })
  expect((await onTheDesktop.findAll({ type: 'Text' })).map(element => element.text)).toContain('Trace upload flow')
  expect(await onTheDesktop.find({ type: 'Button', key: 'back' })).toBeDefined()
  await onTheDesktop.unmount()
})

test('past three finished agents the older ones wait behind one row that opens them', async ($, on) => {
  standInForEngine(on, seededBoard())
  let spawned = 0
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: `agent-4${(spawned += 1)}` }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await startSession($)
  for (let number = 1; number <= 5; number += 1) {
    await $.agent.spawn(spawnInput({ subagentType: 'Explore', prompt: `Look at part ${number}.`, description: `Look at part ${number}` }))
    await $.turn.complete({ answer: `Part ${number} is fine.`, durationMs: 1000, isAborted: false, turnId: 't', agentId: `agent-4${number}`, reason: 'answer' })
  }
  await passMainTurns($, 2)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const buttons = (await ui.findAll({ type: 'Button' })).map(button => button.key)
  expect(buttons.filter(key => String(key).startsWith('finished-'))).toEqual(['finished-agent-45', 'finished-agent-44', 'finished-agent-43'])
  expect((await ui.find({ type: 'Button', key: 'more-finished' }))?.text).toBe('2 more finished')
  await ui.press({ key: 'more-finished' })
  expect((await ui.findAll({ type: 'Button' })).map(button => button.key).filter(key => String(key).startsWith('finished-'))).toEqual([
    'finished-agent-42',
    'finished-agent-41',
  ])
  await ui.press({ key: 'finished-agent-41' })
  expect((await ui.find({ type: 'Markdown' }))?.text).toBe('Part 1 is fine.')
  await ui.unmount()
})

const finishedLookup = (number: number, mainTurnsSince: number): FinishedAgent => ({
  agentId: `agent-${number}`,
  what: `Lookup ${number}`,
  asked: 'Look.',
  model: 'haiku',
  durationMs: 1000,
  report: '',
  mainTurnsSince,
})

test('an agent that just finished stays under Now and is left out of the finished agents below until the next turn', () => {
  const content = { ...quietContent([]), finishedAgents: [finishedLookup(1, 2), finishedLookup(2, 1)] }

  const lines = boardPaneLines(content)

  expect(rowTexts(lines)).toEqual(['Just finished: Lookup 2', 'Lookup 1'])
  expect(lines.flatMap(line => (line.kind === 'row' ? [line.press] : []))).toEqual([
    { opens: 'finished-agent', id: 'agent-2' },
    { opens: 'finished-agent', id: 'agent-1' },
  ])
  expect(moreFinishedLines(content)).toEqual([])
})

test('a running row is plain words on every surface, with no progress element to stack or clip', EVERY_SURFACE, async ($, on) => {
  standInForEngine(on, seededBoard())
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-6' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await startSession($)
  await $.agent.spawn(spawnInput({ subagentType: 'Explore', prompt: '[route:explore] Look.', description: 'Look around' }))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Progress' })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /^Look around/ }))?.text).toBe('Look around  sonnet')
    await ui.unmount()
  }
  await endAgentTurn($, 'agent-6')
})

test('a narrow band keeps only what waits on the person and what runs, and never wraps', async ($, on) => {
  const summary = { needsYou: 1, ready: 2, doing: 1, review: 1 }
  const opusAgent = { model: 'claude-opus-5-5', description: 'look' }
  const activity = { agents: { 'agent-1': opusAgent }, runs: {}, doingTickets: ['SQ-2'], returnedTickets: [], waits: {} }

  expect(bandLine(summary, activity, 140)).toEqual({
    warnings: '1 ticket needs you',
    counts: '2 tickets ready to start, 1 stopped, 1 being checked  1 agent running on opus',
  })
  expect(bandLine(summary, activity, 90)).toEqual({ warnings: '1 ticket needs you', counts: '1 agent running on opus' })
  expect(bandLine(summary, activity, 40)).toEqual({ warnings: '1 needs you', counts: '1 agent running' })

  standInForEngine(on, seededBoard())
  standInForEngineDrawing(on)
  await startSession($)
  const band = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 40 } })
  const ownTexts = (await band.findAll({ type: 'Text' })).map(element => element.text).filter(text => text !== 'engine')
  expect(ownTexts).toEqual(['1 ticket needs you'])
  expect((await band.find({ type: 'Text', text: 'needs you' }))?.props.wrap).toBe('truncate-end')
  await band.unmount()
})

test('ticket work comes before lookups under Now, past three lookups the rest are counted, and no surface without a main view gets a View press', () => {
  const lookup = (number: number) => ({ agentId: `agent-lookup-${number}`, what: `Lookup ${number}`, model: 'haiku', canBeViewed: true })
  const ticketWork = { agentId: 'agent-ticket', what: 'Build the retry', ticket: 'SQ-1', model: 'sonnet', canBeViewed: true }
  const running = [lookup(1), lookup(2), ticketWork, lookup(3), lookup(4)]

  const onTheTerminal = boardPaneLines({ ...quietContent([]), running, hasMainView: true })
  const onTheDesktop = boardPaneLines({ ...quietContent([]), running, hasMainView: false })

  expect(rowTexts(onTheTerminal)).toEqual(['SQ-1 Build the retry', 'Lookup 1', 'Lookup 2', 'and 2 more lookups running'])
  expect(onTheTerminal.flatMap(line => (line.kind === 'row' ? [line.press.opens] : []))).toEqual(['agent', 'agent', 'agent', 'nothing'])
  expect(onTheDesktop.flatMap(line => (line.kind === 'row' ? [line.press.opens] : []))).toEqual(['nothing', 'nothing', 'nothing', 'nothing'])
})

const parkedOnDisk = (files: Map<string, string>): void => {
  files.set(`${TICKETS}/SQ-3.md`, ticketFile('SQ-3', 'Pick a backoff', 'parked'))
}

const bandNeedsYou = async ($: Engine): Promise<string | undefined> => {
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const text = (await band.find({ type: 'Text', text: /needs you/ }))?.text
  await band.unmount()

  return text
}

test('opening the pane after a hand edit brings the band to the same board', async ($, on) => {
  const files = seededBoard()
  standInForEngine(on, files)
  standInForEngineDrawing(on)
  await startSession($)
  expect(await bandNeedsYou($)).toBe('1 ticket needs you')

  parkedOnDisk(files)
  expect(await bandNeedsYou($)).toBe('1 ticket needs you')
  await runBoardCommand($)

  expect(await bandNeedsYou($)).toBeUndefined()
  expect((await paneTexts($)).join('\n')).toContain('1 set aside')
})

test('a read of the board by the session brings the band to the same board with no pane opened', async ($, on) => {
  const files = seededBoard()
  standInForEngine(on, files)
  standInForEngineDrawing(on)
  await startSession($)

  parkedOnDisk(files)
  await $.tool.call({ tool: 'mcp__sidequest__board', view: 'all' })

  expect(await bandNeedsYou($)).toBeUndefined()
})

test('a board read that comes back with no tickets leaves the pane and the band as they were', async ($, on) => {
  const files = seededBoard()
  standInForEngine(on, files)
  standInForEngineDrawing(on)
  await startSession($)
  const paneBefore = await paneTexts($)

  files.clear()
  await $.tool.call({ tool: 'mcp__sidequest__board', view: 'all' })

  expect(await bandNeedsYou($)).toBe('1 ticket needs you')
  expect(await paneTexts($)).toEqual(paneBefore)
  expect(paneBefore.join('\n')).toContain('Pick a backoff')
})

test('with no action in the session the band stays as it was', async ($, on) => {
  const files = seededBoard()
  standInForEngine(on, files)
  standInForEngineDrawing(on)
  await startSession($)

  parkedOnDisk(files)

  expect(await bandNeedsYou($)).toBe('1 ticket needs you')
})

test('any ticket and the plan take one field to say something, which reaches the session as the person and is kept on file', async ($, on) => {
  const files = seededBoard()
  files.set(`${STORIES}/ST-1.md`, storyFile('ST-1', 'Tags on items', 'Asked: tags.'))
  const standIn = standInForEngine(on, files)
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'SQ-1' })
  expect((await ui.findAll({ type: 'Input' })).map(input => input.key)).toEqual(['say'])
  expect(await ui.find({ type: 'Text', text: 'Same as typing in the chat, with this ticket named.' })).toBeDefined()
  await ui.input({ key: 'say', text: 'Yes, doc AI only,\ndo not touch the Laravel', kind: 'change' })
  await ui.press({ key: 'send-remark' })
  await ui.press({ key: 'back' })
  await ui.press({ key: 'SQ-3' })
  expect((await ui.findAll({ type: 'Input' })).map(input => input.key)).toEqual(['answer'])
  await ui.press({ key: 'back' })
  await ui.press({ key: 'story-ST-1' })
  await ui.input({ key: 'say-about-story', text: 'Keep tags short.', kind: 'change' })
  await ui.press({ key: 'send-story-remark' })
  await ui.unmount()

  expect(standIn.submitted).toEqual([
    'About SQ-1 (Retry failed uploads), from the board: "Yes, doc AI only, do not touch the Laravel"',
    'About ST-1 (Tags on items), from the board: "Keep tags short."',
  ])
  expect(files.get(`${TICKETS}/SQ-1.md`)).toContain('- 2026-11-16T10:02Z said by human in the board: Yes, doc AI only, do not touch the Laravel')
  expect(files.get(`${TICKETS}/SQ-1.md`)).toContain('status: ready')
  expect(files.get(`${STORIES}/ST-1.md`)).toContain('## Log\n- 2026-11-16T10:02Z said by human in the board: Keep tags short.')
})

test('what the person says about a ticket whose agent is running goes to that agent and is kept on the ticket', async ($, on) => {
  const files = seededBoard()
  const standIn = standInForEngine(on, files)
  const sent: { to: string; text: string }[] = []
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-7' }))
  on('agent.list', () => ({ value: [{ id: 'agent-7', description: 'SQ-1 Retry', type: 'sidequest:worker', status: 'running' }] }))
  on('session.send', (_, e) => {
    sent.push({ to: e.to, text: e.text })

    return { isDelivered: true }
  })
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'SQ-1' })
  await $.agent.spawn(spawnInput({ subagentType: 'sidequest:worker', prompt: 'Ticket SQ-1: Retry failed uploads', description: 'SQ-1 Retry' }))

  await ui.input({ key: 'say', text: 'Keep the old retry count', kind: 'change' })
  await ui.press({ key: 'send-remark' })
  expect(await ui.find({ type: 'Text', text: 'Sent to the agent building it, and kept on file: "Keep the old retry count"' })).toBeDefined()
  await ui.unmount()

  expect(sent.map(message => message.text)).toEqual(['The person, on the board, about SQ-1 (Retry failed uploads) that you are working on: "Keep the old retry count"'])
  expect(sent[0]?.to).toContain('agent-7')
  expect(standIn.submitted).toEqual([])
  expect(standIn.toasts).toContain('Sent to the agent building it, and kept on the ticket.')
  expect(files.get(`${TICKETS}/SQ-1.md`)).toContain('said by human in the board, sent to its running agent: Keep the old retry count')
})

test('one ticket holding two things another waits for is named once, and the aside shows whole in a 60-column pane', () => {
  const config = mergeBoardConfig({ settings: { worktrees: false, shared: { stack: { what: 'the local app', refresh: 'auto' } } } })
  const holding = newTicket('SQ-1', { title: 'Check the login', status: 'doing', uses: ['stack'] }, '2026-11-16T09:56Z')
  const waiting = newTicket('SQ-2', { title: 'Fix the session timeout', uses: ['stack'] }, '2026-11-16T09:56Z')
  const lines = boardPaneLines(quietContent(boardCards([holding, waiting], config)))
  const row = lines.find(line => line.kind === 'row' && line.text.startsWith('SQ-2'))

  expect(waitsForWords(heldThingsFor(waiting, [holding, waiting], config))).toBe('waits for the stack and the main project folder, SQ-1 is using both')
  expect(row?.kind === 'row' && row.aside).toBe('waits on SQ-1 (stack, project folder)')
  expect(row?.kind === 'row' && fittedRow(row, 60 - '┃ '.length).aside).toBe('waits on SQ-1 (stack, project folder)')
})

const PROPOSED_TICKETS = [
  {
    op: 'create',
    title: 'Retry in the upload',
    what: 'A failed upload is sent again twice.\n\nApproach: `uploadWithRetry(file)` wraps the send.',
    doneWhen: '- [ ] a failed upload is retried twice',
    story: 'ST-1',
  },
  { op: 'create', title: 'Report after the retries', what: 'The person sees one report after the last try.', doneWhen: '- [ ] one report after the last try', story: 'ST-1' },
]

const PLAYBACK_POINTER =
  'The plan and its 2 proposed tickets are on the board (/board opens it). Press "Yes, build it" there, or type yes; a correction works the same in either place.'

type ToolCallResultLike = { result?: unknown; deny?: string }

const replyText = (written: ToolCallResultLike): string => (typeof written.result === 'string' ? written.result : (written.deny ?? ''))

const filePlayback = async ($: Engine): Promise<string> => {
  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'story', title: 'Uploads', destination: 'Uploads retry.', analysis: 'Asked: retry.' }] })

  return replyText(await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'patch', id: 'ST-1', awaitsYes: true }, ...PROPOSED_TICKETS] }))
}

const boardView = async ($: Engine, view: string): Promise<string> => replyText(await $.tool.call({ tool: 'mcp__sidequest__board', view }))

test('a ticket whose plan waits for its yes is refused by start with the reason, and left out of the frontier, the summary, now and planning', async ($, on) => {
  standInForEngine(on, seededBoard())
  await startSession($)
  await filePlayback($)

  expect(replyText(await $.tool.call({ tool: 'mcp__sidequest__start', id: 'SQ-4' }))).toContain("SQ-4 was not started: its plan still waits for the person's yes.")
  expect(await boardView($, 'frontier')).not.toMatch(/SQ-[45]/)
  const summary = await boardView($, 'summary')
  expect(summary).toContain('Ready to start: SQ-1.')
  expect(summary).toContain('Proposed, waiting for the yes on their plan, so not open work yet: SQ-4, SQ-5.')
  expect(await boardView($, 'now')).not.toMatch(/SQ-[45]/)
  const planning = await boardView($, 'planning')
  expect(planning.slice(planning.indexOf('open tickets:'), planning.indexOf('Proposed'))).not.toMatch(/SQ-[45]/)
  expect(await boardView($, 'list')).toContain('SQ-4 ready build Retry in the upload (proposed, waiting for the yes on its plan)')

  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'patch', id: 'ST-1', awaitsYes: false }] })
  expect(await boardView($, 'frontier')).toMatch(/SQ-4 ready build Retry in the upload\nSQ-5 /)
  expect(replyText(await $.tool.call({ tool: 'mcp__sidequest__start', id: 'SQ-4' }))).not.toContain('its plan still waits')
})

test("start refuses a proposed ticket also when the person's yes came and the mark was never cleared, and says how", async ($, on) => {
  standInForEngine(on, seededBoard())
  await startSession($)
  await filePlayback($)

  expect(replyText(await $.tool.call({ tool: 'mcp__sidequest__start', id: 'SQ-5' }))).toContain('If they said yes, patch ST-1 with awaitsYes false, then start.')
})

test('proposed tickets are neither counted in the band nor listed under Next, and come in once the yes clears the mark', async ($, on) => {
  standInForEngine(on, seededBoard())
  await startSession($)
  await filePlayback($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'back-from-story' })

  expect(await ui.find({ type: 'Button', key: 'SQ-4' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'SQ-1' })).toBeDefined()
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /ready/ }))?.text).toBe('1 ticket ready to start, 1 stopped')
  await band.unmount()

  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'patch', id: 'ST-1', awaitsYes: false }] })
  expect(await ui.find({ type: 'Button', key: 'SQ-4' })).toBeDefined()
  const after = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await after.find({ type: 'Text', text: /ready/ }))?.text).toBe('3 tickets ready to start, 1 stopped')
  await after.unmount()
  await ui.unmount()
})

test('the plan view shows the proposed tickets as blocks with Yes, build it and a field for a correction, and the yes goes out as the person', async ($, on) => {
  const files = seededBoard()
  const standIn = standInForEngine(on, files)
  await startSession($)
  await filePlayback($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: 'Proposed tickets' }))?.text).toBe('Proposed tickets')
  expect(await ui.find({ key: 'proposed-SQ-4' })).toBeDefined()
  expect((await ui.find({ type: 'Markdown', key: 'proposed-SQ-4-what' }))?.text).toBe('A failed upload is sent again twice.\n\nApproach: `uploadWithRetry(file)` wraps the send.')
  expect((await ui.find({ type: 'Markdown', key: 'proposed-SQ-5-done-when' }))?.text).toBe('Done when:\n- [ ] one report after the last try')
  const keys = (await ui.findAll({})).map(element => element.key)
  expect(keys.indexOf('correction-words')).toBeLessThan(keys.indexOf('yes-build-it'))
  expect(keys.indexOf('yes-build-it')).toBeLessThan(keys.indexOf('proposed-SQ-4'))
  expect(keys.indexOf('proposed-SQ-5')).toBeLessThan(keys.indexOf('analysis'))

  await ui.press({ key: 'yes-build-it' })
  expect(standIn.submitted).toEqual(['Yes, build it: my yes on ST-1 (Uploads) and its 2 proposed tickets, from the board.'])
  expect(files.get(`${STORIES}/ST-1.md`)).toContain('yes, build it, said by human in the board')

  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'patch', id: 'ST-1', awaitsYes: false }] })
  expect(await boardView($, 'frontier')).toContain('SQ-4 ready build Retry in the upload')
  expect(await ui.find({ type: 'Text', text: 'Proposed tickets' })).toBeUndefined()
  await ui.unmount()
})

test('a question asked along with the playback does not hide the proposed tickets or the yes', async ($, on) => {
  standInForEngine(on, seededBoard())
  await startSession($)
  await filePlayback($)
  const stillOpen = { question: 'Move the tracker issue when the build starts?', recommended: 'Yes', otherCosts: 'Leave it: nobody sees it is being worked on.' }
  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'patch', id: 'ST-1', questions: [stillOpen] }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: 'Proposed tickets' }))?.text).toBe('Proposed tickets')
  expect(await ui.find({ key: 'yes-build-it' })).toBeDefined()
  const keys = (await ui.findAll({})).map(element => element.key)
  expect(keys.indexOf('decisions-for-you')).toBeGreaterThan(-1)
  expect(keys.indexOf('decisions-for-you')).toBeLessThan(keys.indexOf('proposed-SQ-4'))
  expect(keys).not.toContain('correction-words')
  expect(keys.indexOf('decisions-for-you')).toBeLessThan(keys.indexOf('yes-build-it'))
  await ui.unmount()
})

type MeasuredRows = { rows: number; rowOfKey?: number }

// Below the element `find` returns, children come as the tree was drawn: a tag, its props and its children.
type DrawnNode = { type: string; props?: Record<string, unknown>; children?: unknown[] }

const isDrawnNode = (child: unknown): child is DrawnNode => typeof child === 'object' && child !== null && 'type' in child

const propOf = (node: DrawnNode, name: string): unknown => node.props?.[name]

const textProp = (node: DrawnNode, name: string): string => {
  const value = propOf(node, name)

  return typeof value === 'string' ? value : ''
}

const childText = (node: DrawnNode): string => (node.children ?? []).map(child => (typeof child === 'string' ? child : isDrawnNode(child) ? childText(child) : '')).join('')

const wrappedRows = (text: string, columns: number): number =>
  text.split('\n').reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / Math.max(1, columns))), 0)

// The host draws a labelled field as its label over a bordered line.
const INPUT_ROWS = 3

const LEAF_ROWS: Record<string, (node: DrawnNode, columns: number) => number> = {
  Text: (node, columns) => (propOf(node, 'wrap') === 'truncate-end' ? childText(node).split('\n').length : wrappedRows(childText(node), columns)),
  Markdown: (node, columns) => wrappedRows(textProp(node, 'text'), columns),
  Code: node => textProp(node, 'source').split('\n').length,
  Button: () => 1,
  Input: () => INPUT_ROWS,
}

const numberProp = (node: DrawnNode, name: string): number => {
  const value = propOf(node, name)

  return typeof value === 'number' ? value : 0
}

const boxRows = (box: DrawnNode, columns: number, key: string): MeasuredRows => {
  const border = propOf(box, 'borderStyle') === undefined ? 0 : 1
  const inner = columns - 2 * border - 2 * numberProp(box, 'paddingX')
  const children = (box.children ?? []).filter(isDrawnNode).map(child => measuredRows(child, inner, key))
  if (propOf(box, 'flexDirection') === 'row') {
    const found = children.flatMap(child => (child.rowOfKey === undefined ? [] : [child.rowOfKey]))

    return { rows: Math.max(1, ...children.map(child => child.rows)) + 2 * border, ...(found.length > 0 ? { rowOfKey: border + Math.min(...found) } : {}) }
  }
  let offset = border
  let rowOfKey: number | undefined
  children.forEach((child, index) => {
    if (index > 0) offset += numberProp(box, 'gap')
    if (rowOfKey === undefined && child.rowOfKey !== undefined) rowOfKey = offset + child.rowOfKey
    offset += child.rows
  })

  return { rows: offset + border, ...(rowOfKey === undefined ? {} : { rowOfKey }) }
}

// No surface in the kit reports rows, so they are counted from the tree the way the terminal lays it out: near enough
// to say whether a control sits on the first screen.
const measuredRows = (node: DrawnNode, columns: number, key: string): MeasuredRows => {
  const measured = node.type === 'Box' ? boxRows(node, columns, key) : { rows: (LEAF_ROWS[node.type] ?? (() => 1))(node, columns) }

  return propOf(node, 'key') === key ? { ...measured, rowOfKey: 0 } : measured
}

const FIRST_SCREEN_ROWS = 45

const rowOfKeyAt80 = async (ui: { find: (query: { key?: string }) => Promise<FoundElement | undefined> }, key: string): Promise<number | undefined> => {
  const root = await ui.find({})

  return root === undefined ? undefined : measuredRows(root, PANE_AT_80.props.bodyColumns, key).rowOfKey
}

const LONG_ANALYSIS = Array.from({ length: 60 }, (_, index) => `- finding ${index + 1}: the upload path does one more thing here`).join('\n')

// The shape a real session wrote: the destination in three paragraphs, six defaults with long answers, one decision
// still open.
const THREE_PARAGRAPH_DESTINATION = [
  'A failed upload is sent again twice before the person sees one report, and nothing else about uploads changes.',
  `**Proof on the real thing:** ${'run the upload against the flaky test server, cut the connection mid-send, and see the second try land. '.repeat(4)}`,
  '**Where it ends:** a pull request to main, opened once the review passes, with the diagram of the path in its description.',
].join('\n\n')

const LONG_ANSWER = 'kept exactly as the code does it today, with the same names, the same errors and the same logging, so nothing a caller sees moves'

const DECISIONS_AT_THE_PLAYBACK = [
  { question: 'How many retries?', answer: 'Two', decidedBy: 'human' },
  ...Array.from({ length: 6 }, (_, index) => ({ question: `Default question ${index + 1}?`, answer: `Answer ${index + 1}: ${LONG_ANSWER}. Undo: say so.`, decidedBy: 'default' })),
]

const OPEN_AT_THE_PLAYBACK = { question: 'Move the tracker issue when the build starts?', recommended: 'Yes', otherCosts: 'Leave it: nobody sees it is being worked on.' }

const filePlaybackWithDecisions = async ($: Engine): Promise<void> => {
  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'story', title: 'Uploads', destination: THREE_PARAGRAPH_DESTINATION, analysis: LONG_ANALYSIS }] })
  await $.tool.call({
    tool: 'mcp__sidequest__ticket',
    operations: [{ op: 'patch', id: 'ST-1', awaitsYes: true, decisions: DECISIONS_AT_THE_PLAYBACK, questions: [OPEN_AT_THE_PLAYBACK] }, ...PROPOSED_TICKETS],
  })
}

const childTexts = (element: FoundElement | undefined): string[] => (element?.children ?? []).filter(isDrawnNode).map(childText)

test('the playback leads with the destination, what was taken by default and the yes, on the first screen at 80 columns, and the tickets follow', async ($, on) => {
  standInForEngine(on, seededBoard())
  await startSession($)
  await filePlaybackWithDecisions($)
  const ui = await $.ui.mount({ ...PANE_AT_80, surface: 'terminal' })

  const drawn = await ui.findAll({})
  const keys = drawn.map(element => element.key)
  const destinationAt = drawn.findIndex(element => element.type === 'Text' && element.text === THREE_PARAGRAPH_DESTINATION.split('\n\n')[0])
  expect(destinationAt).toBeGreaterThan(-1)
  expect(destinationAt).toBeLessThan(keys.indexOf('taken-by-default'))
  expect(keys.indexOf('taken-by-default')).toBeLessThan(keys.indexOf('decisions-for-you'))
  expect(keys.indexOf('decisions-for-you')).toBeLessThan(keys.indexOf('yes-build-it'))
  expect(keys.indexOf('yes-build-it')).toBeLessThan(keys.indexOf('destination-rest'))
  expect(keys.indexOf('destination-rest')).toBeLessThan(keys.indexOf('proposed-SQ-4'))
  expect(keys.indexOf('proposed-SQ-5')).toBeLessThan(keys.indexOf('already-decided'))
  expect(keys.indexOf('already-decided')).toBeLessThan(keys.indexOf('analysis'))
  expect((await ui.find({ key: 'destination-rest' }))?.text).toMatch(/^\*\*Proof on the real thing:\*\*[\s\S]*\*\*Where it ends:\*\*/)
  const takenByDefault = childTexts(await ui.find({ key: 'taken-by-default' }))
  expect(takenByDefault).toHaveLength(8)
  expect(takenByDefault[0]).toBe('Taken by default')
  expect(takenByDefault[1]).toBe(`${`Default question 1? Answer 1: ${LONG_ANSWER}`.slice(0, 75)}...`)
  expect(takenByDefault.slice(1, 7).every(line => line.length <= PANE_AT_80.props.bodyColumns && !line.includes('D-') && !line.includes('Undo'))).toBe(true)
  expect(takenByDefault[7]).toBe('The full text of each is below.')
  const decided = (await ui.find({ key: 'already-decided' }))?.text ?? ''
  expect(decided).toContain('- D-1: How many retries? Answer: Two Decided by: you')
  expect(decided).toContain(`- D-7: Default question 6? Answer: Answer 6: ${LONG_ANSWER}. Undo: say so. Taken by default`)
  expect(decided).not.toMatch(/Decided by: (human|default)/)
  expect(await rowOfKeyAt80(ui, 'yes-build-it')).toBeLessThan(FIRST_SCREEN_ROWS)
  expect(await rowOfKeyAt80(ui, 'back-from-story')).toBeGreaterThan(FIRST_SCREEN_ROWS)
  await ui.unmount()
})

test('a correction typed in the plan view goes out as the person, and the board marks the ticket it changed', async ($, on) => {
  const standIn = standInForEngine(on, seededBoard())
  await startSession($)
  await filePlayback($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.input({ key: 'correction-words', text: 'three retries, not two' })
  expect(standIn.submitted).toEqual([])
  expect((await ui.find({ type: 'Input', key: 'correction-words' }))?.props.value).toBe('three retries, not two')
  await ui.press({ key: 'send-correction' })
  expect(standIn.submitted).toEqual(['About ST-1 (Uploads), from the board: "three retries, not two"'])
  expect(await ui.find({ type: 'Input', key: 'correction-words' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'You sent: three retries, not two' })).toBeDefined()

  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'patch', id: 'SQ-4', doneWhen: '- [ ] a failed upload is retried three times' }] })
  expect((await ui.find({ type: 'Text', text: /^Retry in the upload/ }))?.text).toBe('Retry in the upload (changed)')
  expect((await ui.find({ type: 'Text', text: /^Report after the retries/ }))?.text).toBe('Report after the retries')
  await ui.unmount()
})

test('a typed stop parks the proposed tickets with their story and clears the wait for the yes', async ($, on) => {
  const files = seededBoard()
  standInForEngine(on, files)
  await startSession($)
  await filePlayback($)

  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'stop', story: 'ST-1' }] })

  expect(files.get(`${TICKETS}/SQ-4.md`)).toContain('status: parked')
  expect(files.get(`${TICKETS}/SQ-5.md`)).toContain('status: parked')
  expect(files.get(`${STORIES}/ST-1.md`)).not.toContain('awaitsYes')
  expect(await boardView($, 'frontier')).not.toMatch(/SQ-[45]/)
})

test('with the board placed the playback reply ends with a pointer of three lines at most, and the plan opens without the keyboard', async ($, on) => {
  const standIn = standInForEngine(on, seededBoard())
  await startSession($)

  const reply = await filePlayback($)

  expect(reply.endsWith(`Say only this in the chat, three lines at most:\n\n${PLAYBACK_POINTER}`)).toBe(true)
  expect(reply).not.toContain('Approach:')
  expect(standIn.focusAskedFor.every(focus => focus === undefined)).toBe(true)
})

test('with no pane the playback reply hands over the ticket blocks as filed, for the whole playback in the chat', async ($, on) => {
  standInForEngine(on, seededBoard(), false)
  await startSession($)

  const reply = await filePlayback($)
  const ending = reply.slice(reply.indexOf('No board pane is placed'))

  expect(ending).toBe(
    [
      'No board pane is placed, so write the playback in the chat as the plan page lays it out, with these ticket blocks as they are:',
      '1. Retry in the upload',
      'A failed upload is sent again twice.',
      'Approach: `uploadWithRetry(file)` wraps the send.',
      'Done when:\n- [ ] a failed upload is retried twice',
      '2. Report after the retries',
      'The person sees one report after the last try.',
      'Done when:\n- [ ] one report after the last try',
    ].join('\n\n'),
  )
  expect(reply).not.toContain(PLAYBACK_POINTER)
})

const AFTER_THE_PROOF = {
  changed: '- uploads: a failed send is retried twice\n- report: one line after the last try\n\nThe whole diff: `git diff main...fix/retries`',
  checked: '`npm test`: 41 pass, exit 0',
  hunks: '```diff\n@@ -10,3 +10,3 @@\n export async function upload(file) {\n-  return send(file)\n+  return uploadWithRetry(file)\n }\n```',
}

const AFTER_THE_REVIEW = {
  reviewFound: 'Nothing that changes what you read.',
  commitMessage: 'Retry failed uploads twice\n\nA failed send is sent again twice before the person sees a report.',
  pullRequestTitle: 'Retry failed uploads twice',
  pullRequestDescription: '## What changed\n\nA failed upload is retried twice.',
}

const COMMIT_QUESTION = {
  question: 'Commit, push and open the pull request?',
  whyNow: 'The change is built, checked and reviewed.',
  options: ['Yes: it goes out as shown Costs: nothing', 'Not yet: it stays on its branch Costs: the fix waits'],
  recommended: 'A',
  ifUnanswered: 'It stays on its branch.',
}

const fillAfterTheProof = async ($: Engine): Promise<string> =>
  replyText(await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'patch', id: 'SQ-1', status: 'review', forYou: { sayingYesTo: AFTER_THE_PROOF } }] }))

const fillAfterTheReview = async ($: Engine): Promise<string> => {
  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'note', id: 'SQ-1', text: 'review pass: retries as asked' }] })

  return replyText(
    await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'patch', id: 'SQ-1', status: 'needs-you', forYou: { ...COMMIT_QUESTION, sayingYesTo: AFTER_THE_REVIEW } }] }),
  )
}

test('once the proof has run, what changed, how it was checked and the hunks show in the ticket view, and the chat gets one line', async ($, on) => {
  const standIn = standInForEngine(on, seededBoard())
  await startSession($)

  const reply = await fillAfterTheProof($)

  expect(reply.endsWith('Say only this in the chat, one line:\n\nWhat changed, how it was checked and the hunks that carry the design are on the board (/board opens it). The review still runs.')).toBe(true)
  expect(standIn.focusAskedFor.every(focus => focus === undefined)).toBe(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Markdown', key: 'yes-to-changed-text' }))?.text).toBe(AFTER_THE_PROOF.changed)
  expect((await ui.find({ type: 'Code' }))?.props.format).toBe('diff')
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -10,3 +10,3 @@\n export async function upload(file) {\n-  return send(file)\n+  return uploadWithRetry(file)\n }')
  expect((await ui.find({ type: 'Text', text: /^The review still runs/ }))?.text).toBe('The review still runs. What it finds, the words that go out and the question come here.')
  await ui.unmount()
})

test('when the review is back, what it found and the words that go out sit above the question with the first step kept, and the chat gets one line', async ($, on) => {
  const files = seededBoard()
  standInForEngine(on, files)
  await startSession($)
  await fillAfterTheProof($)

  const reply = await fillAfterTheReview($)

  expect(reply.endsWith('Say only this in the chat, one line:\n\nThe review passed: what it found, the words that go out and the question wait on the board (/board opens it). A letter typed here works too.')).toBe(true)
  expect(reply).not.toContain('Show the person this as it is')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const keys = (await ui.findAll({})).map(element => element.key)
  const order = ['yes-to-changed', 'yes-to-checked', 'yes-to-hunks', 'yes-to-reviewFound', 'yes-to-commitMessage', 'yes-to-pullRequestTitle', 'yes-to-pullRequestDescription']
  expect(order.map(key => keys.indexOf(key))).toEqual([...order.map(key => keys.indexOf(key))].sort((left, right) => left - right))
  expect(keys.indexOf('yes-to-changed')).toBeGreaterThan(-1)
  const drawn = await ui.findAll({})
  const questionAt = drawn.findIndex(element => element.type === 'Text' && element.text === 'Commit, push and open the pull request?')
  const headingAt = drawn.findIndex(element => element.type === 'Text' && element.text === 'What you are saying yes to')
  expect(keys.indexOf('commit-summary')).toBeLessThan(questionAt)
  expect(questionAt).toBeLessThan(keys.indexOf('option-A'))
  expect(keys.indexOf('send-answer')).toBeLessThan(headingAt)
  expect(headingAt).toBeLessThan(keys.indexOf('yes-to-changed'))
  const summary = drawn.slice(keys.indexOf('commit-summary') + 1, questionAt).map(element => element.text)
  expect(summary).toEqual(['The review passed.', '- uploads: a failed send is retried twice', '- report: one line after the last try'])
  expect((await ui.find({ type: 'Text', text: AFTER_THE_REVIEW.commitMessage }))?.text).toBe(AFTER_THE_REVIEW.commitMessage)
  expect(await ui.find({ type: 'Text', text: /^The review still runs/ })).toBeUndefined()
  expect(files.get(`${TICKETS}/SQ-1.md`)).toContain('Commit message:\n    Retry failed uploads twice\n\n    A failed send is sent again twice before the person sees a report.')
  await ui.unmount()
})

const LONG_HUNKS = `\`\`\`diff\n@@ -1,40 +1,40 @@\n${Array.from({ length: 40 }, (_, index) => `-  old line ${index}\n+  new line ${index}`).join('\n')}\n\`\`\``

test('with the review back the commit question and Send sit on the first screen at 80 columns, above a diff taller than it', async ($, on) => {
  standInForEngine(on, seededBoard())
  await startSession($)
  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'patch', id: 'SQ-1', status: 'review', forYou: { sayingYesTo: { ...AFTER_THE_PROOF, hunks: LONG_HUNKS } } }] })
  await fillAfterTheReview($)
  const ui = await $.ui.mount({ ...PANE_AT_80, surface: 'terminal' })

  expect(await rowOfKeyAt80(ui, 'send-answer')).toBeLessThan(FIRST_SCREEN_ROWS)
  expect(await rowOfKeyAt80(ui, 'yes-to-reviewFound')).toBeGreaterThan(FIRST_SCREEN_ROWS)
  await ui.unmount()
})

test('while the review still runs what is said yes to leads, also beside a question asked already', async ($, on) => {
  standInForEngine(on, seededBoard())
  await startSession($)
  await fillAfterTheProof($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  const running = (await ui.findAll({})).map(element => element.key)
  expect(running.indexOf('yes-to-hunks')).toBeLessThan(running.indexOf('say'))
  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'patch', id: 'SQ-1', status: 'needs-you', forYou: COMMIT_QUESTION }] })
  const drawn = await ui.findAll({})
  const keys = drawn.map(element => element.key)
  expect(keys.indexOf('yes-to-hunks')).toBeLessThan(drawn.findIndex(element => element.text === 'Commit, push and open the pull request?'))
  expect(keys).not.toContain('commit-summary')
  expect(drawn.some(element => element.text === 'What you are saying yes to')).toBe(false)
  await ui.unmount()
})

test('with no pane, each step of the commit question hands the chat the whole text, the question last', async ($, on) => {
  standInForEngine(on, seededBoard(), false)
  await startSession($)

  const proof = await fillAfterTheProof($)
  expect(proof.slice(proof.indexOf('No board pane is placed'))).toBe(
    [
      'No board pane is placed, so show the person this text in the chat as it is:',
      `What changed:\n${AFTER_THE_PROOF.changed}`,
      `How it was checked:\n${AFTER_THE_PROOF.checked}`,
      `The hunks that carry the design:\n${AFTER_THE_PROOF.hunks}`,
      'The review still runs.',
    ].join('\n\n'),
  )

  const review = await fillAfterTheReview($)
  const ending = review.slice(review.indexOf('No board pane is placed'))
  expect(ending.startsWith(`No board pane is placed, so show the person this text in the chat as it is:\n\nWhat the review found:\n${AFTER_THE_REVIEW.reviewFound}\n\nCommit message:\n${AFTER_THE_REVIEW.commitMessage}`)).toBe(true)
  expect(ending).toContain('Commit, push and open the pull request?\n   A. Yes: it goes out as shown.')
  expect(review.split('Commit, push and open the pull request?')).toHaveLength(2)
})

test('words that go out changed after the yes are logged on the ticket and named in the closing view', async ($, on) => {
  const files = seededBoard()
  standInForEngine(on, files)
  await startSession($)
  await fillAfterTheProof($)
  await fillAfterTheReview($)
  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'move', id: 'SQ-1', status: 'review' }] })

  const after = replyText(
    await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'patch', id: 'SQ-1', forYou: { sayingYesTo: { pullRequestTitle: 'Retry failed uploads three times' } } }] }),
  )

  expect(after).not.toContain('Say only this in the chat')
  expect(files.get(`${TICKETS}/SQ-1.md`)).toContain('words changed after the yes: pull request title from "Retry failed uploads twice" to "Retry failed uploads three times"')
  expect(await boardView($, 'closing')).toContain(
    'Changed after your yes on SQ-1 Retry failed uploads: pull request title from "Retry failed uploads twice" to "Retry failed uploads three times".',
  )
})

const RETRY_QUESTIONS = [
  { question: 'How many retries?', recommended: 'retries: 2', otherCosts: 'Three is slower.' },
  { question: 'Where does it live?', recommended: 'uploadWithRetry(file)', otherCosts: 'A wrapper at every call site.' },
]

const keysOf = async (ui: { findAll: (query: object) => Promise<{ key?: string }[]> }): Promise<(string | undefined)[]> => (await ui.findAll({})).map(element => element.key)

test('from the send of the plan answers on, nothing says the decisions wait on the person, until the session asks again', async ($, on) => {
  const files = seededBoard()
  standInForEngine(on, files)
  await startSession($)
  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'story', title: 'Uploads', destination: 'Uploads retry.', analysis: 'Asked: retry.', questions: RETRY_QUESTIONS }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'back-from-story' })
  expect((await ui.find({ type: 'Button', key: 'decisions-ST-1' }))?.text).toBe('2 decisions on the plan')

  await ui.press({ key: 'decisions-ST-1' })
  await ui.press({ key: 'decision-1-answer' })
  await ui.input({ key: 'decisions-words', text: 'keep the store dumb', kind: 'change' })
  await ui.press({ key: 'send-decisions' })

  const keys = await keysOf(ui)
  expect(keys).toContain('decision-answers-sent')
  expect(keys).not.toContain('send-decisions')
  expect(keys).not.toContain('decisions-words')
  expect(keys).not.toContain('decision-0-answer')
  expect((await ui.find({ type: 'Markdown', text: '1. How many retries?' }))?.text).toBe('1. How many retries?')
  const sentPicks = (await ui.findAll({ type: 'Text', text: /^Your answer: / })).map(element => element.text)
  expect(sentPicks).toEqual(['Your answer: the recommended one', 'Your answer: the other one'])
  expect(await ui.find({ type: 'Text', text: 'Your words: keep the store dumb' })).toBeDefined()
  await ui.press({ key: 'back-from-story' })
  expect(await ui.find({ type: 'Button', key: 'decisions-ST-1' })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'story-ST-1' }))?.text).toContain('your answers are with the session')
  expect(files.get(`${STORIES}/ST-1.md`)).toContain('decisionPicksSent: [recommended, other]')

  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'patch', id: 'ST-1', questions: RETRY_QUESTIONS.slice(1) }] })
  await ui.press({ key: 'back-from-story' })
  expect((await ui.find({ type: 'Button', key: 'decisions-ST-1' }))?.text).toBe('1 decision on the plan')
  expect(files.get(`${STORIES}/ST-1.md`)).not.toContain('decisionPicksSent')
  await ui.unmount()
})

test('answers sent from the board are read back from the story file, so a reloaded pane does not ask for them again', async ($, on) => {
  const files = seededBoard()
  standInForEngine(on, files)
  await startSession($)
  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'story', title: 'Uploads', destination: 'Uploads retry.', analysis: 'Asked: retry.', questions: RETRY_QUESTIONS }] })
  const story = files.get(`${STORIES}/ST-1.md`) ?? ''
  files.set(`${STORIES}/ST-1.md`, story.replace('title: Uploads', 'title: Uploads\ndecisionPicksSent: [recommended, recommended]'))

  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'back-from-story' })
  expect(await ui.find({ type: 'Button', key: 'decisions-ST-1' })).toBeUndefined()
  expect(await boardView($, 'waiting')).toContain('answered on the board, so the answer is with you to record, or ask again: the decisions on ST-1 (Uploads).')
  await ui.unmount()
})

test('from the yes on the plan on, its row is gone, until the session files the tickets anew', async ($, on) => {
  const files = seededBoard()
  standInForEngine(on, files)
  await startSession($)
  await filePlayback($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'back-from-story' })
  expect(await ui.find({ type: 'Button', key: 'yes-ST-1' })).toBeDefined()

  await ui.press({ key: 'yes-ST-1' })
  await ui.press({ key: 'yes-build-it' })

  const keys = await keysOf(ui)
  expect(keys).toContain('playback-answer-sent')
  expect(keys).not.toContain('yes-build-it')
  expect(keys).not.toContain('correction-words')
  expect(keys).not.toContain('send-correction')
  expect(await ui.find({ type: 'Text', text: 'You sent: Yes, build it.' })).toBeDefined()
  await ui.press({ key: 'back-from-story' })
  expect(await ui.find({ type: 'Button', key: 'yes-ST-1' })).toBeUndefined()
  expect(files.get(`${STORIES}/ST-1.md`)).toContain('playbackAnswerSent: "Yes, build it."')

  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'patch', id: 'SQ-4', what: 'A failed upload is sent again three times.' }] })
  await ui.press({ key: 'back-from-story' })
  expect(await ui.find({ type: 'Button', key: 'yes-ST-1' })).toBeDefined()
  expect(files.get(`${STORIES}/ST-1.md`)).not.toContain('playbackAnswerSent')
  await ui.unmount()
})

test('from the send of an answer on a waiting ticket on, the pane and the band no longer say it waits, until the session asks again', async ($, on) => {
  const files = seededBoard()
  const askedThisMorning = ticketFile('SQ-3', 'Pick a backoff', 'needs-you', ['2026-11-16T09:30Z asked the person'])
  files.set(`${TICKETS}/SQ-3.md`, askedThisMorning.replace('## What', `${FOR_YOU_SECTION}\n## What`))
  const standIn = standInForEngine(on, files)
  standInForEngineDrawing(on)
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const band = async (): Promise<string | undefined> => {
    const mounted = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const text = (await mounted.find({ type: 'Text', text: /needs you/ }))?.text
    await mounted.unmount()

    return text
  }
  expect(await band()).toBe('1 ticket needs you')

  await ui.press({ key: 'SQ-3' })
  await ui.press({ key: 'option-B' })
  await ui.press({ key: 'send-answer' })

  expect(standIn.submitted).toHaveLength(1)
  const keys = await keysOf(ui)
  expect(keys).toContain('answer-sent')
  expect(keys).not.toContain('send-answer')
  expect(keys).not.toContain('option-B')
  expect(keys).not.toContain('answer')
  expect(await ui.find({ type: 'Text', text: 'You sent: B. Ten seconds' })).toBeDefined()
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: 'WAITS ON YOU' })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'SQ-3' }))?.text).toContain('your answer is with the session')
  expect(await band()).toBeUndefined()
  expect(files.get(`${TICKETS}/SQ-3.md`)).toContain('answerSent: B. Ten seconds')
  expect(await boardView($, 'waiting')).toContain('Nothing waits on you.')

  await askAgain($, 'SQ-3')
  expect(await ui.find({ type: 'Text', text: 'WAITS ON YOU' })).toBeDefined()
  expect(await band()).toBe('1 ticket needs you')
  await ui.unmount()
})

type MountedPane = {
  input: (args: { key: string; text: string }) => Promise<unknown>
  find: (query: { type: string; key: string }) => Promise<{ props: Record<string, unknown> } | undefined>
  press: (args: { key: string }) => Promise<unknown>
}

// Enter keeps what was typed and sends nothing, as its hint says; Send then sends it once.
const enterKeepsAndSendSends = async (ui: MountedPane, standIn: EngineStandIn, field: string, sendKey: string): Promise<void> => {
  await ui.input({ key: field, text: 'half typed and' })

  expect(standIn.submitted).toEqual([])
  const input = await ui.find({ type: 'Input', key: field })
  expect(input?.props.value).toBe('half typed and')
  expect(input?.props.submitLabel).toBe('keep')

  await ui.press({ key: sendKey })
  expect(standIn.submitted).toHaveLength(1)
  expect(standIn.submitted[0]).toContain('half typed and')
}

test('in the words under the decisions Enter keeps the words and Send sends them once', async ($, on) => {
  const standIn = standInForEngine(on, seededBoard())
  await startSession($)
  await $.tool.call({ tool: 'mcp__sidequest__ticket', operations: [{ op: 'story', title: 'Uploads', destination: 'Uploads retry.', analysis: 'Asked: retry.', questions: RETRY_QUESTIONS }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await enterKeepsAndSendSends(ui, standIn, 'decisions-words', 'send-decisions')
  await ui.unmount()
})

test('in the correction under the proposed tickets Enter keeps the words and Send sends them once', async ($, on) => {
  const standIn = standInForEngine(on, seededBoard())
  await startSession($)
  await filePlayback($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await enterKeepsAndSendSends(ui, standIn, 'correction-words', 'send-correction')
  await ui.unmount()
})

test('in a waiting ticket\'s answer Enter keeps the words and Send sends them once', async ($, on) => {
  const files = seededBoard()
  files.set(`${TICKETS}/SQ-3.md`, waitingTicketFile(FOR_YOU_SECTION))
  const standIn = standInForEngine(on, files)
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'SQ-3' })

  await enterKeepsAndSendSends(ui, standIn, 'answer', 'send-answer')
  await ui.unmount()
})

test('in what the person says about a ticket Enter keeps the words, and after Send the field is empty and says where they went', async ($, on) => {
  const standIn = standInForEngine(on, seededBoard())
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'SQ-1' })

  await enterKeepsAndSendSends(ui, standIn, 'say', 'send-remark')
  expect((await ui.find({ type: 'Input', key: 'say' }))?.props.value).toBe('')
  expect(await ui.find({ type: 'Text', text: 'Sent to the session, and kept on file: "half typed and"' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Same as typing in the chat, with this ticket named.' })).toBeUndefined()
  await ui.unmount()
})

test('in what the person says about a plan Enter keeps the words, and after Send the field is empty and says where they went', async ($, on) => {
  const files = seededBoard()
  files.set(`${STORIES}/ST-1.md`, storyFile('ST-1', 'Tags on items', 'Asked: tags.'))
  const standIn = standInForEngine(on, files)
  await startSession($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'story-ST-1' })

  await enterKeepsAndSendSends(ui, standIn, 'say-about-story', 'send-story-remark')
  expect((await ui.find({ type: 'Input', key: 'say-about-story' }))?.props.value).toBe('')
  expect(await ui.find({ type: 'Text', text: 'Sent to the session, and kept on file: "half typed and"' })).toBeDefined()
  await ui.unmount()
})
