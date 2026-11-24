import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentSpawnInput, On, ToolCallResult } from 'claude-code'
import { outwardRule, RESULT_CONTRACT } from './brief'
import { otherBranchLines } from './branch-and-issue'
import type { EffortLevel } from './routing'
import { newTicket, serializeTicket } from './tickets'
import type { Ticket } from './tickets'
import { SIDEQUEST_TOOLS } from './tool-specs'

const ROOT = '/repo'
const EXCLUDE_NOTICE = 'Added .sidequest/ to .git/info/exclude so the board stays out of git: it is personal, and a team shares work through its tracker.'
const PREFIX_NOTE =
  'This board numbers its tickets REPO-1, REPO-2 and on, and its stories REPO-S1 and on: REPO comes from the folder name repo. The prefix is kept as "prefix" in .sidequest/board.json. To use other letters, change it there now, before there are many tickets.'
const TICKETS = `${ROOT}/.sidequest/tickets`
const NOW = Date.parse('2026-11-16T10:02:00Z')

// The engine hands fs hooks an absolute path in the host's own spelling (C:\repo\... on Windows).
const portablePath = (path: string): string => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

const entriesUnder = (files: Map<string, string>, folder: string) => {
  const prefix = `${folder}/`

  return [...files.keys()]
    .filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
    .map(path => ({ name: path.slice(prefix.length), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false }))
}

type Repository = { isRepository: boolean; tracksBoard: boolean; ignoresBoard: boolean; excludeIsReadOnly?: boolean }

const FRESH_REPOSITORY: Repository = { isRepository: true, tracksBoard: false, ignoresBoard: false }

const gitAnswer = (subcommand: string, repository: Repository): { exitCode: number; stdout: string } => {
  if (subcommand === 'rev-parse') return repository.isRepository ? { exitCode: 0, stdout: `${ROOT}/.git\n` } : { exitCode: 128, stdout: '' }
  if (subcommand === 'ls-files') return { exitCode: 0, stdout: repository.tracksBoard ? '.sidequest/board.json\n' : '' }

  return { exitCode: repository.ignoresBoard ? 0 : 1, stdout: '' }
}

const standInForEngine = (
  on: On,
  files: Map<string, string>,
  toasts: string[] = [],
  environment: Record<string, string> = { HOME: '/home' },
  repository: Repository = FRESH_REPOSITORY,
): Map<string, unknown> => {
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
    if (repository.excludeIsReadOnly && e.path.endsWith('exclude')) return { deny: `EACCES ${e.path}` }
    files.set(portablePath(e.path), e.text)

    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    const entries = entriesUnder(files, portablePath(e.path))

    return entries.length > 0 ? { value: entries } : { deny: `ENOENT ${e.path}` }
  })
  on('process.run', (_, e) => ({ value: { ...gitAnswer(e.argv[1] ?? '', repository), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('env.get', (_, e) => ({ value: environment[e.name] }))
  on('clock.now', () => ({ value: NOW }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__sidequest__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))

  return stateWrites
}

type SpawnFields = Pick<AgentSpawnInput, 'subagentType' | 'prompt' | 'description'> &
  Partial<Pick<AgentSpawnInput, 'model' | 'fork' | 'workflow' | 'provider' | 'tool_use_id'>>

const spawnInput = (fields: SpawnFields): AgentSpawnInput => ({
  tool_use_id: 'toolu_1',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'opus',
  background: false,
  fork: false,
  ...fields,
})

const textOf = (answer: ToolCallResult): string => (typeof answer.result === 'string' ? answer.result : `deny: ${answer.deny}`)

const createTickets = ($: Engine, operations: Record<string, unknown>[]) =>
  $.tool.call({ tool: 'mcp__sidequest__ticket', operations })

test('the first ticket creates the board and excludes it from git', async ($, on) => {
  const files = new Map([[`${ROOT}/.git/info/exclude`, '# git ls-files --others\n']])
  const stateWrites = standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const answer = await createTickets($, [
    { op: 'create', title: 'Retry failed uploads', what: 'Uploads retry.', doneWhen: '- [ ] retry test passes' },
    { op: 'create', title: 'Show retry count', blockedBy: ['REPO-1'], category: 'quick' },
    { op: 'story', title: 'Uploads', destination: 'Uploads survive.', decisions: [{ question: 'Retries?', answer: 'Three' }] },
  ])

  expect(textOf(answer)).toBe(`created REPO-1, created REPO-2, created REPO-S1. ${PREFIX_NOTE}\n${EXCLUDE_NOTICE}`)
  expect(files.get(`${TICKETS}/REPO-2.md`)).toContain('blockedBy: [REPO-1]')
  expect(files.get(`${ROOT}/.sidequest/stories/REPO-S1.md`)).toContain('- D-1: Retries? Answer: Three Decided by: human')
  expect(JSON.parse(files.get(`${ROOT}/.sidequest/board.json`) ?? '{}').nextTicket).toBe(3)
  expect(JSON.parse(files.get(`${ROOT}/.sidequest/board.json`) ?? '{}').prefix).toBe('REPO')
  expect(files.get(`${ROOT}/.git/info/exclude`)).toBe('# git ls-files --others\n.sidequest/\n')
  expect(stateWrites.get('sidequest.summary')).toEqual({
    needsYou: 0,
    needsYouFromEarlierWork: 0,
    ready: 2,
    doing: 0,
    review: 0,
  })
})

test('a second write to the board adds no exclude line and says nothing about it', async ($, on) => {
  const files = new Map([[`${ROOT}/.git/info/exclude`, '']])
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  await createTickets($, [{ op: 'create', title: 'First' }])
  const answer = await createTickets($, [{ op: 'create', title: 'Second' }])

  expect(textOf(answer)).toBe('created REPO-2.')
  expect(files.get(`${ROOT}/.git/info/exclude`)).toBe('.sidequest/\n')
})

const cases: [string, Repository][] = [
  ['the board folder is already tracked', { ...FRESH_REPOSITORY, tracksBoard: true }],
  ['the board folder is already ignored', { ...FRESH_REPOSITORY, ignoresBoard: true }],
]

for (const [situation, repository] of cases) {
  test(`the exclude file is left alone when ${situation}`, async ($, on) => {
    const files = new Map([[`${ROOT}/.git/info/exclude`, '# kept\n']])
    standInForEngine(on, files, [], { HOME: '/home' }, repository)
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

    const answer = await createTickets($, [{ op: 'create', title: 'First' }])

    expect(textOf(answer)).toBe(`created REPO-1. ${PREFIX_NOTE}`)
    expect(files.get(`${ROOT}/.git/info/exclude`)).toBe('# kept\n')
    expect(files.has(`${TICKETS}/REPO-1.md`)).toBe(true)
  })
}

test('the first ticket outside a git repository says where the board is and that it is no repository, once', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files, [], { HOME: '/home' }, { ...FRESH_REPOSITORY, isRepository: false })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const first = await createTickets($, [{ op: 'create', title: 'First' }])
  const second = await createTickets($, [{ op: 'create', title: 'Second' }])

  expect(textOf(first)).toBe(`created REPO-1. ${PREFIX_NOTE}
Created the board at ${ROOT}/.sidequest. This folder is not a git repository.`)
  expect(textOf(second)).toBe('created REPO-2.')
  expect(files.has(`${TICKETS}/REPO-1.md`)).toBe(true)
})

test('a board is still written when the exclude file cannot be written', async ($, on) => {
  const files = new Map([[`${ROOT}/.git/info/exclude`, '']])
  standInForEngine(on, files, [], { HOME: '/home' }, { ...FRESH_REPOSITORY, excludeIsReadOnly: true })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const answer = await createTickets($, [{ op: 'create', title: 'First' }])

  expect(textOf(answer)).toBe(`created REPO-1. ${PREFIX_NOTE}`)
  expect(files.has(`${TICKETS}/REPO-1.md`)).toBe(true)
})

test('a wrong operation writes nothing and lists the accepted names', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const answer = await createTickets($, [
    { op: 'create', title: 'Fine' },
    { op: 'create', titel: 'Typo' },
    { op: 'move', id: 'REPO-1' },
  ])

  expect(answer.deny).toContain('operation 2 (create): unknown field "titel". Accepted: op, title, what, doneWhen')
  expect(answer.deny).toContain('operation 2 (create): missing "title"')
  expect(answer.deny).toContain('operation 3 (move): missing "status"')
  expect(answer.deny).toContain('Nothing was written.')
  expect(files.size).toBe(0)
})

const boardWithOneTicket = async ($: Engine, on: On) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [{ op: 'create', title: 'First' }])

  return files
}

test('one operation at the top level is read as a list of one and the answer says so', async ($, on) => {
  const files = await boardWithOneTicket($, on)

  const moved = textOf(await $.tool.call({ tool: 'mcp__sidequest__ticket', id: 'REPO-1', status: 'parked' }))
  const noted = textOf(await $.tool.call({ tool: 'mcp__sidequest__ticket', id: 'REPO-1', note: 'looked at it' }))

  expect(moved).toContain('moved REPO-1 to parked.')
  expect(moved).toContain('read as one move operation')
  expect(noted).toContain('noted REPO-1.')
  expect(noted).toContain('read as one note operation')
  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain('status: parked')
  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain('note looked at it')
})

test('a note with its words in "note" is read as its text', async ($, on) => {
  const files = await boardWithOneTicket($, on)

  const answer = await createTickets($, [{ op: 'note', id: 'REPO-1', note: 'looked at it' }])

  expect(textOf(answer)).toContain('"note" was read as the text')
  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain('note looked at it')
})

test('op status with a status is read as a move', async ($, on) => {
  const files = await boardWithOneTicket($, on)

  const answer = await createTickets($, [{ op: 'status', id: 'REPO-1', status: 'parked' }])

  expect(textOf(answer)).toContain('moved REPO-1 to parked.')
  expect(textOf(answer)).toContain('op "status" was read as op "move"')
  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain('status: parked')
})

test('op finish names the finish tool and the rest of the batch is written', async ($, on) => {
  const files = await boardWithOneTicket($, on)

  const answer = await createTickets($, [{ op: 'finish', id: 'REPO-1', outcome: 'done' }, { op: 'note', id: 'REPO-1', text: 'kept' }])
  const alone = await createTickets($, [{ op: 'finish', id: 'REPO-1' }])

  expect(textOf(answer)).toContain('noted REPO-1.')
  expect(textOf(answer)).toContain('record a run result with the finish tool')
  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain('note kept')
  expect(alone.deny).toContain('record a run result with the finish tool')
})

test('a top-level call that is not plain is still refused', async ($, on) => {
  await boardWithOneTicket($, on)

  const answer = await $.tool.call({ tool: 'mcp__sidequest__ticket', id: 'REPO-1', status: 'parked', title: 'Other' })

  expect(answer.deny).toContain('"operations" must be a non-empty array of operations')
})

test('a missing ticket refuses the whole batch, so nothing is written halfway',async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const answer = await createTickets($, [
    { op: 'create', title: 'Odd', category: 'misc' },
    { op: 'note', id: 'REPO-40', text: 'hello' },
  ])

  expect(answer.deny).toContain('no ticket REPO-40 on this board')
  expect(answer.deny).not.toContain('category')
  expect(files.size).toBe(0)
})

test('a category with no route is written and the reply names the category it will run on', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const answer = await createTickets($, [{ op: 'create', title: 'Odd', category: 'misc' }])

  expect(textOf(answer)).toBe(`created REPO-1. ${PREFIX_NOTE} REPO-1 has category "misc", which has no route on this board, so start runs it as build.\n${EXCLUDE_NOTICE}`)
  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain('category: misc')
})

test('the board tool answers each view', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [
    { op: 'create', title: 'First' },
    { op: 'create', title: 'Second', blockedBy: ['REPO-1'] },
    { op: 'create', title: 'Third', status: 'needs-you' },
    { op: 'note', id: 'REPO-1', text: 'looked at the upload code' },
  ])
  const view = async (input: Record<string, unknown>) => textOf(await $.tool.call({ tool: 'mcp__sidequest__board', ...input }))

  expect(await view({ view: 'summary' })).toBe(
    '1 waiting on you, 2 ready to start, 0 in progress, 0 being checked. Ready to start: REPO-1. The waiting view writes what waits on the person, ready to pass on.',
  )
  expect(await view({ view: 'frontier' })).toBe('REPO-1 ready build First')
  expect(await view({ view: 'list', status: 'ready' })).toBe('REPO-1 ready build First\nREPO-2 ready build Second')
  expect(await view({ view: 'ticket', id: 'REPO-1' })).toContain('- 2026-11-16T10:02Z note looked at the upload code')
  expect(await view({ view: 'list', status: 'started' })).toBe(
    'REPO-1 ready build First\nREPO-2 ready build Second\nREPO-3 needs-you build Third\nstatus "started" is not one of inbox, ready, doing, review, needs-you, done, parked, dropped, so this is every ticket.',
  )
  expect(await view({ view: 'everything', filter: 'all' })).toBe(
    '1 waiting on you, 2 ready to start, 0 in progress, 0 being checked. Ready to start: REPO-1. The waiting view writes what waits on the person, ready to pass on.\nview "everything" is not one of summary, waiting, now, closing, frontier, list, ticket, routing, planning, diagram, so this is the summary.\nIgnored "filter": this tool takes view, status, id, of.',
  )
  expect(await view({})).toContain('No view was given, so this is the summary.')
  expect(await view({ view: 'ticket', id: 'REPO-9' })).toContain('deny: No ticket or story REPO-9 on this board.')
  expect(await view({ view: 'ticket' })).toBe(
    'REPO-1 ready build First\nREPO-2 ready build Second\nREPO-3 needs-you build Third\nNo id was given, so this is the ticket list.',
  )
  expect(await view({ view: 'routing' })).toContain('review: scout, tier deep, opus/high.')
  expect(await view({ view: 'routing' })).toContain('"unrouted":"build"')
})

test('start marks a ticket doing and returns the routed Agent call', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [
    { op: 'create', title: 'Retry failed uploads', what: 'Uploads retry.', doneWhen: '- [ ] retry test passes' },
    { op: 'create', title: 'Trace upload flow', category: 'explore', kind: 'research' },
    { op: 'create', title: 'Pick a backoff', mode: 'hitl' },
  ])

  const started = textOf(await $.tool.call({ tool: 'mcp__sidequest__start', id: 'REPO-1' }))
  const call = JSON.parse(started.slice(started.indexOf('{'), started.lastIndexOf('}') + 1))
  const scout = textOf(await $.tool.call({ tool: 'mcp__sidequest__start', id: 'REPO-2' }))
  const refused = await $.tool.call({ tool: 'mcp__sidequest__start', id: 'REPO-3' })

  expect(started.startsWith('REPO-1 is now doing.')).toBe(true)
  expect(call.subagent_type).toBe('sidequest:worker')
  expect(call.model).toBe('sonnet')
  expect(call.effort).toBe('medium')
  expect(call.isolation).toBe('worktree')
  expect(call.name).toBe('repo-1')
  expect(call.prompt).toContain('Ticket REPO-1: Retry failed uploads')
  expect(call.prompt).toContain('- [ ] retry test passes')
  expect(call.prompt).toContain('# Result contract')
  expect(scout).toContain('"subagent_type": "sidequest:scout"')
  expect(scout).not.toContain('isolation')
  expect(refused.deny).toContain('REPO-3 is hitl')
  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain('status: doing')
  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain('- 2026-11-16T10:02Z started worker sonnet/medium')
})

const OWN_CODE_CATEGORIES = ['explore', 'research', 'quick', 'build', 'hard', 'debug', 'review']

test('a ticket about outside code starts the reviewer with no shell, and every other category keeps its brief word for word', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [
    { op: 'create', title: 'Pull request 41 from a contributor', category: 'outside-code', kind: 'review', what: 'The diff is in pr-41.diff.' },
    ...OWN_CODE_CATEGORIES.map(category => ({ op: 'create', title: `Upload retry as ${category}`, category, what: 'Uploads retry.', doneWhen: '- [ ] retry test passes' })),
  ])
  const callFor = async (id: string) => {
    const answer = textOf(await $.tool.call({ tool: 'mcp__sidequest__start', id }))

    return JSON.parse(answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1))
  }

  const reviewer = await callFor('REPO-1')
  const routing = textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: 'routing' }))

  expect(reviewer.subagent_type).toBe('sidequest:outside-code-reviewer')
  expect(reviewer.model).toBe('opus')
  expect(reviewer.effort).toBe('high')
  expect(reviewer.isolation).toBe(undefined)
  expect(routing).toContain('outside-code: outside-code-reviewer, tier deep, opus/high.')
  for (const [index, category] of OWN_CODE_CATEGORIES.entries()) {
    const id = `REPO-${index + 2}`
    const call = await callFor(id)

    expect(call.subagent_type).not.toBe('sidequest:outside-code-reviewer')
    expect(call.prompt).toBe(
      `Ticket ${id}: Upload retry as ${category}\n\n## What\nUploads retry.\n\n## Done when\n- [ ] retry test passes\n\n${outwardFor(id)}\n\n${RESULT_CONTRACT}`,
    )
  }
})

test('start with a delivery rule puts it in the brief and on the start log line', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [
    { op: 'create', title: 'Retry failed uploads', what: 'Uploads retry.', doneWhen: '- [ ] retry test passes' },
    { op: 'create', title: 'Trace upload flow' },
  ])

  const plain = textOf(await $.tool.call({ tool: 'mcp__sidequest__start', id: 'REPO-1' }))
  const ruled = textOf(await $.tool.call({ tool: 'mcp__sidequest__start', id: 'REPO-2', delivery: 'Commit on the current branch.\nNo branch, no pull request.' }))
  const brief = JSON.parse(ruled.slice(ruled.indexOf('{'), ruled.lastIndexOf('}') + 1)).prompt

  expect(brief).toContain('## Delivery\nCommit on the current branch.\nNo branch, no pull request.\n\n' + outwardFor('REPO-2') + '\n\n# Result contract')
  expect(files.get(`${TICKETS}/REPO-2.md`)).toContain('started worker sonnet/medium. delivery "Commit on the current branch. No branch, no pull request."')
  expect(plain).not.toContain('Delivery')
  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain('- 2026-11-16T10:02Z started worker sonnet/medium\n')
})

test('the brief carries the story the human agreed to', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [
    { op: 'story', title: 'Uploads', destination: 'Uploads survive a flaky network.', decisions: [{ question: 'Retries?', answer: 'Three' }] },
    { op: 'create', title: 'Retry failed uploads', story: 'REPO-S1', what: 'Uploads retry.' },
    { op: 'create', title: 'Unrelated' },
  ])

  const withStory = textOf(await $.tool.call({ tool: 'mcp__sidequest__start', id: 'REPO-1' }))
  const withoutStory = textOf(await $.tool.call({ tool: 'mcp__sidequest__start', id: 'REPO-2' }))

  expect(JSON.parse(withStory.slice(withStory.indexOf('{'), withStory.lastIndexOf('}') + 1)).prompt).toContain('## Where this is going\nUploads survive a flaky network.')
  expect(JSON.parse(withStory.slice(withStory.indexOf('{'), withStory.lastIndexOf('}') + 1)).prompt).toContain('## Decisions already made\n- D-1: Retries? Answer: Three Decided by: human')
  expect(withoutStory).not.toContain('Where this is going')
})

test('a brief carries only the decisions its ticket names, and all of them when it names none', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const answers = ['One', 'Two', 'Three', 'Four', 'Five']
  await createTickets($, [
    { op: 'story', title: 'Uploads', decisions: answers.map(answer => ({ question: `Q${answer}?`, answer })) },
    { op: 'create', title: 'Names two', story: 'REPO-S1', decisions: ['D-4', 'D-2'] },
    { op: 'create', title: 'Names none', story: 'REPO-S1' },
  ])

  const promptOf = async (id: string): Promise<string> => {
    const started = textOf(await $.tool.call({ tool: 'mcp__sidequest__start', id }))
    return JSON.parse(started.slice(started.indexOf('{'), started.lastIndexOf('}') + 1)).prompt
  }
  const namesTwo = await promptOf('REPO-1')
  const namesNone = await promptOf('REPO-2')

  expect(namesTwo).toContain('- D-2: QTwo?')
  expect(namesTwo).toContain('- D-4: QFour?')
  expect(namesTwo.indexOf('D-2:')).toBeLessThan(namesTwo.indexOf('D-4:'))
  for (const unnamed of ['D-1:', 'D-3:', 'D-5:']) expect(namesTwo).not.toContain(unnamed)
  for (const id of ['D-1:', 'D-2:', 'D-3:', 'D-4:', 'D-5:']) expect(namesNone).toContain(id)
})

// Seen in a real run on an older version: a `## ` heading inside a ticket's what split the file, and the builder got
// the first paragraph without its approach, tests or commands.
test('a ticket whose what holds its own sections reaches the builder whole, through create and start', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const what = [
    'Search can include archived notes.',
    '',
    '## Approach',
    'The store gets listAll() next to listActive().',
    'The archived rule is a predicate beside the other filters.',
    '',
    '## Tests',
    "'POST /search with archived \"only\" answers archived notes alone'",
    'Run with `npm test -- test/http.test.mjs`.',
  ].join('\n')
  await createTickets($, [{ op: 'create', title: 'Search can include archived notes', what }])

  const started = textOf(await $.tool.call({ tool: 'mcp__sidequest__start', id: 'REPO-1' }))
  const prompt: string = JSON.parse(started.slice(started.indexOf('{'), started.lastIndexOf('}') + 1)).prompt
  const briefFile = files.get(`${ROOT}/.sidequest/briefs/REPO-1.md`) ?? ''

  for (const brief of [prompt, briefFile]) {
    expect(brief).toContain('The store gets listAll() next to listActive().')
    expect(brief).toContain('The archived rule is a predicate beside the other filters.')
    expect(brief).toContain("'POST /search with archived \"only\" answers archived notes alone'")
    expect(brief).toContain('Run with `npm test -- test/http.test.mjs`.')
  }
})

test('a ticket sent back after a failed review starts with the branch and the findings of its last run', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [{ op: 'create', title: 'Retry failed uploads', what: 'Uploads retry.' }])
  await $.tool.call({ tool: 'mcp__sidequest__start', id: 'REPO-1' })
  await $.tool.call({ tool: 'mcp__sidequest__finish', id: 'REPO-1', outcome: 'done', result: 'Retries.', branch: 'worktree-repo-1', commits: '1' })
  await createTickets($, [
    { op: 'note', id: 'REPO-1', text: 'review fail: the retry count is never reset' },
    { op: 'move', id: 'REPO-1', status: 'ready' },
  ])

  const restarted = textOf(await $.tool.call({ tool: 'mcp__sidequest__start', id: 'REPO-1' }))
  const brief: string = JSON.parse(restarted.slice(restarted.indexOf('{'), restarted.lastIndexOf('}') + 1)).prompt

  expect(brief).toContain('## Earlier run\nThe last run committed on branch worktree-repo-1. Merge it into your worktree first')
  expect(brief).toContain('The review that sent it back:\nreview fail: the retry count is never reset')
  expect(brief.indexOf('## Earlier run')).toBeLessThan(brief.indexOf('# Result contract'))
})

test('a ticket the board recorded by itself takes its branch from the return record, and says so when none was recorded', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  recordingSpawns(on, [])
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await mainTurn($, 'main-1', async () => {
    await startAndSpawn($)
    await agentReturns($, CONTRACT_ANSWER.replace('`branch`: repo-1', '`branch`: `worktree-agent-ab12` (2 commits)'))
  })
  await mainTurn($, 'main-2')
  await mainTurn($, 'main-3')
  await createTickets($, [{ op: 'note', id: 'REPO-1', text: 'review fail: the retry count is never reset' }, { op: 'move', id: 'REPO-1', status: 'ready' }])

  const restarted = textOf(await $.tool.call({ tool: 'mcp__sidequest__start', id: 'REPO-1' }))
  await createTickets($, [{ op: 'create', title: 'No branch' }])
  await $.tool.call({ tool: 'mcp__sidequest__start', id: 'REPO-2' })
  await createTickets($, [{ op: 'note', id: 'REPO-2', text: 'review fail: nothing was built' }, { op: 'move', id: 'REPO-2', status: 'ready' }])
  const withoutBranch = textOf(await $.tool.call({ tool: 'mcp__sidequest__start', id: 'REPO-2' }))

  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain('recorded by the board because finish was not called')
  expect(restarted).toContain('The last run committed on branch worktree-agent-ab12. Merge it')
  expect(withoutBranch).toContain('## Earlier run\\nNo branch was recorded for the last run.\\n\\nThe review that sent it back:')
  expect(withoutBranch).not.toContain('Merge it')
})

test('a ticket with no earlier run gets no earlier run section, and a passed review is not sent back as findings', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [{ op: 'create', title: 'First run' }, { op: 'create', title: 'Passed review' }])
  const first = textOf(await $.tool.call({ tool: 'mcp__sidequest__start', id: 'REPO-1' }))
  await $.tool.call({ tool: 'mcp__sidequest__start', id: 'REPO-2' })
  await createTickets($, [
    { op: 'note', id: 'REPO-2', text: 'review fail: first finding' },
    { op: 'note', id: 'REPO-2', text: 'review pass: fixed' },
    { op: 'move', id: 'REPO-2', status: 'ready' },
  ])
  const passed = textOf(await $.tool.call({ tool: 'mcp__sidequest__start', id: 'REPO-2' }))

  expect(first).not.toContain('Earlier run')
  expect(passed).not.toContain('first finding')
})

const PROVIDER_FILE = JSON.stringify({ name: 'p', models: [{ id: 'other-model-1', label: 'One' }] })

test('the provider file is read from the folder the writer uses: the config folder, else USERPROFILE before HOME', async ($, on) => {
  const board = JSON.stringify({ tiers: { deep: { model: 'other-model-1', effort: 'high' } } })
  const files = new Map<string, string>([
    [`${ROOT}/.sidequest/board.json`, board],
    ['/real/.claude/toolshed/providers/p.json', PROVIDER_FILE],
    ['/configured/toolshed/providers/p.json', PROVIDER_FILE.replace('other-model-1', 'configured-model')],
  ])
  const environment: Record<string, string> = { HOME: '/wrong', USERPROFILE: '/real' }
  standInForEngine(on, files, [], environment)
  const seen: (string | undefined)[] = []
  recordingSpawns(on, seen)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  await $.agent.spawn(spawnInput({ subagentType: 'general-purpose', prompt: '[route:hard] first', description: 'first' }))
  environment.CLAUDE_CONFIG_DIR = '/configured'
  await $.agent.spawn(spawnInput({ subagentType: 'general-purpose', prompt: '[route:hard] second', description: 'second' }))

  files.delete('/configured/toolshed/providers/p.json')
  await $.agent.spawn(spawnInput({ subagentType: 'general-purpose', prompt: '[route:hard] third', description: 'third' }))

  expect(seen).toEqual(['other-model-1', 'sonnet', 'other-model-1'])
})

test('the list view can show stories with their ticket counts', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const view = async (input: Record<string, unknown>) => textOf(await $.tool.call({ tool: 'mcp__sidequest__board', ...input }))

  expect(await view({ view: 'list', of: 'stories' })).toBe('No stories on this board.')
  await createTickets($, [
    { op: 'story', title: 'Uploads', destination: 'Uploads survive a flaky network.' },
    { op: 'create', title: 'Retry failed uploads', story: 'REPO-S1' },
    { op: 'create', title: 'Unrelated' },
  ])

  expect(await view({ view: 'list', of: 'stories' })).toBe('REPO-S1 Uploads (1 ticket)')
  expect(await view({ view: 'list', of: 'tickets', status: 'ready' })).toContain('REPO-2')
  expect(await view({ view: 'list', of: 'epics' })).toContain('of "epics" is not one of tickets, stories, so this lists tickets.')
})

test('a blocker that is not on the board is written and named in the reply', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const answer = await createTickets($, [
    { op: 'create', title: 'Build the screens' },
    { op: 'create', title: 'Look at the screens', kind: 'review', mode: 'hitl', blockedBy: ['REPO-1', 'REPO-9'] },
  ])

  expect(textOf(answer).split('\n')[0]).toBe(
    `created REPO-1, created REPO-2. ${PREFIX_NOTE} REPO-2 is blocked by REPO-9, which is not on this board: patch blockedBy to the id you meant.`,
  )
  expect(files.get(`${TICKETS}/REPO-2.md`)).toContain('blockedBy: [REPO-1, REPO-9]')
})

test('finish logs the result and moves the ticket by outcome and kind', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [
    { op: 'create', title: 'Build it' },
    { op: 'create', title: 'Research it', kind: 'research', category: 'research' },
    { op: 'create', title: 'Try it' },
  ])

  const built = await $.tool.call({
    tool: 'mcp__sidequest__finish',
    id: 'REPO-1',
    outcome: 'done',
    result: 'Uploads retry three times.',
    checked: 'npm test exit 0',
    branch: 'repo-1',
    commits: 2,
    needs: 'nothing',
    changedFiles: ['src/upload.ts'],
  })
  await $.tool.call({ tool: 'mcp__sidequest__finish', id: 'REPO-2', outcome: 'done', result: 'Found the answer.' })
  await $.tool.call({ tool: 'mcp__sidequest__finish', id: 'REPO-3', outcome: 'failed', result: 'Could not build.' })
  const unknownTicket = await $.tool.call({ tool: 'mcp__sidequest__finish', id: 'REPO-9', outcome: 'done', result: 'x' })

  expect(textOf(built)).toBe(`REPO-1 moved to review. ${NO_VERIFY_LINE}`)
  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain(
    '- 2026-11-16T10:02Z finished done branch repo-1 commits 2 checked "npm test exit 0"\n- 2026-11-16T10:02Z result Uploads retry three times.\n- 2026-11-16T10:02Z changed src/upload.ts',
  )
  expect(files.get(`${TICKETS}/REPO-2.md`)).toContain('status: done')
  expect(files.get(`${TICKETS}/REPO-3.md`)).toContain('status: needs-you')
  expect(unknownTicket.deny).toContain('No ticket REPO-9 on this board.')
})

const NO_VERIFY_LINE =
  "No verify command is set. If this ticket's check is the project's check, put it in settings.verify in .sidequest/board.json."

test('finish says no verify command is set once, on the first ticket to reach review, and not when verify is set', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [{ op: 'create', title: 'Build it' }, { op: 'create', title: 'Build more' }])

  const first = await $.tool.call({ tool: 'mcp__sidequest__finish', id: 'REPO-1', outcome: 'done', result: 'Done.' })
  const second = await $.tool.call({ tool: 'mcp__sidequest__finish', id: 'REPO-2', outcome: 'done', result: 'Done.' })

  expect(textOf(first)).toContain(NO_VERIFY_LINE)
  expect(textOf(second)).toBe('REPO-2 moved to review. Nothing was checked, so nobody has seen this work pass a check yet.')
})

test('finish says nothing about verify when settings.verify is set', async ($, on) => {
  const board = JSON.stringify({ settings: { verify: 'npm test' } })
  const files = new Map([[`${ROOT}/.sidequest/board.json`, board]])
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [{ op: 'create', title: 'Build it' }])

  const answer = await $.tool.call({ tool: 'mcp__sidequest__finish', id: 'REPO-1', outcome: 'done', result: 'Done.' })

  expect(textOf(answer)).toBe('REPO-1 moved to review. Nothing was checked, so nobody has seen this work pass a check yet.')
})

test('finish with an unknown field and an outcome outside the three still records the result and moves the ticket', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [{ op: 'create', title: 'Build it' }, { op: 'create', title: 'Try it' }, { op: 'create', title: 'Ask it' }])

  const succeeded = await $.tool.call({
    tool: 'mcp__sidequest__finish',
    id: 'REPO-1',
    outcome: 'success',
    result: 'Uploads retry three times.',
    reviewer: 'me',
  })
  const crashed = await $.tool.call({ tool: 'mcp__sidequest__finish', id: 'REPO-2', outcome: 'error: the tests crashed', commits: '1' })
  const asked = await $.tool.call({ tool: 'mcp__sidequest__finish', id: 'REPO-3', result: 'Two libraries fit.', needs: 'Pick one of them.' })

  expect(textOf(succeeded)).toBe(
    'REPO-1 moved to review. outcome "success" is not one of done, failed, needs-you, so it was read as done. Ignored "reviewer": this tool takes id, outcome, result, checked, uncertain, needs, branch, commits, changedFiles.' + ` ${NO_VERIFY_LINE} Nothing was checked, so nobody has seen this work pass a check yet.`,
  )
  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain('status: review')
  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain('- 2026-11-16T10:02Z finished done\n- 2026-11-16T10:02Z result Uploads retry three times.')
  expect(textOf(crashed).split('\n')[0]).toBe('REPO-2 moved to needs-you. outcome "error: the tests crashed" is not one of done, failed, needs-you, so it was read as failed. No result was given.')
  expect(files.get(`${TICKETS}/REPO-2.md`)).toContain('- 2026-11-16T10:02Z finished failed commits 1\n- 2026-11-16T10:02Z result not recorded')
  expect(textOf(asked).split('\n')[0]).toBe('REPO-3 moved to needs-you. No outcome was given, so it was read as needs-you.')
  expect(files.get(`${TICKETS}/REPO-3.md`)).toContain('needs Pick one of them.')
})

test('start on a ticket whose category has no route returns an Agent call on the default category and logs why', async ($, on) => {
  const files = new Map<string, string>()
  const stateWrites = standInForEngine(on, files)
  recordingSpawns(on, [])
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [{ op: 'create', title: 'Tidy the docs', category: 'misc' }])

  const started = textOf(await $.tool.call({ tool: 'mcp__sidequest__start', id: 'REPO-1', priority: 'high' }))
  const call = JSON.parse(started.slice(started.indexOf('{'), started.lastIndexOf('}') + 1))
  await $.agent.spawn(spawnInput({ subagentType: call.subagent_type, prompt: call.prompt, description: call.description, model: call.model }))

  expect(started).toContain('REPO-1 is now doing. Its category "misc" has no route on this board, so it runs as build.')
  expect(started).toContain('Ignored "priority": this tool takes id, delivery, alongside, forWave.')
  expect(started).toContain('The board logs what the agent returns on the ticket by itself; call finish when it returns to add what you checked')
  expect(call.subagent_type).toBe('sidequest:worker')
  expect(call.model).toBe('sonnet')
  expect(call.effort).toBe('medium')
  expect(call.prompt.startsWith('REPO-1 [route:build] Ticket REPO-1: Tidy the docs')).toBe(true)
  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain(
    '- 2026-11-16T10:02Z started worker sonnet/medium. category "misc" has no route on this board, so it runs as build',
  )
  expect(stateWrites.get('sidequest.runs')).toEqual({
    'agent-1': { ticket: 'REPO-1', category: 'build', requestedModel: 'sonnet', model: 'sonnet', effort: 'medium', toolUseId: 'toolu_1' },
  })
})

const CONTRACT_ANSWER = [
  'Done. Here is the result.',
  '',
  '- `result`: Uploads retry three times.',
  '- `checked`: `npm test` exit 0',
  '- `uncertain`: did not try a real flaky network',
  '- `needs`: nothing',
  '- `branch`: repo-1',
  '- `commits`: 2',
  '- `changedFiles`:',
  '  - src/upload.ts',
  '  - src/upload.test.ts',
].join('\n')

const startAndSpawn = async ($: Engine, title = 'Retry failed uploads') => {
  await createTickets($, [{ op: 'create', title }])
  await $.tool.call({ tool: 'mcp__sidequest__start', id: 'REPO-1' })
  await $.agent.spawn(spawnInput({ subagentType: 'sidequest:worker', prompt: `Ticket REPO-1: ${title}`, description: 'REPO-1 retry' }))
}

const agentReturns = ($: Engine, answer: string, reason: 'answer' | 'aborted' = 'answer', agentId = 'agent-1') =>
  $.turn.complete({ answer, durationMs: 240000, isAborted: reason === 'aborted', turnId: 'agent-turn', agentId, reason })

const mainTurn = async ($: Engine, turnId: string, during?: () => Promise<unknown>) => {
  await $.turn.start({ text: '', turnId })
  if (during) await during()
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId, reason: 'answer' })
}

test('a routed agent that returns gets its result, checked and uncertain on the ticket log with no call to finish', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  recordingSpawns(on, [])
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await startAndSpawn($)

  await agentReturns($, CONTRACT_ANSWER)
  const afterReturn = files.get(`${TICKETS}/REPO-1.md`) ?? ''
  await $.tool.call({ tool: 'mcp__sidequest__finish', id: 'REPO-1', outcome: 'done', result: 'Uploads retry three times.', checked: 'npm test exit 0' })
  const afterFinish = files.get(`${TICKETS}/REPO-1.md`) ?? ''

  expect(afterReturn).toContain(
    [
      '- 2026-11-16T10:02Z returned build run after 4m, agent agent-1',
      '- 2026-11-16T10:02Z result Uploads retry three times.',
      '- 2026-11-16T10:02Z checked `npm test` exit 0',
      '- 2026-11-16T10:02Z uncertain did not try a real flaky network',
      '- 2026-11-16T10:02Z needs nothing',
      '- 2026-11-16T10:02Z branch repo-1',
      '- 2026-11-16T10:02Z commits 2',
      '- 2026-11-16T10:02Z changed src/upload.ts, src/upload.test.ts',
    ].join('\n'),
  )
  expect(afterReturn).toContain('status: doing')
  expect(afterReturn).not.toContain('finished')
  expect(afterFinish.split('result Uploads retry three times.').length).toBe(2)
  expect(afterFinish).toContain('status: review')
})

const returnBlocksIn = (ticketFile: string | undefined): number => (ticketFile ?? '').split(' returned build run').length - 1

test('an agent that stops once to wait and then returns its result has one block on the log, holding the result', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  recordingSpawns(on, [])
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await startAndSpawn($)

  await agentReturns($, 'The reload watch is running in the background.')
  const whileWaiting = files.get(`${TICKETS}/REPO-1.md`)
  await agentReturns($, CONTRACT_ANSWER)
  const afterResult = files.get(`${TICKETS}/REPO-1.md`)

  expect(returnBlocksIn(whileWaiting)).toBe(1)
  expect(returnBlocksIn(afterResult)).toBe(1)
  expect(afterResult).toContain('result Uploads retry three times.')
  expect(afterResult).toContain('checked `npm test` exit 0')
  expect(afterResult).not.toContain('reload watch')
})

const spawnSecondWorker = ($: Engine) =>
  $.agent.spawn(spawnInput({ subagentType: 'sidequest:worker', prompt: 'Ticket REPO-1: Retry failed uploads, second part', description: 'REPO-1 second' }))

const SECOND_ANSWER = CONTRACT_ANSWER.replace('Uploads retry three times.', 'Uploads back off.')

const startTwoWorkers = async ($: Engine, on: On, files: Map<string, string>) => {
  standInForEngine(on, files)
  recordingSpawns(on, [])
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await startAndSpawn($)
  await spawnSecondWorker($)
}

test('two agents of one category on one ticket each keep their own block, whoever returns first', async ($, on) => {
  const files = new Map<string, string>()
  await startTwoWorkers($, on, files)

  await agentReturns($, CONTRACT_ANSWER, 'answer', 'agent-1')
  await agentReturns($, SECOND_ANSWER, 'answer', 'agent-2')
  const firstThenSecond = files.get(`${TICKETS}/REPO-1.md`)

  expect(returnBlocksIn(firstThenSecond)).toBe(2)
  expect(firstThenSecond).toContain('result Uploads retry three times.')
  expect(firstThenSecond).toContain('result Uploads back off.')
  expect(firstThenSecond).toContain('returned build run after 4m, agent agent-1')
  expect(firstThenSecond).toContain('returned build run after 4m, agent agent-2')
})

test('two agents of one category keep their own block when the later spawned one returns first', async ($, on) => {
  const files = new Map<string, string>()
  await startTwoWorkers($, on, files)

  await agentReturns($, SECOND_ANSWER, 'answer', 'agent-2')
  await agentReturns($, CONTRACT_ANSWER, 'answer', 'agent-1')
  const secondThenFirst = files.get(`${TICKETS}/REPO-1.md`)

  expect(returnBlocksIn(secondThenFirst)).toBe(2)
  expect(secondThenFirst).toContain('result Uploads retry three times.')
  expect(secondThenFirst).toContain('result Uploads back off.')
})

test('a short text from a second agent is its own block and never taken for the first agent result', async ($, on) => {
  const files = new Map<string, string>()
  await startTwoWorkers($, on, files)

  await agentReturns($, CONTRACT_ANSWER, 'answer', 'agent-1')
  await agentReturns($, 'Still waiting.', 'answer', 'agent-2')
  const afterBoth = files.get(`${TICKETS}/REPO-1.md`)
  await agentReturns($, SECOND_ANSWER, 'answer', 'agent-2')
  const afterSecondResult = files.get(`${TICKETS}/REPO-1.md`)

  expect(afterBoth).toContain('Still waiting.')
  expect(afterBoth).toContain('result Uploads retry three times.')
  expect(returnBlocksIn(afterSecondResult)).toBe(2)
  expect(afterSecondResult).not.toContain('Still waiting.')
  expect(afterSecondResult).toContain('result Uploads retry three times.')
  expect(afterSecondResult).toContain('result Uploads back off.')
})

test('a return block written before blocks named their agent is never replaced, and the new one is appended', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  recordingSpawns(on, [])
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await startAndSpawn($)
  const ticketPath = `${TICKETS}/REPO-1.md`
  const unnamed = ['returned build run after 4m', 'result Old.', 'checked not recorded', 'uncertain not recorded', 'needs not recorded', 'branch not recorded', 'commits not recorded', 'changed not recorded']
  const oldBlock = unnamed.map(line => `- 2026-11-16T10:01Z ${line}`).join('\n')
  files.set(ticketPath, `${(files.get(ticketPath) ?? '').trimEnd()}\n${oldBlock}\n`)

  await agentReturns($, CONTRACT_ANSWER)
  const afterReturn = files.get(ticketPath)

  expect(returnBlocksIn(afterReturn)).toBe(2)
  expect(afterReturn).toContain('result Old.')
  expect(afterReturn).toContain('result Uploads retry three times.')
})

test('an agent that wakes from its own timer after its result and says a short text adds nothing to the log', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  recordingSpawns(on, [])
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await startAndSpawn($)

  await agentReturns($, CONTRACT_ANSWER)
  const afterResult = files.get(`${TICKETS}/REPO-1.md`)
  await agentReturns($, 'Still waiting.')
  await agentReturns($, 'Still waiting.')

  expect(files.get(`${TICKETS}/REPO-1.md`)).toBe(afterResult)
  expect(returnBlocksIn(afterResult)).toBe(1)
})

test('an answer with none of the fields is kept as the result, and an interrupted run says so and stays doing', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  recordingSpawns(on, [])
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  await mainTurn($, 'main-1', async () => {
    await startAndSpawn($)
    await agentReturns($, 'I got halfway through the retry code.', 'aborted')
  })
  await mainTurn($, 'main-2')
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const ticket = files.get(`${TICKETS}/REPO-1.md`) ?? ''

  expect(ticket).toContain(
    '- 2026-11-16T10:02Z returned build run, interrupted after 4m, agent agent-1\n- 2026-11-16T10:02Z result I got halfway through the retry code.\n- 2026-11-16T10:02Z checked not recorded',
  )
  expect(ticket).toContain('status: doing')
  expect(ticket).not.toContain('finished')
})

test('a finish after the return does not repeat the check the return record already holds', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  recordingSpawns(on, [])
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await startAndSpawn($)
  await agentReturns($, CONTRACT_ANSWER)

  await $.tool.call({ tool: 'mcp__sidequest__finish', id: 'REPO-1', outcome: 'done', result: 'Uploads retry three times.', checked: '`npm test` exit 0' })

  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain('- 2026-11-16T10:02Z finished done\n')
  expect(files.get(`${TICKETS}/REPO-1.md`)?.split('npm test').length).toBe(2)
})

test('a returned worker woken again by a follow-up message is not recorded under it', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  on('agent.spawn', (_, e) => ({ model: e.model ?? 'sonnet', agentId: e.resume?.agentId ?? 'agent-1' }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const status = () => /status: (\S+)/.exec(files.get(`${TICKETS}/REPO-1.md`) ?? '')?.[1]

  await mainTurn($, 'main-1', async () => {
    await startAndSpawn($)
    await agentReturns($, CONTRACT_ANSWER)
  })
  await $.agent.spawn({ ...spawnInput({ subagentType: 'sidequest:worker', prompt: 'Also add a log line.', description: 'follow-up' }), resume: { agentId: 'agent-1' } })
  await mainTurn($, 'main-2')
  const whileWorkerRunsAgain = status()
  await agentReturns($, CONTRACT_ANSWER)
  await mainTurn($, 'main-3')
  await mainTurn($, 'main-4')

  expect(whileWorkerRunsAgain).toBe('doing')
  expect(status()).toBe('review')
})

test('a return nobody recorded is moved by the board at the end of the second main turn, not the first', async ($, on) => {
  const files = new Map<string, string>()
  const toasts: string[] = []
  const stateWrites = standInForEngine(on, files, toasts)
  recordingSpawns(on, [])
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const status = () => /status: (\S+)/.exec(files.get(`${TICKETS}/REPO-1.md`) ?? '')?.[1]
  const summary = async () => textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: 'summary' }))

  await mainTurn($, 'main-1', async () => {
    await startAndSpawn($)
    await agentReturns($, CONTRACT_ANSWER)
  })
  const afterFirstTurn = status()
  const summaryBetweenTurns = await summary()
  const cardsBetweenTurns = stateWrites.get('sidequest.cards')
  await mainTurn($, 'main-2')

  expect(afterFirstTurn).toBe('doing')
  expect(summaryBetweenTurns.split('\n')[0]).toBe(
    "REPO-1's agent is back and its result is not recorded: call mcp__sidequest__finish for REPO-1 now. Nothing else moves it out of doing while your turn lasts.",
  )
  expect(JSON.stringify(cardsBetweenTurns)).toContain('"isReturnedNotRecorded":true')
  expect(status()).toBe('review')
  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain('- 2026-11-16T10:02Z finished done, recorded by the board because finish was not called')
  expect(await summary()).not.toContain('is back and its result is not recorded')
  expect(toasts).toContain('Finished: Retry failed uploads (REPO-1), being checked')
})

test('the now view tells the session to end its turn while an agent runs, and to call finish once it is back, after the part it pastes', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  recordingSpawns(on, [])
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const now = async () => textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: 'now' }))

  let whileRunning = ''
  let afterReturn = ''
  await mainTurn($, 'main-1', async () => {
    await startAndSpawn($)
    whileRunning = await now()
    await agentReturns($, CONTRACT_ANSWER)
    afterReturn = await now()
  })

  expect(whileRunning.split('\n').slice(-2)).toEqual([
    'For the session, not to paste:',
    'Its return comes to you as a new turn: end your turn, do not sleep or read the board again to wait.',
  ])
  expect(afterReturn.split('\n').slice(-2)).toEqual([
    'For the session, not to paste:',
    "REPO-1's agent is back and its result is not recorded: call mcp__sidequest__finish for REPO-1 now. Nothing else moves it out of doing while your turn lasts.",
  ])
})

test('a return an earlier session left unrecorded is moved at session start, and a hand move to done is left alone', async ($, on) => {
  const ticketFile = (id: string, status: string, log: string[]) =>
    ['---', `id: ${id}`, `title: Ticket ${id}`, `status: ${status}`, 'kind: build', 'mode: afk', 'category: build', '---', '', '## Log', ...log, ''].join('\n')
  const asked = ['- 2026-11-15T09:00Z started worker sonnet/medium', '- 2026-11-15T09:20Z returned build run after 20m', '- 2026-11-15T09:20Z needs Pick a backoff.']
  const files = new Map([
    [`${TICKETS}/REPO-1.md`, ticketFile('REPO-1', 'doing', asked)],
    [`${TICKETS}/REPO-2.md`, ticketFile('REPO-2', 'done', ['- 2026-11-15T09:00Z started worker sonnet/medium', '- 2026-11-15T09:20Z returned build run after 20m'])],
    [`${TICKETS}/REPO-3.md`, ticketFile('REPO-3', 'doing', ['- 2026-11-15T09:00Z started worker sonnet/medium'])],
  ])
  const handMoved = files.get(`${TICKETS}/REPO-2.md`)
  standInForEngine(on, files)

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain('status: needs-you')
  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain('- 2026-11-16T10:02Z finished needs-you, recorded by the board because finish was not called')
  expect(files.get(`${TICKETS}/REPO-2.md`)).toBe(handMoved)
  expect(files.get(`${TICKETS}/REPO-3.md`)).toContain('status: doing')
})

test('a spawn naming a ticket runs on the ticket category model and is recorded', async ($, on) => {
  const files = new Map<string, string>()
  const stateWrites = standInForEngine(on, files)
  let seenModel: string | undefined
  on('agent.spawn', (_, e) => {
    seenModel = e.model

    return { model: 'claude-opus-resolved', agentId: 'agent-1' }
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [{ op: 'create', title: 'Untangle the parser', category: 'hard' }])

  const started = await $.agent.spawn(spawnInput({ subagentType: 'sidequest:worker', prompt: 'Ticket REPO-1: Untangle the parser', description: 'REPO-1 parser' }))

  expect(seenModel).toBe('opus')
  expect(started.model).toBe('claude-opus-resolved')
  expect(stateWrites.get('sidequest.runs')).toEqual({
    'agent-1': { ticket: 'REPO-1', category: 'hard', requestedModel: 'opus', model: 'claude-opus-resolved', effort: 'high', toolUseId: 'toolu_1' },
  })
  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain(
    '- 2026-11-16T10:02Z agent agent-1 hard requested opus/high resolved claude-opus-resolved',
  )
})

test('a route tag picks the category without a ticket', async ($, on) => {
  standInForEngine(on, new Map())
  let seenModel: string | undefined
  on('agent.spawn', (_, e) => {
    seenModel = e.model

    return { model: e.model ?? 'inherit', agentId: 'agent-2' }
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  await $.agent.spawn(spawnInput({ subagentType: 'general-purpose', prompt: '[route:debug] find why it hangs', description: 'hang' }))

  expect(seenModel).toBe('opus')
})

// The front door spawns this reader exactly so. A board.json an older version wrote out in full keeps review on the
// deep tier, so only the build route reaches the mid tier on every board with nothing for the person to set.
test('the second reader of work the session built runs on the mid tier and stays off its ticket', async ($, on) => {
  const files = new Map<string, string>()
  const stateWrites = standInForEngine(on, files)
  let seenModel: string | undefined
  on('agent.spawn', (_, e) => {
    seenModel = e.model

    return { model: e.model ?? 'inherit', agentId: 'agent-1' }
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [{ op: 'create', title: 'Track stock per item', status: 'doing' }])

  await $.agent.spawn(
    spawnInput({
      subagentType: 'sidequest:scout',
      prompt: '[route:build] Review the change for REPO-1, uncommitted in the main checkout (git diff). Run it and try to break it.',
      description: 'Second look at REPO-1',
    }),
  )

  expect(files.get(`${ROOT}/.sidequest/board.json`)).toContain('"review": {\n      "tier": "deep"')
  expect(seenModel).toBe('sonnet')
  expect(stateWrites.get('sidequest.runs')).toEqual({
    'agent-1': { category: 'build', requestedModel: 'sonnet', model: 'sonnet', effort: 'medium', toolUseId: 'toolu_1' },
  })
  expect(files.get(`${TICKETS}/REPO-1.md`)).not.toContain('agent agent-1')
})

const recordingSpawns = (on: On, seen: (string | undefined)[]): void => {
  on('agent.spawn', (_, e) => {
    seen.push(e.model)

    return { model: e.model ?? 'fable', agentId: `agent-${seen.length}` }
  })
}

const endMainTurn = ($: Engine) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

test('untagged fan-out runs on the unrouted category and says so once per turn', async ($, on) => {
  const toasts: string[] = []
  const stateWrites = standInForEngine(on, new Map(), toasts)
  const seen: (string | undefined)[] = []
  recordingSpawns(on, seen)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  await $.agent.spawn(spawnInput({ subagentType: 'general-purpose', prompt: 'read the parser', description: 'parser' }))
  await $.agent.spawn(spawnInput({ subagentType: 'sidequest:scout', prompt: 'read the lexer', description: 'lexer' }))
  await $.agent.spawn(spawnInput({ subagentType: 'Explore', prompt: 'look around the repo', description: 'look around' }))
  await $.agent.spawn(spawnInput({ subagentType: 'general-purpose', prompt: 'look', description: 'x', model: 'haiku' }))
  await endMainTurn($)
  await endMainTurn($)

  expect(seen).toEqual(['sonnet', 'sonnet', undefined, 'haiku'])
  expect(Object.keys(stateWrites.get('sidequest.runs') ?? {})).toEqual(['agent-1', 'agent-2'])
  expect(toasts).toEqual([])
})

test('a workflow agent is unrouted fan-out only when its type names no model of its own', async ($, on) => {
  const toasts: string[] = []
  standInForEngine(on, new Map(), toasts)
  const seen: (string | undefined)[] = []
  recordingSpawns(on, seen)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const workflow = { runId: 'wf_1', agentIndex: 1 }

  await $.agent.spawn(spawnInput({ subagentType: 'workflow-subagent', prompt: 'read the parser', description: 'parser', workflow }))
  await $.agent.spawn(spawnInput({ subagentType: 'review-kit:auditor', prompt: 'audit the parser', description: 'audit', workflow }))
  await $.agent.spawn(spawnInput({ subagentType: 'workflow-subagent', prompt: '[route:hard] redesign', description: 'x', workflow }))
  await endMainTurn($)

  expect(seen).toEqual(['sonnet', undefined, 'opus'])
  expect(toasts).toEqual([])
})

test('unrouted set to inherit leaves untagged spawns alone', async ($, on) => {
  const board = JSON.stringify({ settings: { unrouted: 'inherit' } })
  standInForEngine(on, new Map([[`${ROOT}/.sidequest/board.json`, board]]))
  const seen: (string | undefined)[] = []
  recordingSpawns(on, seen)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  await $.agent.spawn(spawnInput({ subagentType: 'general-purpose', prompt: 'read the parser', description: 'parser' }))

  expect(seen).toEqual([undefined])
})

test('a routed spawn that names a model keeps it and is still recorded, and a fork is left alone', async ($, on) => {
  const files = new Map<string, string>()
  const stateWrites = standInForEngine(on, files)
  const seen: (string | undefined)[] = []
  recordingSpawns(on, seen)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [{ op: 'create', title: 'Untangle the parser', category: 'hard' }])

  await $.agent.spawn(spawnInput({ subagentType: 'sidequest:worker', prompt: 'REPO-1 [route:hard] fix it', description: 'fix', model: 'haiku' }))
  await $.agent.spawn(spawnInput({ subagentType: 'fork', prompt: 'REPO-1 [route:hard] fork', description: 'fork', fork: true }))

  expect(seen).toEqual(['haiku', undefined])
  expect(stateWrites.get('sidequest.runs')).toEqual({
    'agent-1': { ticket: 'REPO-1', category: 'hard', requestedModel: 'haiku', model: 'haiku', effort: 'high', toolUseId: 'toolu_1' },
  })
  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain('agent agent-1 hard requested haiku/high resolved haiku')
})

test('an agent type that may name its own model keeps it, even with a ticket ref, and the run says so', async ($, on) => {
  const files = new Map<string, string>()
  const toasts: string[] = []
  const stateWrites = standInForEngine(on, files, toasts)
  const seen: (string | undefined)[] = []
  recordingSpawns(on, seen)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [{ op: 'create', title: 'Untangle the parser', category: 'hard' }])

  await $.agent.spawn(spawnInput({ subagentType: 'statusline-setup', prompt: 'REPO-1 [route:hard] fix it', description: 'fix' }))
  await $.agent.spawn(spawnInput({ subagentType: 'review-kit:auditor', prompt: 'Ticket REPO-1: audit it', description: 'audit' }))
  await $.agent.spawn(spawnInput({ subagentType: 'review-kit:auditor', prompt: 'audit it', description: 'audit' }))
  await endMainTurn($)

  expect(seen).toEqual([undefined, undefined, undefined])
  expect(stateWrites.get('sidequest.runs')).toEqual({
    'agent-1': { ticket: 'REPO-1', category: 'hard', requestedModel: 'none', model: 'fable', effort: 'own', toolUseId: 'toolu_1' },
    'agent-2': { ticket: 'REPO-1', category: 'hard', requestedModel: 'none', model: 'fable', effort: 'own', toolUseId: 'toolu_1' },
  })
  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain(
    'agent agent-1 hard requested none/own resolved fable. agent type statusline-setup may name its own model, so routing left it alone',
  )
  expect(toasts).toEqual([])
})

test('a user agent that reuses a built-in name keeps its own model', async ($, on) => {
  standInForEngine(on, new Map())
  const seen: (string | undefined)[] = []
  recordingSpawns(on, seen)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const userProvided = { plugin: 'user-agents', tier: 'user' as const }

  await $.agent.spawn(spawnInput({ subagentType: 'Explore', prompt: '[route:explore] look', description: 'look', provider: userProvided }))
  await $.agent.spawn(spawnInput({ subagentType: 'Explore', prompt: '[route:research] look', description: 'look' }))

  expect(seen).toEqual([undefined, 'opus'])
})

test('a ticket ref in the middle of a prompt routes nothing and logs nothing', async ($, on) => {
  const files = new Map<string, string>()
  const stateWrites = standInForEngine(on, files)
  const seen: (string | undefined)[] = []
  recordingSpawns(on, seen)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [
    { op: 'create', title: 'Untangle the parser', category: 'hard' },
    { op: 'create', title: 'Rename the lexer', category: 'quick' },
  ])

  await $.agent.spawn(spawnInput({ subagentType: 'Explore', prompt: 'compare REPO-1 and REPO-2', description: 'compare REPO-1' }))

  expect(seen).toEqual([undefined])
  expect(stateWrites.has('sidequest.runs')).toBe(false)
  expect(files.get(`${TICKETS}/REPO-1.md`)).not.toContain('agent agent-')
  expect(files.get(`${TICKETS}/REPO-2.md`)).not.toContain('agent agent-')
})

test('a tag-only spawn on a tier with an unknown model names the fallback in a toast', async ($, on) => {
  const board = JSON.stringify({ tiers: { deep: { model: 'other-model-1', effort: 'high' } } })
  const toasts: string[] = []
  standInForEngine(on, new Map([[`${ROOT}/.sidequest/board.json`, board]]), toasts)
  const seen: (string | undefined)[] = []
  recordingSpawns(on, seen)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  await $.agent.spawn(spawnInput({ subagentType: 'general-purpose', prompt: '[route:debug] find why it hangs', description: 'hang' }))
  await $.agent.spawn(spawnInput({ subagentType: 'general-purpose', prompt: '[route:hard] and why it leaks', description: 'leak' }))
  await endMainTurn($)
  await endMainTurn($)

  expect(seen).toEqual(['sonnet', 'sonnet'])
  expect(toasts).toEqual([
    'An agent ran on a backup model because tier deep names model "other-model-1", which is neither a Claude alias nor listed by a provider file, so it runs on sonnet (no usable fallback is set). /sidequest:setup picks a model you have.',
  ])
})

test('a routed workflow agent runs every step at the tier effort until it ends', async ($, on) => {
  standInForEngine(on, new Map())
  recordingSpawns(on, [])
  const efforts: (string | number | undefined)[] = []
  on('turn.step', async function* (_, e) {
    efforts.push(e.effort)

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const workflow = { runId: 'wf_1', agentIndex: 1 }
  const step = async (agentId: string) => {
    const stream = $.turn.step({ turnId: 't1', index: 0, model: 'sonnet', effort: 'medium', messageCount: 1, agentId })
    while (!(await stream.next()).done);
  }

  await $.agent.spawn(spawnInput({ subagentType: 'general-purpose', prompt: '[route:hard] redesign', description: 'x', workflow }))
  await step('agent-1')
  await step('agent-9')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', agentId: 'agent-1', reason: 'answer' })
  await step('agent-1')

  expect(efforts).toEqual(['high', 'medium', 'medium'])
})

test('parallel creates each get their own id', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const answers = await Promise.all([
    createTickets($, [{ op: 'create', title: 'One' }]),
    createTickets($, [{ op: 'create', title: 'Two' }]),
  ])

  expect(answers.map(textOf)).toEqual([`created REPO-1. ${PREFIX_NOTE}\n${EXCLUDE_NOTICE}`, 'created REPO-2.'])
  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain('title: One')
  expect(files.get(`${TICKETS}/REPO-2.md`)).toContain('title: Two')
})

test('a hand-edited board.json keeps its own keys when a create bumps the counter', async ($, on) => {
  const board = { nextTicket: 4, settings: { unrouted: 'inherit', teamNote: 'keep me' }, tiers: { deep: { model: 'opus' } } }
  const files = new Map([[`${ROOT}/.sidequest/board.json`, JSON.stringify(board)]])
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  await createTickets($, [{ op: 'create', title: 'Four' }])

  expect(JSON.parse(files.get(`${ROOT}/.sidequest/board.json`) ?? '{}')).toEqual({ ...board, nextTicket: 5, nextStory: 1 })
})

test('a hand-edited ticket can still move, and an empty story patch removes the story', async ($, on) => {
  const handEdited = ['---', 'id: SQ-1', 'title: ', 'status: ready', 'kind: build', 'mode: afk', 'category: misc', '---', ''].join('\n')
  const files = new Map([[`${TICKETS}/SQ-1.md`, handEdited]])
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [{ op: 'create', title: 'Two', story: 'ST-1' }])

  const moved = await createTickets($, [{ op: 'move', id: 'SQ-1', status: 'parked' }])
  const cleared = await createTickets($, [{ op: 'patch', id: 'SQ-2', story: '' }])
  const wrong = await createTickets($, [{ op: 'move', id: 'SQ-1', status: 'gone' }])

  expect(textOf(moved)).toBe('moved SQ-1 to parked.')
  expect(textOf(cleared)).toBe('patched SQ-2.')
  expect(files.get(`${TICKETS}/SQ-2.md`)).not.toContain('story:')
  expect(textOf(wrong)).toBe(
    'Nothing changed. SQ-1: status "gone" was not taken, so status stays parked. status takes inbox, ready, doing, review, needs-you, done, parked, dropped.',
  )
})

test('a slip in one field of a batch is repaired or left out, and every ticket in the batch is written', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const answer = await createTickets($, [
    { op: 'create', title: 'Retry failed uploads' },
    { op: 'create', title: 'Show retry count', status: 'blocked' },
    { op: 'create', title: 'Tidy the logs', startedBy: 'session (side work)', kind: ' Research ' },
  ])

  expect(textOf(answer)).toBe(
    [
      'created REPO-1, created REPO-2, created REPO-3.',
      PREFIX_NOTE,
      'REPO-2: status "blocked" was not taken, so status stays ready. status takes inbox, ready, doing, review, needs-you, done, parked, dropped.',
      'REPO-3: kind " Research " was read as "research".',
      'REPO-3: startedBy "session (side work)" was read as "session".',
    ].join(' ') + `\n${EXCLUDE_NOTICE}`,
  )
  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain('title: Retry failed uploads')
  expect(files.get(`${TICKETS}/REPO-2.md`)).toContain('status: ready')
  expect(files.get(`${TICKETS}/REPO-3.md`)).toContain('startedBy: session\n')
  expect(files.get(`${TICKETS}/REPO-3.md`)).toContain('kind: research')
})

test('a move of a ticket not on the board still writes nothing of the batch', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const missingId = await createTickets($, [{ op: 'create', title: 'Fine' }, { op: 'move', id: 'REPO-9', status: 'done' }])

  expect(missingId.deny).toContain('no ticket REPO-9 on this board')
  expect(files.size).toBe(0)
})

const PAYMENT_CHOICE = {
  question: 'Which payment provider do we sign up with?',
  whyNow: 'The checkout page cannot take money until one is picked.',
  options: [
    { label: 'Stripe', gets: 'Cards and wallets on day one', costs: '2.9% of each sale' },
    { label: 'Paddle', gets: 'Sales tax handled for you', costs: '5% of each sale' },
  ],
  recommended: 'Stripe, the cheaper of the two',
  ifUnanswered: 'Checkout stays switched off.',
}

const PAYMENT_SECTION = [
  '## For you',
  'Question: Which payment provider do we sign up with?',
  'Why now: The checkout page cannot take money until one is picked.',
  'Options:',
  '- Stripe: Cards and wallets on day one. Costs: 2.9% of each sale.',
  '- Paddle: Sales tax handled for you. Costs: 5% of each sale.',
  'Recommended: Stripe, the cheaper of the two',
  'If you never answer: Checkout stays switched off.',
].join('\n')

const WHAT_REACHES_THE_PERSON =
  'Keep it waiting only if it cannot be undone, spends money or reaches outside the project, or is taste or product direction only the person has.'

test('a forYou given to the ticket tool is written as the For you section and read back', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const created = await createTickets($, [{ op: 'create', title: 'Pick payments', status: 'needs-you', forYou: PAYMENT_CHOICE }])
  const shown = textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: 'ticket', id: 'REPO-1' }))

  expect(textOf(created).startsWith(`created REPO-1. ${PREFIX_NOTE}\n`)).toBe(true)
  expect(textOf(created)).not.toContain('missing')
  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain(`---\n\n${PAYMENT_SECTION}\n\n## What`)
  expect(shown).toContain(PAYMENT_SECTION)
})

test('a hand-written For you section survives a patch, and a forYou patch changes only the parts it gives', async ($, on) => {
  const handWritten = [
    '---',
    'id: REPO-1',
    'title: Pick payments',
    'status: needs-you',
    'kind: decision',
    'mode: afk',
    'category: build',
    '---',
    '',
    '## What',
    'Checkout takes money.',
    '',
    PAYMENT_SECTION,
    '',
  ].join('\n')
  const files = new Map([[`${TICKETS}/REPO-1.md`, handWritten]])
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  await createTickets($, [{ op: 'patch', id: 'REPO-1', title: 'Choose a payment provider' }])
  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain(PAYMENT_SECTION)

  await createTickets($, [{ op: 'patch', id: 'REPO-1', forYou: { recommended: 'Paddle, so tax is never our problem' } }])
  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain(
    PAYMENT_SECTION.replace('Recommended: Stripe, the cheaper of the two', 'Recommended: Paddle, so tax is never our problem'),
  )
})

test('a ticket that starts waiting on the person without a full For you section is written, and the answer says the rule and what is missing', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [{ op: 'create', title: 'Pick payments' }, { op: 'create', title: 'Pick a font' }])

  const moved = await createTickets($, [
    { op: 'move', id: 'REPO-1', status: 'needs-you' },
    { op: 'patch', id: 'REPO-2', status: 'needs-you', forYou: { question: 'Which font should the site use?', options: [{ label: 'Inter' }] } },
  ])
  const complete = await createTickets($, [{ op: 'create', title: 'Pick a provider', mode: 'hitl', forYou: PAYMENT_CHOICE }])
  const noted = await createTickets($, [{ op: 'note', id: 'REPO-1', text: 'still waiting' }])

  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain('status: needs-you')
  expect(files.get(`${TICKETS}/REPO-2.md`)).toContain('status: needs-you')
  expect(textOf(moved)).toContain(WHAT_REACHES_THE_PERSON)
  expect(textOf(moved)).toContain('Otherwise take the recommended answer now, note on the ticket what you chose and how to undo it, and move the ticket on.')
  expect(textOf(moved)).toContain(
    'REPO-1 For you section is missing: Question (question), Why now (whyNow), Options (options), Recommended (recommended), If you never answer (ifUnanswered).',
  )
  expect(textOf(moved)).toContain(
    'REPO-2 For you section is missing: Why now (whyNow), Recommended (recommended), If you never answer (ifUnanswered), what "Inter" gets and what it costs.',
  )
  expect(textOf(complete)).toContain(WHAT_REACHES_THE_PERSON)
  expect(textOf(complete)).not.toContain('REPO-3 For you section is missing')
  expect(textOf(noted)).toBe('noted REPO-1.')
})

test('finish that sends a ticket to needs-you carries the rule and the missing parts', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [{ op: 'create', title: 'Try it' }])

  const answer = await $.tool.call({ tool: 'mcp__sidequest__finish', id: 'REPO-1', outcome: 'needs-you', result: 'Two libraries fit.' })

  expect(textOf(answer)).toContain(WHAT_REACHES_THE_PERSON)
  expect(textOf(answer)).toContain('REPO-1 For you section is missing: Question (question)')
})

test('the waiting view lists what waits on the person most blocking first, ready to paste', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [
    {
      op: 'create',
      title: 'Check the phone layout',
      mode: 'hitl',
      forYou: {
        question: 'Does the sign-up page look right on your phone?',
        whyNow: 'The launch post links to it.',
        ifUnanswered: 'It launches as it is.',
        steps: 'Open the staging site on your phone.\nLook for buttons cut off at the right edge.',
      },
    },
    { op: 'create', title: 'Pick payments', status: 'needs-you', forYou: PAYMENT_CHOICE },
    { op: 'create', title: 'Pick a backoff', status: 'needs-you' },
    { op: 'create', title: 'Build checkout', blockedBy: ['REPO-2'] },
    { op: 'create', title: 'Send receipts', blockedBy: ['REPO-4'] },
    { op: 'create', title: 'Launch post', blockedBy: ['REPO-1'] },
  ])

  const waiting = textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: 'waiting' }))
  const summary = textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: 'summary' }))

  expect(waiting).toBe(
    [
      'Waiting on you, most blocking first:',
      '',
      '1. Which payment provider do we sign up with?',
      '   Why now: The checkout page cannot take money until one is picked.',
      '   A. Stripe: Cards and wallets on day one. Costs: 2.9% of each sale.',
      '   B. Paddle: Sales tax handled for you. Costs: 5% of each sale.',
      '   Recommended: A (Stripe, the cheaper of the two)',
      '   If you never answer: Checkout stays switched off.',
      '   To answer: 1 and a letter, like 1A. Ticket REPO-2.',
      '',
      '2. Does the sign-up page look right on your phone?',
      '   Why now: The launch post links to it.',
      '   If you never answer: It launches as it is.',
      '   Steps: Open the staging site on your phone.',
      '   Look for buttons cut off at the right edge.',
      '   To answer: 2 done, or 2 and what you found. Ticket REPO-1.',
      '',
      'For the session, not to paste: waiting, not yet written for a cold read: REPO-3 (Pick a backoff). Patch each with forYou.',
    ].join('\n'),
  )
  expect(summary).toContain('The waiting view writes what waits on the person, ready to pass on.')
})

test('a ticket carries the branch it was created on and a tracker key, and the board says when the checkout moved on', async ($, on) => {
  const files = new Map([[`${ROOT}/.git/HEAD`, 'ref: refs/heads/bugfix/PAY-41-retry\n']])
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [
    { op: 'create', title: 'Retry failed payments' },
    { op: 'create', title: 'OPS-7 Rotate the keys' },
    { op: 'create', title: 'Pick payments', status: 'needs-you', forYou: PAYMENT_CHOICE },
    { op: 'create', title: 'Tidy the logs', branch: '' },
  ])
  const view = async (input: Record<string, unknown>) => textOf(await $.tool.call({ tool: 'mcp__sidequest__board', ...input }))

  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain('branch: bugfix/PAY-41-retry\nissue: PAY-41\n')
  expect(files.get(`${TICKETS}/REPO-4.md`)).not.toContain('branch:')
  expect(await view({ view: 'list', status: 'ready' })).toBe(
    [
      'PAY-41 REPO-1 (branch bugfix/PAY-41-retry) ready build Retry failed payments',
      'OPS-7 REPO-2 (branch bugfix/PAY-41-retry) ready build OPS-7 Rotate the keys',
      'REPO-4 ready build Tidy the logs',
    ].join('\n'),
  )
  expect(await view({ view: 'waiting' })).toContain('   To answer: a letter, like A. Ticket PAY-41 REPO-3 (branch bugfix/PAY-41-retry).')

  files.set(`${ROOT}/.git/HEAD`, 'ref: refs/heads/main\n')
  await createTickets($, [
    { op: 'move', id: 'REPO-1', status: 'doing' },
    { op: 'patch', id: 'REPO-2', issue: 'OPS-8' },
  ])
  const summary = await view({ view: 'summary' })

  expect(summary).toContain('\nPAY-41 REPO-1 belongs to branch bugfix/PAY-41-retry, but the checkout is on main.')
  expect(summary).toContain('\nPAY-41 REPO-3 belongs to branch bugfix/PAY-41-retry, but the checkout is on main.')
  expect(summary).toContain('\nOPS-8 REPO-2 belongs to branch bugfix/PAY-41-retry, but the checkout is on main.')
  expect(files.get(`${TICKETS}/REPO-2.md`)).toContain('issue: OPS-8')
})

test('more than three open tickets on another branch are named in one line', () => {
  const onBranch = (id: string): Ticket => ({ ...newTicket(id, { title: 'Import orders' }, '2026-11-18T10:00Z'), status: 'ready', branch: 'feature/import' })
  const lines = otherBranchLines(['REPO-1', 'REPO-2', 'REPO-3', 'REPO-4'].map(onBranch), 'main')

  expect(lines).toEqual([
    '4 open tickets belong to another branch than main, the one checked out: REPO-1 on feature/import, REPO-2 on feature/import, REPO-3 on feature/import, REPO-4 on feature/import.',
  ])
})

test('a ticket the session opened on its own says so in the ticket view and the list', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  await createTickets($, [{ op: 'create', title: 'Clean up the retry helper', startedBy: 'session' }, { op: 'create', title: 'Asked for' }])
  const notTaken = await createTickets($, [{ op: 'patch', id: 'REPO-2', startedBy: 'someone' }])
  const ticketView = textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: 'ticket', id: 'REPO-1' }))
  const list = textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: 'list' }))

  expect(ticketView.startsWith('REPO-1 (started by the session)\n---\n')).toBe(true)
  expect(list).toBe('REPO-1 (started by the session) ready build Clean up the retry helper\nREPO-2 ready build Asked for')
  expect(textOf(notTaken)).toBe(
    'patched REPO-2. REPO-2: startedBy "someone" was not taken, so startedBy is left out. startedBy takes session, or leave it out when the person asked for the work.',
  )
})

test('parking a ticket whose For you section is complete answers with the rule and its block for the chat, numbered as the waiting view numbers it, without why now or if you never answer', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [
    { op: 'create', title: 'Pick a font', mode: 'hitl', forYou: { question: 'Which font?', whyNow: 'Launch.', ifUnanswered: 'Inter.', steps: 'Look at both.' } },
    { op: 'create', title: 'Pick payments', forYou: PAYMENT_CHOICE },
    { op: 'create', title: 'Launch', blockedBy: ['REPO-1'] },
  ])

  const moved = textOf(await createTickets($, [{ op: 'move', id: 'REPO-2', status: 'needs-you' }]))
  const waiting = textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: 'waiting' }))
  const chatBlock = [
    '2. Which payment provider do we sign up with?',
    '   A. Stripe: Cards and wallets on day one. Costs: 2.9% of each sale.',
    '   B. Paddle: Sales tax handled for you. Costs: 5% of each sale.',
    '   Recommended: A (Stripe, the cheaper of the two)',
    '   To answer: 2 and a letter, like 2A. Ticket REPO-2.',
  ].join('\n')
  const coldReadBlock = [
    '2. Which payment provider do we sign up with?',
    '   Why now: The checkout page cannot take money until one is picked.',
    '   A. Stripe: Cards and wallets on day one. Costs: 2.9% of each sale.',
    '   B. Paddle: Sales tax handled for you. Costs: 5% of each sale.',
    '   Recommended: A (Stripe, the cheaper of the two)',
    '   If you never answer: Checkout stays switched off.',
    '   To answer: 2 and a letter, like 2A. Ticket REPO-2.',
  ].join('\n')

  expect(moved).toBe(
    [
      'moved REPO-2 to needs-you.',
      'Keep it waiting only if it cannot be undone, spends money or reaches outside the project, or is taste or product direction only the person has. Otherwise take the recommended answer now, note on the ticket what you chose and how to undo it, and move the ticket on.',
      'Show the person this as it is:',
      chatBlock,
    ].join('\n'),
  )
  expect(waiting).toContain(coldReadBlock)
})

const COMMIT_QUESTION = {
  question: 'Commit, push and open the pull request?',
  whyNow: 'The project asks before every commit and push.',
  options: [
    { label: 'Commit, push, open the pull request', gets: 'The team can review it today', costs: 'The team is notified at once' },
    { label: 'Commit only', gets: 'Nothing leaves this machine', costs: 'You ask again for the push' },
  ],
  recommended: 'A',
  ifUnanswered: 'Nothing is committed.',
  alsoYours: [
    { what: 'Move the issue to In review', doneByDefault: 'it stays in To do' },
    { what: 'Add a diagram to the pull request', doneByDefault: 'no diagram' },
    { what: 'Fix the 500 on a null body as its own piece of work', doneByDefault: 'it stays noted' },
  ],
}

test('one waiting question prints with no number, lettered answers and numbered extras, and the chat block leaves out why now and if you never answer', async ($, on) => {
  standInForEngine(on, new Map<string, string>())
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [{ op: 'create', title: 'Ship the search change', forYou: COMMIT_QUESTION }])

  const moved = textOf(await createTickets($, [{ op: 'move', id: 'REPO-1', status: 'needs-you' }]))
  const waiting = textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: 'waiting' }))
  const answersAndExtras = [
    '   A. Commit, push, open the pull request: The team can review it today. Costs: The team is notified at once.',
    '   B. Commit only: Nothing leaves this machine. Costs: You ask again for the push.',
    '   Recommended: A',
  ]
  const extras = [
    '   Also yours, say which to do too:',
    '   1. Move the issue to In review (if you say nothing: it stays in To do)',
    '   2. Add a diagram to the pull request (if you say nothing: no diagram)',
    '   3. Fix the 500 on a null body as its own piece of work (if you say nothing: it stays noted)',
    '   To answer: a letter, like A, plus any extras to do too, like A, plus 1 and 2. Ticket REPO-1.',
  ]

  expect(moved.slice(moved.indexOf('Show the person this as it is:\n') + 'Show the person this as it is:\n'.length)).toBe(
    ['Commit, push and open the pull request?', ...answersAndExtras, ...extras].join('\n'),
  )
  expect(waiting).toContain(
    ['Commit, push and open the pull request?', '   Why now: The project asks before every commit and push.', ...answersAndExtras, '   If you never answer: Nothing is committed.', ...extras].join('\n'),
  )
})

test('with several waiting questions each keeps its number and its extras carry it too, so no answer reads two ways', async ($, on) => {
  standInForEngine(on, new Map<string, string>())
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [
    { op: 'create', title: 'Pick payments', status: 'needs-you', forYou: PAYMENT_CHOICE },
    { op: 'create', title: 'Ship the search change', status: 'needs-you', forYou: COMMIT_QUESTION },
  ])

  const waiting = textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: 'waiting' }))

  expect(waiting).toContain('\n\n2. Commit, push and open the pull request?\n')
  expect(waiting).toContain('   2.1. Move the issue to In review (if you say nothing: it stays in To do)')
  expect(waiting).toContain('   To answer: 2 and a letter, like 2A, plus any extras to do too, like 2A, plus 2.1 and 2.2. Ticket REPO-2.')
})

type AgentCallArgs = { prompt: string; description: string; subagent_type?: string; effort?: EffortLevel }

// The engine raises agent.spawn while the Agent tool runs, with the call's id, and the agent's loop asks at the call's
// effort when it named one.
const standInForAgentTool = ($: Engine, on: On, callsSeen: AgentCallArgs[]): void => {
  on('tool.call', { tool: 'Agent' }, async (_, e) => {
    const { prompt, description, subagent_type, effort } = e
    callsSeen.push({ prompt, description, ...(subagent_type ? { subagent_type } : {}), ...(effort ? { effort } : {}) })
    const subagentType = subagent_type ?? 'general-purpose'
    await $.agent.spawn(spawnInput({ subagentType, prompt, description, tool_use_id: e.tool_use_id }))

    return { result: {} }
  })
}

const recordingStepEfforts = (on: On, efforts: (string | number | undefined)[]): void => {
  on('turn.step', async function* (_, e) {
    efforts.push(e.effort)

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
  })
}

const stepEachAgent = async ($: Engine, loopEfforts: Record<string, EffortLevel>): Promise<void> => {
  for (const [agentId, effort] of Object.entries(loopEfforts)) {
    const stream = $.turn.step({ turnId: 't1', index: 0, model: 'sonnet', effort, messageCount: 1, agentId })
    while (!(await stream.next()).done);
  }
}

test('a routed Agent call reaches the tool unchanged and its agent asks at the tier effort only when the call names none', async ($, on) => {
  standInForEngine(on, new Map())
  recordingSpawns(on, [])
  const callsSeen: AgentCallArgs[] = []
  standInForAgentTool($, on, callsSeen)
  const efforts: (string | number | undefined)[] = []
  recordingStepEfforts(on, efforts)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const calls: AgentCallArgs[] = [
    { prompt: '[route:hard] redesign it', description: 'redesign' },
    { prompt: '[route:hard] redesign it', description: 'redesign', effort: 'low' },
    { prompt: 'plain work', description: 'plain', subagent_type: 'Explore' },
    { prompt: 'plain work', description: 'plain' },
  ]

  for (const call of calls) await $.tool.call({ tool: 'Agent', ...call })
  await stepEachAgent($, { 'agent-1': 'medium', 'agent-2': 'low', 'agent-3': 'medium', 'agent-4': 'low' })

  expect(callsSeen).toEqual(calls)
  expect(efforts).toEqual(['high', 'low', 'medium', 'medium'])
})

test('a routed Agent call keeps its loop effort while the environment pins one', async ($, on) => {
  standInForEngine(on, new Map(), [], { HOME: '/home', CLAUDE_CODE_EFFORT_LEVEL: 'low' })
  recordingSpawns(on, [])
  const callsSeen: AgentCallArgs[] = []
  standInForAgentTool($, on, callsSeen)
  const efforts: (string | number | undefined)[] = []
  recordingStepEfforts(on, efforts)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: 'Agent', prompt: '[route:hard] redesign it', description: 'redesign' })
  await stepEachAgent($, { 'agent-1': 'low' })

  expect(callsSeen).toEqual([{ prompt: '[route:hard] redesign it', description: 'redesign' }])
  expect(efforts).toEqual(['low'])
})

test('a routed workflow agent keeps its loop effort while the environment pins one', async ($, on) => {
  standInForEngine(on, new Map(), [], { HOME: '/home', CLAUDE_CODE_EFFORT_LEVEL: 'low' })
  recordingSpawns(on, [])
  const efforts: (string | number | undefined)[] = []
  on('turn.step', async function* (_, e) {
    efforts.push(e.effort)

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
  })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  await $.agent.spawn(spawnInput({ subagentType: 'general-purpose', prompt: '[route:hard] redesign', description: 'x', workflow: { runId: 'wf_1', agentIndex: 1 } }))
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'opus', effort: 'low', messageCount: 1, agentId: 'agent-1' })
  while (!(await stream.next()).done);

  expect(efforts).toEqual(['low'])
})

const RELOAD_THE_SKILL =
  "Load the sidequest:sidequest skill again before you go on with the person's request, its rules did not survive the compaction."

const AFTER_COMPACTION_LINE = `Sidequest: this conversation was just compacted. The board work this conversation touched: story REPO-S1 (Uploads) is in flight, 1 doing, 1 ready. ${RELOAD_THE_SKILL}`

const FIRST_PROMPT_LINE =
  'Sidequest: this project has a board with open tickets. They record earlier work and are not a request: do what the person asks. When that is work on the board (a ticket they name, or carrying on with it), load the sidequest:sidequest skill first, plan, call mcp__sidequest__start for each ticket they asked for, and let the routed agents do the building. For any other request to change, fix, build or look into something, load the sidequest:sidequest skill first and plan before doing the work.'

const EMPTY_BOARD_LINE =
  'Sidequest: for a request to change, fix, build or look into something, load the sidequest:sidequest skill first and say your plan before the first edit. A small change too. Only reading back what is already there (a file, a log, an earlier session) needs neither.'

const SUMMARY_ONLY = [{ role: 'user' as const, text: 'Summary of the conversation so far.', toolUses: [] }]

const sessionIdentity = { id: 'session-1' }

const recordingPromptContexts = (on: On): (readonly string[] | undefined)[] => {
  const contexts: (readonly string[] | undefined)[] = []
  sessionIdentity.id = 'session-1'
  on('session.id', () => ({ value: sessionIdentity.id }))
  on('prompt.submit', (_, e) => {
    contexts.push(e.context)

    return { text: e.text }
  })
  on('session.compact', () => ({ messages: SUMMARY_ONLY }))

  return contexts
}

const typePrompt = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

test('after a compaction with a ticket in doing the next prompt carries one line, and the one after carries nothing', async ($, on) => {
  standInForEngine(on, new Map())
  const contexts = recordingPromptContexts(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [
    { op: 'story', title: 'Uploads', destination: 'Uploads survive.' },
    { op: 'create', title: 'Retry failed uploads', story: 'REPO-S1' },
    { op: 'create', title: 'Show retry count' },
  ])
  await $.tool.call({ tool: 'mcp__sidequest__start', id: 'REPO-1' })
  await typePrompt($, 'before any compaction')

  await $.session.compact({ trigger: 'auto', messages: SUMMARY_ONLY })
  await typePrompt($, 'carry on')
  await typePrompt($, 'and then')

  expect(contexts).toEqual([[FIRST_PROMPT_LINE], [AFTER_COMPACTION_LINE], undefined])
})

const lastWeeksTicket = (id: string, status: string): string =>
  ['---', `id: ${id}`, `title: Ticket ${id}`, `status: ${status}`, 'kind: build', 'mode: afk', 'category: build', '---', ''].join('\n')

test('after a compaction the line counts only the tickets this session wrote or started, and never says to carry on', async ($, on) => {
  const files = new Map([
    [`${TICKETS}/REPO-1.md`, lastWeeksTicket('REPO-1', 'doing')],
    [`${TICKETS}/REPO-2.md`, lastWeeksTicket('REPO-2', 'ready')],
  ])
  standInForEngine(on, files)
  const contexts = recordingPromptContexts(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await typePrompt($, 'file the upload retry')
  await createTickets($, [{ op: 'create', title: 'Retry failed uploads' }])

  await $.session.compact({ trigger: 'auto', messages: SUMMARY_ONLY })
  await typePrompt($, 'and the next thing')

  const line = contexts[1]?.[0] ?? ''
  expect(line).toBe(`Sidequest: this conversation was just compacted. The board work this conversation touched: 1 ready. ${RELOAD_THE_SKILL}`)
  expect(line).not.toContain('carry on')
})

test('after a compaction with no ticket this session touched the line names no counts', async ($, on) => {
  const files = new Map([[`${TICKETS}/REPO-1.md`, lastWeeksTicket('REPO-1', 'doing')]])
  standInForEngine(on, files)
  const contexts = recordingPromptContexts(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await typePrompt($, 'what is the weather like')

  await $.session.compact({ trigger: 'auto', messages: SUMMARY_ONLY })
  await typePrompt($, 'and then')

  expect(contexts[1]).toEqual([`Sidequest: this conversation was just compacted. ${RELOAD_THE_SKILL}`])
})

test('after untagged agents were rerouted the next prompt carries one line, and a prompt after a quiet turn carries nothing', async ($, on) => {
  standInForEngine(on, new Map())
  const contexts = recordingPromptContexts(on)
  recordingSpawns(on, [])
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await typePrompt($, 'first prompt')

  await $.agent.spawn(spawnInput({ subagentType: 'general-purpose', prompt: 'read the parser', description: 'parser' }))
  await endMainTurn($)
  await typePrompt($, 'what did it find')
  await endMainTurn($)
  await typePrompt($, 'and then')

  expect(contexts.slice(1)).toEqual([
    [
      "Sidequest: 1 untagged agent ran on sonnet, the build route. Start an agent's prompt with [route:<category>] to pick another.",
    ],
    undefined,
  ])
})

test('a compaction over an empty board, a subagent compacting and a precompute add no line after the first prompt', async ($, on) => {
  standInForEngine(on, new Map())
  const contexts = recordingPromptContexts(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  await $.session.compact({ trigger: 'manual', messages: SUMMARY_ONLY })
  await typePrompt($, 'empty board')
  await createTickets($, [{ op: 'create', title: 'Retry failed uploads' }])
  await $.session.compact({ trigger: 'auto', agentId: 'agent-1', messages: SUMMARY_ONLY })
  await $.session.compact({ trigger: 'precompute', messages: SUMMARY_ONLY })
  await typePrompt($, 'work on the board, but the main conversation was not compacted')

  expect(contexts).toEqual([[EMPTY_BOARD_LINE], undefined])
})

test('a second prompt on an empty board carries nothing', async ($, on) => {
  standInForEngine(on, new Map())
  const contexts = recordingPromptContexts(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  await typePrompt($, 'build a word counter')
  await typePrompt($, 'and then')

  expect(contexts).toEqual([[EMPTY_BOARD_LINE], undefined])
})

test('a session on a board with an open ticket carries the line on its first prompt only', async ($, on) => {
  standInForEngine(on, new Map())
  const contexts = recordingPromptContexts(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [{ op: 'create', title: 'Retry failed uploads' }])

  await typePrompt($, 'build REPO-1')
  await typePrompt($, 'and then')

  expect(contexts).toEqual([[FIRST_PROMPT_LINE], undefined])
})

test('a second session.start in the same session adds no second line, and a new session id without one adds a line', async ($, on) => {
  standInForEngine(on, new Map())
  const contexts = recordingPromptContexts(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [{ op: 'create', title: 'Retry failed uploads' }])
  await typePrompt($, 'build REPO-1')

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await typePrompt($, 'after a plugin reload')
  sessionIdentity.id = 'session-2'
  await typePrompt($, 'after a clear')

  expect(contexts).toEqual([[FIRST_PROMPT_LINE], undefined, [FIRST_PROMPT_LINE]])
})

test('a compaction before the first prompt over a board with no work in flight still leaves the first-prompt line', async ($, on) => {
  standInForEngine(on, new Map())
  const contexts = recordingPromptContexts(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [{ op: 'create', title: 'Retry failed uploads', status: 'inbox' }])
  await $.session.compact({ trigger: 'manual', messages: SUMMARY_ONLY })

  await typePrompt($, 'first prompt after the compaction')

  expect(contexts).toEqual([[EMPTY_BOARD_LINE]])
})

test('an empty board, and a board with only done, parked and inbox tickets, carry the front-door line on the first prompt', async ($, on) => {
  standInForEngine(on, new Map())
  const contexts = recordingPromptContexts(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await typePrompt($, 'empty board')
  sessionIdentity.id = 'session-2'
  await createTickets($, [
    { op: 'create', title: 'Finished work', status: 'done' },
    { op: 'create', title: 'Set aside work', status: 'parked' },
    { op: 'create', title: 'Spotted in passing', status: 'inbox' },
  ])
  await typePrompt($, 'no work in flight')

  expect(contexts).toEqual([[EMPTY_BOARD_LINE], [EMPTY_BOARD_LINE]])
})

test('one ticket that waits on the person makes the first prompt carry the line for a board with open tickets', async ($, on) => {
  const files = new Map([
    [`${TICKETS}/REPO-1.md`, lastWeeksTicket('REPO-1', 'done')],
    [`${TICKETS}/REPO-2.md`, lastWeeksTicket('REPO-2', 'needs-you')],
  ])
  standInForEngine(on, files)
  const contexts = recordingPromptContexts(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  await typePrompt($, 'first prompt')

  expect(contexts).toEqual([[FIRST_PROMPT_LINE]])
})

const NOBODY_TYPED_LINE =
  'Sidequest: nobody typed this turn, a background task finished. Report what finished, and continue only what it unblocks inside the plan the person started. Parked tickets, the inbox and a stopped plan wait for the person.'

const backgroundTaskFinished = ($: Engine, runningTurnId?: string) =>
  $.prompt.submit({
    text: '<task-notification>the build finished</task-notification>',
    wait: false,
    origin: { kind: 'task-notification' },
    ...(runningTurnId === undefined ? {} : { turnId: runningTurnId }),
  })

const recordingNotifications = (on: On): string[] => {
  const notifications: string[] = []
  on('ui.notify', (_, e) => {
    notifications.push(e.text)

    return { value: { isSent: true, channel: 'client' } }
  })

  return notifications
}

const logOf = (files: Map<string, string>, id: string): string => files.get(`${TICKETS}/${id}.md`)?.split('## Log')[1] ?? ''

test('a parked ticket moved to ready in a typed turn logs the words the person typed', async ($, on) => {
  const files = new Map([[`${TICKETS}/REPO-1.md`, lastWeeksTicket('REPO-1', 'parked')]])
  const toasts: string[] = []
  standInForEngine(on, files, toasts)
  recordingPromptContexts(on)
  const notifications = recordingNotifications(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  await typePrompt($, 'the upload fix is merged,\nso go ahead with REPO-1 now')
  await createTickets($, [{ op: 'move', id: 'REPO-1', status: 'ready' }])

  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain('status: ready')
  expect(logOf(files, 'REPO-1')).toContain(
    `- 2026-11-16T10:02Z taken out of parked on the person's words: "the upload fix is merged, so go ahead with REPO-1 now"`,
  )
  expect(toasts).toEqual([])
  expect(notifications).toEqual([])
})

test('a parked ticket moved in a turn a finished background task started still moves, says nobody typed it and tells the person once', async ($, on) => {
  const files = new Map([[`${TICKETS}/REPO-1.md`, lastWeeksTicket('REPO-1', 'parked')]])
  const toasts: string[] = []
  standInForEngine(on, files, toasts)
  recordingPromptContexts(on)
  const notifications = recordingNotifications(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await typePrompt($, 'run the build in the background')

  await backgroundTaskFinished($)
  const answer = await createTickets($, [{ op: 'move', id: 'REPO-1', status: 'ready' }])

  expect(textOf(answer)).toBe('moved REPO-1 to ready.')
  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain('status: ready')
  expect(logOf(files, 'REPO-1')).toContain('taken out of parked in a turn nobody typed, which a finished background task started')
  expect(logOf(files, 'REPO-1')).not.toContain("person's words")
  const notice = 'REPO-1 started on its own after a background task finished, not by you. To undo, open it on the board and press Set aside.'
  expect(toasts).toEqual([notice])
  expect(notifications).toEqual([notice])
})

test('an inbox ticket started in a turn nobody typed is started, logged and named to the person', async ($, on) => {
  const files = new Map([[`${TICKETS}/REPO-1.md`, lastWeeksTicket('REPO-1', 'inbox')]])
  const toasts: string[] = []
  standInForEngine(on, files, toasts)
  recordingPromptContexts(on)
  recordingNotifications(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  await backgroundTaskFinished($)
  const started = await $.tool.call({ tool: 'mcp__sidequest__start', id: 'REPO-1' })

  expect(textOf(started)).toContain('REPO-1 is now doing.')
  expect(logOf(files, 'REPO-1')).toContain('taken out of inbox in a turn nobody typed')
  expect(toasts).toHaveLength(1)
})

test('the line for a turn nobody typed rides only a turn a finished background task started in an interactive session', async ($, on) => {
  standInForEngine(on, new Map())
  const contexts = recordingPromptContexts(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await typePrompt($, 'run the build in the background')

  await typePrompt($, 'a typed turn')
  await backgroundTaskFinished($, 'turn-the-person-typed')
  await $.prompt.submit({ text: 'check the build', wait: false, origin: { kind: 'scheduled-trigger' }, isMeta: true })
  await backgroundTaskFinished($)

  expect(contexts.slice(1)).toEqual([undefined, undefined, undefined, [NOBODY_TYPED_LINE]])
})

test('a headless session gets no line for a turn nobody typed', async ($, on) => {
  standInForEngine(on, new Map())
  const contexts = recordingPromptContexts(on)
  await $.session.start({ cwd: ROOT, surface: null, isInteractive: false })
  await $.prompt.submit({ text: 'build the thing', wait: false, origin: { kind: 'sdk' } })

  await backgroundTaskFinished($)

  expect(contexts[1]).toBeUndefined()
})

test('stop with a story parks its unstarted tickets with the turn words and leaves the running one alone', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  recordingPromptContexts(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [
    { op: 'story', title: 'Uploads', destination: 'Uploads survive.' },
    { op: 'create', title: 'Retry failed uploads', story: 'REPO-S1' },
    { op: 'create', title: 'Show retry count', story: 'REPO-S1' },
    { op: 'create', title: 'Note the retries', story: 'REPO-S1', status: 'inbox' },
    { op: 'create', title: 'Unrelated', status: 'ready' },
  ])
  await $.tool.call({ tool: 'mcp__sidequest__start', id: 'REPO-1' })

  await typePrompt($, 'stop, do the login page instead')
  const answer = await createTickets($, [{ op: 'stop', story: 'REPO-S1' }])

  expect(textOf(answer)).toBe('parked REPO-2, parked REPO-3. Still running, left to finish and report: REPO-1.')
  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain('status: doing')
  expect(files.get(`${TICKETS}/REPO-4.md`)).toContain('status: ready')
  for (const id of ['REPO-2', 'REPO-3']) {
    expect(files.get(`${TICKETS}/${id}.md`)).toContain('status: parked')
    expect(logOf(files, id)).toContain(`parked by a stop on the person's words: "stop, do the login page instead"`)
  }
})

test('stop with no story parks only the unstarted tickets this session created', async ($, on) => {
  const files = new Map([[`${TICKETS}/SQ-1.md`, lastWeeksTicket('SQ-1', 'ready')]])
  standInForEngine(on, files)
  recordingPromptContexts(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [{ op: 'create', title: 'Retry failed uploads' }])

  await typePrompt($, 'never mind, stop')
  const answer = await createTickets($, [{ op: 'stop' }])

  expect(textOf(answer)).toBe('parked SQ-2. Nothing in it is running.')
  expect(files.get(`${TICKETS}/SQ-1.md`)).toContain('status: ready')
  expect(files.get(`${TICKETS}/SQ-2.md`)).toContain('status: parked')
})

test('a board.json that does not parse is named in the routing view and the summary', async ($, on) => {
  standInForEngine(on, new Map([[`${ROOT}/.sidequest/board.json`, '{ "tiers": ']]))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const view = async (name: string) => textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: name }))

  expect(await view('routing')).toContain('board.json problem: the file is not valid JSON (')
  expect(await view('summary')).toContain('board.json problem: the file is not valid JSON')
})

test('the planning view answers the routing view, the stories and the open tickets in one read', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const view = async (name: string) => textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: name }))
  await createTickets($, [
    { op: 'story', title: 'Uploads', destination: 'Uploads survive a flaky network.' },
    { op: 'create', title: 'Retry failed uploads', story: 'REPO-S1' },
    { op: 'create', title: 'Already shipped' },
    { op: 'create', title: 'Let go' },
  ])
  await createTickets($, [{ op: 'status', id: 'REPO-2', status: 'done' }, { op: 'status', id: 'REPO-3', status: 'dropped' }])

  const planning = await view('planning')

  expect(planning.startsWith(await view('routing'))).toBe(true)
  expect(planning).toContain('\nstories:\nREPO-S1 Uploads (1 ticket)\nopen tickets:\nREPO-1 ')
  expect(planning).not.toContain('REPO-3 dropped')
  expect(planning.endsWith('1 done and 1 dropped left out: list with a status to see them')).toBe(true)
})

test('a board.json that does not parse is named once in the planning view', async ($, on) => {
  standInForEngine(on, new Map([[`${ROOT}/.sidequest/board.json`, '{ "tiers": ']]))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const planning = textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: 'planning' }))

  expect(planning.split('board.json problem:')).toHaveLength(2)
  expect(planning).toContain('No open tickets.')
})

test('a tier with no effort is named in the routing view', async ($, on) => {
  const board = JSON.stringify({ tiers: { turbo: { model: 'opus' } } })
  standInForEngine(on, new Map([[`${ROOT}/.sidequest/board.json`, board]]))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const routing = textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: 'routing' }))

  expect(routing).toContain('tier "turbo" needs a model and an effort, so it is ignored.')
})

test('the beforeBuilding setting is one routing line after checks, and Read back says not set without it', async ($, on) => {
  const step = { label: 'plan of action', how: 'write it\nin docs/plans/' }
  standInForEngine(on, boardWith({ checks: CHECKS_TEXT, beforeBuilding: { ...step, readBack: 'read the file\nagain' } }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const lines = textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: 'routing' })).split('\n')
  const checksIndex = lines.findIndex(line => line.startsWith('checks: '))

  expect(lines[checksIndex + 1]).toBe('before building: plan of action. How: write it in docs/plans/. Read back: read the file again')
  expect(lines.join('\n')).not.toContain('"beforeBuilding"')
})

test('without readBack the beforeBuilding line says Read back: not set', async ($, on) => {
  standInForEngine(on, boardWith({ beforeBuilding: { label: 'design note', how: 'write one' } }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const routing = textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: 'routing' }))

  expect(routing).toContain('before building: design note. How: write one. Read back: not set')
})

test('a board without beforeBuilding prints no line that mentions it', async ($, on) => {
  standInForEngine(on, boardWith({ checks: CHECKS_TEXT }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const routing = textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: 'routing' }))

  expect(routing.toLowerCase()).not.toContain('before building')
  expect(routing.toLowerCase()).not.toContain('beforebuilding')
})

const problemWith = async ($: Engine, on: On, wrong: unknown) => {
  standInForEngine(on, boardWith({ beforeBuilding: wrong }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const routing = textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: 'routing' }))

  expect(routing).toContain('setting "beforeBuilding" must be an object with a label and how as text')
  expect(routing).not.toContain('before building:')
}

test('beforeBuilding as a string is named as a problem and treated as absent', ($, on) => problemWith($, on, 'plan'))
test('beforeBuilding with an empty label is named as a problem and treated as absent', ($, on) => problemWith($, on, { label: '', how: 'write it' }))
test('beforeBuilding with an empty how is named as a problem and treated as absent', ($, on) => problemWith($, on, { label: 'plan', how: '  ' }))

test('a story keeps its Hand-over section through every write and has none without it', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const storyFile = (id: string): string => files.get(`${ROOT}/.sidequest/stories/${id}.md`) ?? ''

  await createTickets($, [
    { op: 'story', title: 'Uploads', destination: 'Uploads retry.', handOver: '### Goal\nRetry.' },
    { op: 'story', title: 'Plain', destination: 'Nothing else.' },
  ])
  expect(storyFile('REPO-S1')).toContain('## Hand-over\n### Goal\nRetry.')
  expect(storyFile('REPO-S2')).not.toContain('Hand-over')

  await createTickets($, [{ op: 'patch', id: 'REPO-S1', handOver: '### Goal\nRetry harder.' }])
  expect(storyFile('REPO-S1')).toContain('## Hand-over\n### Goal\nRetry harder.')
  expect(storyFile('REPO-S1')).not.toContain('Retry.')

  await createTickets($, [{ op: 'patch', id: 'REPO-S1', destination: 'Uploads retry twice.' }])
  expect(storyFile('REPO-S1')).toContain('Uploads retry twice.')
  expect(storyFile('REPO-S1')).toContain('## Hand-over\n### Goal\nRetry harder.')
})

test('a story keeps its Analysis right after the destination through every write, and the reply says where it is read', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const storyFile = (id: string): string => files.get(`${ROOT}/.sidequest/stories/${id}.md`) ?? ''

  const written = await createTickets($, [{ op: 'story', title: 'Uploads', destination: 'Uploads retry.', analysis: 'Asked: retry.\n\n### Today\nOne try.' }])
  expect(storyFile('REPO-S1')).toContain('## Destination\nUploads retry.\n\n## Analysis\nAsked: retry.\n\n### Today\nOne try.\n\n## Decisions')
  expect(textOf(written)).toContain(`The person reads the analysis of REPO-S1 beside the conversation: its row in the board pane, or ${ROOT}/.sidequest/stories/REPO-S1.md.`)

  await createTickets($, [{ op: 'patch', id: 'REPO-S1', analysis: 'Asked: retry twice.' }])
  expect(storyFile('REPO-S1')).toContain('## Analysis\nAsked: retry twice.')
  expect(storyFile('REPO-S1')).not.toContain('One try.')

  const later = await createTickets($, [{ op: 'patch', id: 'REPO-S1', destination: 'Uploads retry twice.', handOver: '### Goal\nRetry.' }])
  expect(storyFile('REPO-S1')).toContain('## Analysis\nAsked: retry twice.')
  expect(storyFile('REPO-S1')).toContain('## Hand-over\n### Goal\nRetry.')
  expect(textOf(later)).not.toContain('reads the analysis')
})

test('settings of the wrong type and names that point nowhere are all listed', async ($, on) => {
  const board = JSON.stringify({
    tiers: 'fast',
    categories: { odd: { tier: 'nowhere' } },
    settings: { worktrees: 'false', unrouted: 'missing' },
  })
  standInForEngine(on, new Map([[`${ROOT}/.sidequest/board.json`, board]]))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const routing = textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: 'routing' }))

  expect(routing).toContain('board.json problem: "tiers" must be an object')
  expect(routing).toContain('setting "worktrees" must be a boolean')
  expect(routing).toContain('category "odd" names tier "nowhere", which does not exist.')
  expect(routing).toContain('setting "unrouted" names category "missing", which does not exist.')
})

const isContentBlock = (block: unknown): boolean => typeof block === 'object' && block !== null && 'type' in block

const isHostAcceptedResult = (result: unknown): boolean =>
  typeof result === 'string' || (Array.isArray(result) && result.every(isContentBlock))

test('every sidequest tool answers with a result the host accepts', async ($, on) => {
  standInForEngine(on, new Map<string, string>())
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const called = new Set<string>()
  const call = async (name: string, input: Record<string, unknown>) => {
    called.add(name)

    return $.tool.call({ tool: `mcp__sidequest__${name}`, ...input })
  }
  const answers = [
    await call('ticket', { operations: [{ op: 'create', title: 'Build it' }] }),
    await call('board', { view: 'summary' }),
    await call('start', { id: 'REPO-1' }),
    await call('finish', { id: 'REPO-1', outcome: 'done', result: 'Done.', checked: 'not checked' }),
  ]

  expect([...called].sort()).toEqual(SIDEQUEST_TOOLS.map(tool => tool.name).sort())
  for (const answer of answers) {
    expect(answer.deny).toBeUndefined()
    expect(isHostAcceptedResult(answer.result)).toBe(true)
  }
})

const outwardFor = (id: string, patch: Partial<Ticket> = {}): string => outwardRule({ ...newTicket(id, { title: 'Retry failed uploads' }, '2026-11-16T09:56Z'), ...patch })

const STACK = { what: 'the local app and its database, run from the main checkout', refresh: 'auto' }

const boardWith = (settings: Record<string, unknown>): Map<string, string> =>
  new Map([[`${ROOT}/.sidequest/board.json`, JSON.stringify({ settings })]])

const startAnswer = async ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__sidequest__start', ...input })

const briefIn = (answer: string): string => JSON.parse(answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1)).prompt

test('a board with nothing shared and worktrees on gives the brief, frontier and start answer it always gave', async ($, on) => {
  standInForEngine(on, new Map([[`${ROOT}/.git/info/exclude`, '.claude/worktrees/\n']]))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [
    { op: 'create', title: 'Retry failed uploads', what: 'Uploads retry.', doneWhen: '- [ ] retry test passes' },
    { op: 'create', title: 'Show retry count' },
  ])
  const call = {
    subagent_type: 'sidequest:worker',
    description: 'REPO-1 Retry failed uploads',
    name: 'repo-1',
    prompt: `Ticket REPO-1: Retry failed uploads\n\n## What\nUploads retry.\n\n## Done when\n- [ ] retry test passes\n\n${outwardFor('REPO-1')}\n\n${RESULT_CONTRACT}`,
    model: 'sonnet',
    effort: 'medium',
    isolation: 'worktree',
  }

  const started = textOf(await startAnswer($, { id: 'REPO-1' }))
  const frontier = textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: 'frontier' }))
  const second = textOf(await startAnswer($, { id: 'REPO-2' }))

  expect(started).toBe(
    'REPO-1 is now doing. The board logs what the agent returns on the ticket by itself; call finish when it returns to add what you checked and move the ticket. ' +
      `Make this Agent call as given:\n${JSON.stringify(call, null, 2)}\n` +
      `The brief is also kept in ${ROOT}/.sidequest/briefs/REPO-1.md: name that file to the reviewer and to whoever proves the story, so they read the same decisions and how checks run here.`,
  )
  expect(frontier).toBe('REPO-2 ready build Show retry count')
  expect(second.startsWith('REPO-2 is now doing.')).toBe(true)
  expect(second).toContain('"isolation": "worktree"\n}\nThe brief is also kept in')
})

const CHECKS_TEXT = 'Checks need the ignored env file, so they run in the main checkout only. Command: TEST_MODE=1 npm test -- one-path'

test('the checks setting is a section of the brief before the shared section, and the routing view prints it', async ($, on) => {
  standInForEngine(on, boardWith({ checks: `  ${CHECKS_TEXT}
` }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [{ op: 'create', title: 'Retry failed uploads', what: 'Uploads retry.', doneWhen: '- [ ] retry test passes' }])

  const brief = briefIn(textOf(await startAnswer($, { id: 'REPO-1' })))
  const routing = textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: 'routing' }))

  expect(brief).toBe(`Ticket REPO-1: Retry failed uploads

## What
Uploads retry.

## Done when
- [ ] retry test passes

## How checks run here
${CHECKS_TEXT}

${outwardFor('REPO-1')}

${RESULT_CONTRACT}`)
  expect(routing).toContain(`checks: ${CHECKS_TEXT}`)
})

test('with no checks setting the brief has no such section and the routing view says nobody wrote it down', async ($, on) => {
  standInForEngine(on, boardWith({ checks: '  ' }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [{ op: 'create', title: 'Retry failed uploads' }])

  const brief = briefIn(textOf(await startAnswer($, { id: 'REPO-1' })))
  const routing = textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: 'routing' }))

  expect(brief).not.toContain('How checks run here')
  expect(routing).toContain('checks: not written down')
})

test('a ticket that uses the stack another doing ticket holds waits behind it, and alongside starts it with the reason on the log', async ($, on) => {
  const files = boardWith({ shared: { stack: STACK } })
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  const created = await createTickets($, [
    { op: 'create', title: 'Check the login against the stack', uses: ['stack'] },
    { op: 'create', title: 'Fix the session timeout', uses: ['stack'] },
    { op: 'create', title: 'Fix the footer typo' },
    { op: 'create', title: 'Seed the reports', uses: ['reports-db'] },
  ])
  const view = async (name: string) => textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: name }))

  const first = textOf(await startAnswer($, { id: 'REPO-1' }))
  const frontier = await view('frontier')
  const held = await startAnswer($, { id: 'REPO-2' })
  const fileWhileHeld = files.get(`${TICKETS}/REPO-2.md`)
  const alongside = textOf(await startAnswer($, { id: 'REPO-2', alongside: true }))

  expect(textOf(created)).toContain('REPO-4 uses "reports-db", which settings.shared in .sidequest/board.json does not name. It is held all the same')
  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain('uses: [stack]')
  expect(first).toContain(
    '\nREPO-1 holds the stack for this run. Can go alongside without touching it: REPO-3 Fix the footer typo, REPO-4 Seed the reports. Waiting: REPO-2 Fix the session timeout waits for the stack, REPO-1 is using it.',
  )
  expect(first).toContain('start only what they pick.')
  expect(frontier).toBe(
    'REPO-2 ready build Fix the session timeout (waits for the stack, REPO-1 is using it)\nREPO-3 ready build Fix the footer typo\nREPO-4 ready build Seed the reports',
  )
  expect(held.deny).toBe(
    'REPO-2 was not started: it uses the stack, and REPO-1 has it. Start it once that is done, or call start again with alongside: true to start it anyway; its log then says it started while the stack was held by REPO-1. Ready now without waiting: REPO-3, REPO-4.',
  )
  expect(fileWhileHeld).toContain('status: ready')
  expect(alongside.startsWith('REPO-2 is now doing.')).toBe(true)
  expect(files.get(`${TICKETS}/REPO-2.md`)).toContain('started worker sonnet/medium. started alongside: the stack was held by REPO-1')
  expect(await view('routing')).toContain('shared stack: the local app and its database, run from the main checkout Picks up new code: auto.')
})

test('with worktrees off a second worker ticket waits for the checkout, and a scout starts beside it', async ($, on) => {
  const files = boardWith({ worktrees: false })
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [
    { op: 'create', title: 'Retry failed uploads' },
    { op: 'create', title: 'Show retry count', category: 'quick' },
    { op: 'create', title: 'Trace upload flow', category: 'explore', kind: 'research' },
  ])

  const first = textOf(await startAnswer($, { id: 'REPO-1' }))
  const frontier = textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: 'frontier' }))
  const second = await startAnswer($, { id: 'REPO-2' })
  const scout = textOf(await startAnswer($, { id: 'REPO-3' }))

  expect(first).toContain('REPO-1 holds the checkout for this run.')
  expect(frontier).toBe('REPO-2 ready quick Show retry count (waits for the main project folder, REPO-1 is using it)\nREPO-3 ready explore Trace upload flow')
  expect(second.deny).toContain('REPO-2 was not started: it uses the checkout, and REPO-1 has it.')
  expect(scout.startsWith('REPO-3 is now doing.')).toBe(true)
  expect(scout).toContain('"subagent_type": "sidequest:scout"')
  expect(files.get(`${TICKETS}/REPO-3.md`)).toContain('status: doing')
})

const HOLDS_RULE = 'What this run holds is yours for this run: leave it as you found it, restore any data you change and say so in your result.'

test('the brief of a run that holds the stack and of one that does not each say what is shared and their own rules', async ($, on) => {
  standInForEngine(on, boardWith({ shared: { stack: STACK } }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [
    { op: 'create', title: 'Check the login against the stack', uses: ['stack'] },
    { op: 'create', title: 'Fix the footer typo' },
  ])

  const holding = briefIn(textOf(await startAnswer($, { id: 'REPO-1' })))
  const notHolding = briefIn(textOf(await startAnswer($, { id: 'REPO-2' })))

  expect(holding).toContain(
    `## Shared here\nThese exist once in this project, and one run at a time holds each.\n- stack: the local app and its database, run from the main checkout. This run holds it.\n\n${HOLDS_RULE}\n\n${outwardFor('REPO-1')}\n\n# Result contract`,
  )
  expect(holding).not.toContain('does not hold')
  expect(notHolding).toContain('- stack: the local app and its database, run from the main checkout. This run does not hold it.')
  expect(notHolding).toContain(
    'What this run does not hold: do not start, stop, restart or write to it, and never stop a process you did not start. The running application serves the main checkout, not your worktree, so a check that needs it is not yours to run: report it as not checked with that reason. The proof happens after landing.',
  )
  expect(notHolding).not.toContain(HOLDS_RULE)
})

const seededTicket = (id: string, fields: Parameters<typeof newTicket>[1], log: string[] = []): [string, string] => [
  `${TICKETS}/${id}.md`,
  serializeTicket({ ...newTicket(id, fields, '2026-11-16T09:56Z'), log }),
]

const HOLDING_TICKET = seededTicket('SQ-1', { title: 'Check the login against the stack', status: 'doing', uses: ['stack'] }, [
  '2026-11-16T09:56Z started worker sonnet/medium',
])

// Only a run this session has alive reads as running; without one the ticket reads interrupted.
const spawnTheHoldingRun = ($: Engine) =>
  $.agent.spawn(spawnInput({ subagentType: 'sidequest:worker', prompt: 'Ticket SQ-1: Check the login against the stack', description: 'SQ-1 login' }))

test('the now view says what runs and for how long, what waits for the stack, what could start and what the person could do', async ($, on) => {
  const files = boardWith({ shared: { stack: STACK } })
  files.set(...HOLDING_TICKET)
  files.set(...seededTicket('SQ-2', { title: 'Fix the session timeout', uses: ['stack'] }))
  files.set(...seededTicket('SQ-3', { title: 'Fix the footer typo' }))
  files.set(...seededTicket('SQ-4', { title: 'Pick a login provider', status: 'needs-you', forYou: 'Question: Which login provider should we use?' }))
  standInForEngine(on, files)
  recordingSpawns(on, [])
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await spawnTheHoldingRun($)
  const now = async () => textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: 'now' }))

  expect(await now()).toBe(
    [
      'Running now:',
      '- SQ-1 Check the login against the stack, running 6m, is using the stack',
      'Waiting for something only one ticket can use at a time:',
      '- SQ-2 Fix the session timeout waits for the stack, SQ-1 is using it',
      'Could start now:',
      '- SQ-3 Fix the footer typo',
      'You could:',
      '- Answer: Which login provider should we use?',
      '- Say what you want next: it can be planned while this runs',
      'For the session, not to paste:',
      'Its return comes to you as a new turn: end your turn, do not sleep or read the board again to wait.',
    ].join('\n'),
  )

  files.set(...seededTicket('SQ-5', { title: 'Show the last sync time', status: 'review' }))
  files.set(...seededTicket('SQ-6', { title: 'Retry failed uploads', status: 'done' }))
  expect((await now()).split('You could:\n')[1]).toBe(
    [
      '- Answer: Which login provider should we use?',
      '- Look at what is finished: SQ-5 Show the last sync time',
      '- Say what you want next: it can be planned while this runs',
      'For the session, not to paste:',
      'Its return comes to you as a new turn: end your turn, do not sleep or read the board again to wait.',
    ].join('\n'),
  )
})

test('the now view with one lone running ticket says nothing else can move', async ($, on) => {
  const files = boardWith({ shared: { stack: STACK } })
  files.set(...HOLDING_TICKET)
  standInForEngine(on, files)
  recordingSpawns(on, [])
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await spawnTheHoldingRun($)

  const now = textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: 'now' }))

  expect(now).toBe(
    'Running now:\n- SQ-1 Check the login against the stack, running 6m, is using the stack\nNothing else can move: this is the only thing in flight. You could still say what you want next: it can be planned while this runs.\nFor the session, not to paste:\nIts return comes to you as a new turn: end your turn, do not sleep or read the board again to wait.',
  )
})

test('finish with the outcome word review sends a build ticket to review, whatever its needs line says', async ($, on) => {
  const files = new Map<string, string>()
  standInForEngine(on, files)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [{ op: 'create', title: 'Build it' }, { op: 'create', title: 'Build more' }])

  const finished = (id: string, outcome: string) =>
    $.tool.call({ tool: 'mcp__sidequest__finish', id, outcome, result: 'Built.', needs: 'Someone should review the diff before it merges.' })
  const review = textOf(await finished('REPO-1', 'review'))
  await finished('REPO-2', 'Ready for review.')

  expect(review.startsWith('REPO-1 moved to review. outcome "review" is not one of done, failed, needs-you, so it was read as done.')).toBe(true)
  expect(files.get(`${TICKETS}/REPO-1.md`)).toContain('status: review')
  expect(files.get(`${TICKETS}/REPO-2.md`)).toContain('status: review')
})

test('a settings.shared of the wrong shape is a board file problem, and the board still answers', async ($, on) => {
  standInForEngine(on, boardWith({ shared: { stack: 'the app', db: { what: 'the database', refresh: 3 } } }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  const routing = textOf(await $.tool.call({ tool: 'mcp__sidequest__board', view: 'routing' }))

  expect(routing).toContain('board.json problem: shared "stack" needs what as one line of text and refresh as auto, ask or a command, so it is ignored.')
  expect(routing).toContain('board.json problem: shared "db" needs what')
  expect(routing).not.toContain('shared stack:')
})

test('the brief says what leaves this machine: the tracker key when the ticket has one, none when it has not, and the board id stays here', async ($, on) => {
  standInForEngine(on, new Map())
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await createTickets($, [
    { op: 'create', title: 'Retry failed uploads', issue: 'PAY-41' },
    { op: 'create', title: 'Show retry count' },
  ])

  const keyed = briefIn(textOf(await startAnswer($, { id: 'REPO-1' })))
  const unkeyed = briefIn(textOf(await startAnswer($, { id: 'REPO-2' })))

  expect(keyed).toContain(outwardFor('REPO-1', { issue: 'PAY-41' }))
  expect(keyed).toContain('the tracker key PAY-41, what changed')
  expect(keyed).toContain('REPO-1 is a board id for this machine only')
  expect(unkeyed).toContain(outwardFor('REPO-2'))
  expect(unkeyed).not.toContain('tracker key')
  expect(unkeyed).toContain('REPO-2 is a board id for this machine only')
})
