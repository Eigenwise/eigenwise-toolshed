import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentSpawnInput, On, ToolCallResult } from 'claude-code'

import { outwardRule } from './brief'
import { DEFAULT_BOARD_CONFIG } from './board-config'
import { activityWords, interruptedSummaryLines, isInterrupted, spokenAgo } from './interrupted-work'
import type { SessionRuns } from './interrupted-work'
import { resumeFactsFrom, resumeSection, worktreeOfBranch } from './resume-facts'
import { newTicket, serializeTicket } from './tickets'
import type { Ticket } from './tickets'
import { whatCanMoveText } from './what-can-move'
import { boardCards } from './views/board-view'
import { boardPaneLines, paneLinesAsText } from './views/pane-sections'
import type { PaneContent } from './views/pane-sections'

const ROOT = '/repo'
const TICKETS = `${ROOT}/.sidequest/tickets`
const NOW = Date.parse('2026-11-16T10:02:00Z')
const WORKTREE = `${ROOT}/.claude/worktrees/agent-a41`
const PROJECT_TRANSCRIPTS = '/home/.claude/projects/-repo'

const portablePath = (path: string): string => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

// A file system of paths to text and paths to the time each file last changed. Folders are what the paths imply.
type StandInFiles = { texts: Map<string, string>; changedAt: Map<string, number> }

const childrenOf = (paths: readonly string[], folder: string) => {
  const prefix = `${folder}/`
  const names = new Map<string, 'file' | 'dir'>()
  for (const path of paths.filter(candidate => candidate.startsWith(prefix))) {
    const rest = path.slice(prefix.length)
    names.set(rest.split('/')[0] ?? rest, rest.includes('/') ? 'dir' : 'file')
  }

  return [...names]
}

type GitAnswer = { stdout: string; exitCode?: number }

const standInForEngine = (on: On, files: StandInFiles, git: (argv: readonly string[], cwd: string) => GitAnswer | undefined = () => undefined) => {
  const gitCalls: string[] = []
  on('fs.read', (_, e) => {
    const text = files.texts.get(portablePath(e.path))

    return text === undefined ? { deny: `ENOENT ${e.path}` } : { value: text }
  })
  on('fs.write', (_, e) => {
    files.texts.set(portablePath(e.path), e.text)

    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    const folder = portablePath(e.path)
    const paths = [...files.texts.keys(), ...files.changedAt.keys()]
    const entries = childrenOf(paths, folder).map(([name, kind]) => ({
      name,
      kind,
      size: 0,
      mtimeMs: kind === 'file' ? (files.changedAt.get(`${folder}/${name}`) ?? 0) : 0,
      isLink: false,
    }))

    return entries.length > 0 ? { value: entries } : { deny: `ENOENT ${e.path}` }
  })
  on('fs.stat', (_, e) => {
    const changedAt = files.changedAt.get(portablePath(e.path))

    return changedAt === undefined ? { deny: `ENOENT ${e.path}` } : { value: { kind: 'file', size: 0, mtimeMs: changedAt, isLink: false } }
  })
  on('process.run', (_, e) => {
    const cwd = portablePath(e.init?.cwd ?? ROOT)
    const isLocatingTheBoard = e.argv.includes('--git-common-dir')
    if (!isLocatingTheBoard) gitCalls.push(e.argv.slice(1).join(' '))
    const answer = isLocatingTheBoard ? { stdout: `${ROOT}/.git\n${ROOT}/.git\n` } : (git(e.argv.slice(1), cwd) ?? { stdout: '', exitCode: 1 })

    return { value: { exitCode: answer.exitCode ?? 0, stdout: answer.stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home' : undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__sidequest__${e.name}` } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'a42' }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no-surface' } }))
  on('store.get', () => ({ value: true }))

  return gitCalls
}

const startSession = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

const textOf = (answer: ToolCallResult): string => (typeof answer.result === 'string' ? answer.result : `deny: ${answer.deny}`)

const view = async ($: Engine, input: Record<string, unknown>) => textOf(await $.tool.call({ tool: 'mcp__sidequest__board', ...input }))

const LEFT_RUNNING = ['2026-11-16T09:00Z started worker sonnet/medium', '2026-11-16T09:00Z agent a41 build requested sonnet/medium resolved sonnet']

const ticketText = (id: string, fields: Parameters<typeof newTicket>[1], log: string[] = []): string =>
  serializeTicket({ ...newTicket(id, fields, '2026-11-16T09:00Z'), log })

const boardWithInterruptedWork = (): StandInFiles => ({
  texts: new Map([
    [`${TICKETS}/SQ-41.md`, ticketText('SQ-41', { title: 'Retry failed uploads', status: 'doing', branch: 'main' }, LEFT_RUNNING)],
    [`${ROOT}/.git/worktrees/agent-a41/gitdir`, `${WORKTREE}/.git\n`],
  ]),
  changedAt: new Map([
    [`${WORKTREE}/README.md`, NOW - 5 * 3_600_000],
    [`${WORKTREE}/src/retry.ts`, NOW - 40_000],
  ]),
})

const spawnFor = (ticketId: string, title: string): AgentSpawnInput => ({
  tool_use_id: 'toolu_1',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'opus',
  background: false,
  fork: false,
  subagentType: 'sidequest:worker',
  prompt: `Ticket ${ticketId}: ${title}`,
  description: `${ticketId} ${title}`,
})

test('a doing ticket with no run in this session reads interrupted in the summary, the list and the now view, and reads running once an agent runs it', async ($, on) => {
  standInForEngine(on, boardWithInterruptedWork())
  await startSession($)

  const summary = await view($, { view: 'summary' })
  const list = await view($, { view: 'list' })
  const now = await view($, { view: 'now' })

  expect(summary).toContain(
    '\nInterrupted, nothing runs them in this session: SQ-41 (files changed 40s ago). Earlier work, not a request: the person says whether to resume, set aside or drop each. A typed continue or go on resumes these, with no question about which, only while this conversation has no work of its own. Once it has started or changed a ticket, those words are about that work, never about these.',
  )
  expect(list).toBe('SQ-41 (branch main) doing build Retry failed uploads (interrupted, files changed 40s ago)')
  expect(now.startsWith('Nothing is running.\nStopped, nothing runs them now:\n- SQ-41 (branch main) Retry failed uploads, files changed 40s ago\n')).toBe(true)

  await $.agent.spawn(spawnFor('SQ-41', 'Retry failed uploads'))

  expect(await view($, { view: 'summary' })).not.toContain('Interrupted')
  expect(await view($, { view: 'list' })).toBe('SQ-41 (branch main) doing build Retry failed uploads')
  expect(await view($, { view: 'now' })).toContain('Running now:\n- SQ-41 (branch main) Retry failed uploads, running 1h 2m')
})

test('the words name the agent transcript too, and say only that nothing ran here when neither can be found', async ($, on) => {
  const files = boardWithInterruptedWork()
  files.changedAt.set(`${PROJECT_TRANSCRIPTS}/s1.jsonl`, NOW - 60_000)
  files.changedAt.set(`${PROJECT_TRANSCRIPTS}/s1/subagents/agent-a41.jsonl`, NOW - 3 * 3_600_000)
  files.texts.set(`${TICKETS}/SQ-42.md`, ticketText('SQ-42', { title: 'Show the sync time', status: 'review' }, ['2026-11-15T09:00Z started worker sonnet/medium']))
  standInForEngine(on, files)
  await startSession($)

  const list = await view($, { view: 'list' })

  expect(list).toContain('Retry failed uploads (interrupted, files changed 40s ago, last activity 3h ago)')
  expect(list).toContain('SQ-42 review build Show the sync time (interrupted, no run in this session)')
})

test('the pane shows an interrupted ticket under what runs now, one row with how long ago, and leaves it out of Next', async ($, on) => {
  standInForEngine(on, boardWithInterruptedWork())
  await startSession($)

  const answer = await $.command.run({ command: 'board', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

  expect(answer.text).toContain('Now\n  SQ-41 Retry failed uploads  stopped, nothing runs it (40s ago)')
  expect(answer.text).not.toContain('started, not running')
})

const GIT_FOR_A_RESUMED_RUN: Record<string, string> = {
  'merge-base main worktree-agent-a41': 'fork0\n',
  'log --reverse --format=%h%x09%ce%x09%cn%x09%s fork0..worktree-agent-a41': 'abc1111\tme@example.com\tMe\tAdd the retry\nabc2222\tme@example.com\tMe\tTest the retry\n',
  'config user.email': 'me@example.com\n',
  'diff --name-only fork0 worktree-agent-a41': 'src/retry.ts\nsrc/retry.test.ts\n',
  'diff --name-only fork0 main': 'src/retry.ts\nREADME.md\n',
  'worktree list --porcelain': `worktree ${ROOT}\nHEAD 111\nbranch refs/heads/main\n\nworktree ${WORKTREE}\nHEAD 222\nbranch refs/heads/worktree-agent-a41\n`,
  'status --porcelain': ' M src/retry.ts\n',
  'for-each-ref --format=%(refname) %(objectname) refs/remotes': '',
  'rev-parse worktree-agent-a41': '222\n',
}

const briefIn = (answer: string): string => JSON.parse(answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1)).prompt

test('start on an interrupted ticket puts its commits and what changed on the base into the brief, and a fresh ticket runs no git and gets the same brief', async ($, on) => {
  const files = boardWithInterruptedWork()
  files.texts.set(`${TICKETS}/SQ-43.md`, ticketText('SQ-43', { title: 'Show retry count', what: 'The count shows.' }))
  const gitCalls = standInForEngine(on, files, argv => {
    const stdout = GIT_FOR_A_RESUMED_RUN[argv.join(' ')]

    return stdout === undefined ? undefined : { stdout }
  })
  await startSession($)

  const resumed = briefIn(textOf(await $.tool.call({ tool: 'mcp__sidequest__start', id: 'SQ-41' })))
  const callsForTheResume = gitCalls.length
  const fresh = briefIn(textOf(await $.tool.call({ tool: 'mcp__sidequest__start', id: 'SQ-43' })))

  expect(resumed).toContain(
    [
      '## What changed since',
      'An earlier run of this ticket stopped without a result. What the board found when this run started:',
      '- Commits already on branch worktree-agent-a41, oldest first:',
      '  - abc1111 Add the retry',
      '  - abc2222 Test the retry',
      '- That branch is where this work stands: merge it into your worktree first and build on it instead of starting over.',
      `- Uncommitted files in its worktree at ${WORKTREE}: src/retry.ts. That folder is outside your worktree: your shell cannot go there, the Read tool can. Read them and take what is right.`,
      '- Files this branch touched that changed on main since: src/retry.ts',
    ].join('\n'),
  )
  expect(resumed).not.toContain('force push')
  expect(fresh).not.toContain('## What changed since')
  expect(fresh).toBe(
    [
      'Ticket SQ-43: Show retry count',
      '## What\nThe count shows.',
      '## Done when\n(not written yet)',
      outwardRule(newTicket('SQ-43', { title: 'Show retry count' }, '2026-11-16T09:00Z')),
      fresh.slice(fresh.indexOf('# Result contract')),
    ].join('\n\n'),
  )
  expect(gitCalls.length).toBe(callsForTheResume)
})

test('start on an interrupted ticket whose branch is already merged into the base says so in the brief and names the branch', async ($, on) => {
  standInForEngine(on, boardWithInterruptedWork(), argv => {
    const merged: Record<string, string> = {
      'merge-base main worktree-agent-a41': 'tip0\n',
      'merge-base --is-ancestor worktree-agent-a41 main': '',
    }
    const stdout = merged[argv.join(' ')]

    return stdout === undefined ? undefined : { stdout }
  })
  await startSession($)

  const resumed = briefIn(textOf(await $.tool.call({ tool: 'mcp__sidequest__start', id: 'SQ-41' })))

  expect(resumed).toContain(
    [
      '## What changed since',
      'An earlier run of this ticket stopped without a result. What the board found when this run started:',
      '- Branch worktree-agent-a41 is already in main: its work is merged. Check whether the Done when already passes there before building anything.',
    ].join('\n'),
  )
})

const startOf = async ($: Engine, id: string) => textOf(await $.tool.call({ tool: 'mcp__sidequest__start', id }))

const boardWithReadyTicket = (): StandInFiles => {
  const files = boardWithInterruptedWork()
  files.texts.set(`${TICKETS}/SQ-43.md`, ticketText('SQ-43', { title: 'Show retry count', what: 'The count shows.' }))

  return files
}

const REPEAT_NOTE_TAIL = 'Nothing is refused: the Agent call below puts a second agent on the same ticket, so make it only if you want two.'

test('a second start in the session with a live agent on the ticket says so before the Agent call, and logs a repeat', async ($, on) => {
  const files = boardWithReadyTicket()
  standInForEngine(on, files)
  await startSession($)

  const first = await startOf($, 'SQ-43')
  await $.agent.spawn(spawnFor('SQ-43', 'Show retry count'))
  const second = await startOf($, 'SQ-43')

  expect(first.startsWith('SQ-43 is now doing.')).toBe(true)
  expect(second.startsWith(`SQ-43 was already started at 2026-11-16T10:02Z. An agent of this session is on it right now. ${REPEAT_NOTE_TAIL} SQ-43 is now doing.`)).toBe(true)
  expect(second.indexOf('already started')).toBeLessThan(second.indexOf('Make this Agent call as given'))
  expect(second).toContain('"subagent_type": "sidequest:worker"')
  const log = files.texts.get(`${TICKETS}/SQ-43.md`) ?? ''
  expect(log.match(/ started worker sonnet\/medium/g)?.length).toBe(2)
  expect(log).toContain('started worker sonnet/medium. repeat start, already started 2026-11-16T10:02Z')
})

test('a second start before any agent was spawned says the first start never became an agent, gives the brief again and logs no repeat', async ($, on) => {
  const files = boardWithReadyTicket()
  standInForEngine(on, files)
  await startSession($)

  await startOf($, 'SQ-43')
  const second = await startOf($, 'SQ-43')

  expect(second.startsWith('SQ-43 was started at 2026-11-16T10:02Z, but that start never became an agent, so nothing is on it.')).toBe(true)
  expect(second).not.toContain('another session may be')
  expect(second).toContain('Make this Agent call as given')
  const log = files.texts.get(`${TICKETS}/SQ-43.md`) ?? ''
  expect(log.match(/ started worker sonnet\/medium/g)?.length).toBe(1)
  expect(log).not.toContain('repeat start')
})

test('a start on a ticket another session started says when it was started and that this session cannot know about its agent', async ($, on) => {
  standInForEngine(on, boardWithInterruptedWork())
  await startSession($)

  const answer = await startOf($, 'SQ-41')

  expect(answer.startsWith(`SQ-41 was already started at 2026-11-16T09:00Z. No agent of this session is on it. An agent of another session may be, and this session cannot know. ${REPEAT_NOTE_TAIL}`)).toBe(true)
  expect(answer).toContain('Make this Agent call as given')
})

test('a start on a doing ticket with git facts still says another session may be on it, before the resume brief', async ($, on) => {
  const files = boardWithInterruptedWork()
  standInForEngine(on, files, argv => {
    const stdout = GIT_FOR_A_RESUMED_RUN[argv.join(' ')]

    return stdout === undefined ? undefined : { stdout }
  })
  await startSession($)

  const answer = await startOf($, 'SQ-41')

  expect(answer.startsWith(`SQ-41 was already started at 2026-11-16T09:00Z. No agent of this session is on it. An agent of another session may be, and this session cannot know. ${REPEAT_NOTE_TAIL}`)).toBe(true)
  expect(answer).toContain('## What changed since')
  expect(files.texts.get(`${TICKETS}/SQ-41.md`)).toContain('repeat start')
})

test('a start on a ticket this session saw cut off says nothing about another session', async ($, on) => {
  const files = boardWithInterruptedWork()
  files.texts.set(`${TICKETS}/SQ-41.md`, ticketText('SQ-41', { title: 'Retry failed uploads', status: 'doing', branch: 'main' }, [...LEFT_RUNNING, '2026-11-16T09:30Z returned build run, interrupted after 30m']))
  standInForEngine(on, files)
  await startSession($)

  expect((await startOf($, 'SQ-41')).startsWith('SQ-41 is now doing. ')).toBe(true)
})

test('a doing ticket this session started with no agent call after it is named as doing with no agent here, not running', async ($, on) => {
  standInForEngine(on, boardWithReadyTicket())
  await startSession($)

  await startOf($, 'SQ-43')
  const now = await view($, { view: 'now' })

  expect(now).not.toContain('Running now')
  expect(now).toContain('- SQ-43 Show retry count\n')
  expect(now).not.toContain('no run in this session')
  expect(await view($, { view: 'list' })).toContain('(interrupted, no run in this session)')
})

test('the same ticket is running once its agent is on it', async ($, on) => {
  standInForEngine(on, boardWithReadyTicket())
  await startSession($)

  await startOf($, 'SQ-43')
  await $.agent.spawn(spawnFor('SQ-43', 'Show retry count'))

  expect(await view($, { view: 'now' })).toContain('Running now:\n- SQ-43 Show retry count')
})

const RUN_FACTS ={ branch: 'worktree-agent-a41', base: 'main', worktree: WORKTREE }

test('the resume section names someone else on the branch and a remote that moved, and is left out when nothing is true', () => {
  const answers = {
    commitLog: 'abc1111\tme@example.com\tMe\tAdd the retry\nabc3333\tsam@example.com\tSam\tFix the retry\n',
    ownEmail: 'me@example.com\n',
    hasRemoteMoved: true,
  }

  const section = resumeSection(resumeFactsFrom(RUN_FACTS.branch, RUN_FACTS.base, answers))
  const nothingTrue = resumeSection(resumeFactsFrom(RUN_FACTS.branch, RUN_FACTS.base, { hasRemoteMoved: false }))

  expect(section.join('\n')).toContain("- The last commit on worktree-agent-a41 is by Sam, not by this checkout's git user.")
  expect(section.join('\n')).toContain('- worktree-agent-a41 moved on the remote since. Merge what is there; never force push.')
  expect(nothingTrue).toEqual([])
  expect(worktreeOfBranch(`worktree ${WORKTREE}\nbranch refs/heads/other\n`, RUN_FACTS.branch)).toBeUndefined()
})

const NO_RUNS: SessionRuns = { liveTickets: new Set(), ticketsThisSession: new Set() }

const doingTicket = (log: string[]): Ticket => ({ ...newTicket('SQ-44', { title: 'Trace uploads', status: 'doing' }, '2026-11-16T09:00Z'), log })

test('continue means resume only while this conversation has no work of its own', () => {
  const leftBehind = doingTicket(LEFT_RUNNING)
  const interrupted = new Map([['SQ-44', 'last activity 3h ago']])

  expect(interruptedSummaryLines([leftBehind], interrupted)[0]).toContain(
    'resumes these, with no question about which, only while this conversation has no work of its own. Once it has started or changed a ticket, those words are about that work',
  )
  expect(interruptedSummaryLines([leftBehind], interrupted, true)[0]).toContain('is about the work this conversation already has in hand, never about these')
  expect(interruptedSummaryLines([leftBehind], interrupted, true)[0]).not.toContain('means resume')
})

test('only a doing or review ticket with nothing of this session behind it is interrupted', () => {
  const leftBehind = doingTicket(LEFT_RUNNING)
  const cutOffHere = doingTicket([...LEFT_RUNNING, '2026-11-16T09:30Z returned build run, interrupted after 30m'])
  const returned = doingTicket([...LEFT_RUNNING, '2026-11-16T09:30Z returned build run after 30m'])
  const thisSession: SessionRuns = { liveTickets: new Set(), ticketsThisSession: new Set(['SQ-44']) }

  expect(isInterrupted(leftBehind, NO_RUNS)).toBe(true)
  expect(isInterrupted(leftBehind, { ...NO_RUNS, liveTickets: new Set(['SQ-44']) })).toBe(false)
  expect(isInterrupted(leftBehind, thisSession)).toBe(false)
  expect(isInterrupted(cutOffHere, thisSession)).toBe(true)
  expect(isInterrupted(returned, NO_RUNS)).toBe(false)
  expect(isInterrupted({ ...leftBehind, status: 'review' }, thisSession)).toBe(false)
  expect(isInterrupted({ ...leftBehind, status: 'ready' }, NO_RUNS)).toBe(false)
  expect([40_000, 12 * 60_000, 3 * 3_600_000, 3 * 86_400_000].map(spokenAgo)).toEqual(['40s ago', '12m ago', '3h ago', '3 days ago'])
  expect(activityWords({}, NOW)).toBe('no run in this session')
})

const QUIET_BOARD: Ticket[] = [
  newTicket('SQ-1', { title: 'Retry failed uploads' }, '2026-11-16T09:00Z'),
  newTicket('SQ-2', { title: 'Pick a backoff', status: 'needs-you', forYou: 'Question: Which backoff?' }, '2026-11-16T09:00Z'),
  { ...newTicket('SQ-3', { title: 'Trace uploads', status: 'doing' }, '2026-11-16T09:00Z'), log: LEFT_RUNNING },
  newTicket('SQ-4', { title: 'Show the sync time', status: 'review' }, '2026-11-16T09:00Z'),
  newTicket('SQ-5', { title: 'Fix the footer', status: 'done' }, '2026-11-16T09:00Z'),
]

const quietPane = (tickets: readonly Ticket[], running: PaneContent['running']): PaneContent => ({
  cards: boardCards(tickets, DEFAULT_BOARD_CONFIG),
  running,
  sessionWork: { isWorking: false, steps: 0 },
  finishedAgents: [],
  worktreeCount: 0,
  touchedHere: new Set(tickets.map(ticket => ticket.id)),
  showsIntro: false,
  columns: 80,
  now: NOW,
  whatYouCouldDo: [],
})

test('a board with nothing interrupted gives the same summary, now view and pane sections as before', async ($, on) => {
  const files: StandInFiles = { texts: new Map(QUIET_BOARD.map(ticket => [`${TICKETS}/${ticket.id}.md`, serializeTicket(ticket)])), changedAt: new Map() }
  standInForEngine(on, files)
  await startSession($)
  await $.agent.spawn(spawnFor('SQ-3', 'Trace uploads'))
  await $.tool.call({ tool: 'mcp__sidequest__finish', id: 'SQ-4', outcome: 'done', result: 'Shown.' })
  const running = [{ agentId: 'a42', what: 'Trace uploads', ticket: 'SQ-3', model: 'sonnet', canBeViewed: true }]

  expect(await view($, { view: 'summary' })).toBe(
    '1 waiting on you, 1 ready to start, 1 in progress, 1 being checked. Ready to start: SQ-1. The waiting view writes what waits on the person, ready to pass on.\nAlso on the board: 1 done earlier. To see them: ask for the done, parked or inbox list, or type /board.',
  )
  expect(await view($, { view: 'now' })).toBe(
    [
      'Running now:',
      '- SQ-3 Trace uploads, running 1h 2m',
      'Could start now:',
      '- SQ-1 Retry failed uploads',
      'You could:',
      '- Answer: Which backoff?',
      '- Look at what is finished: SQ-4 Show the sync time',
      '- Say what you want next',
      'For the session, not to paste:',
      'Its return comes to you as a new turn: end your turn, do not sleep or read the board again to wait.',
    ].join('\n'),
  )
  expect(whatCanMoveText(QUIET_BOARD, DEFAULT_BOARD_CONFIG, '2026-11-16T10:02Z')).toContain('Running now:\n- SQ-3 Trace uploads')
  expect(paneLinesAsText(boardPaneLines(quietPane(QUIET_BOARD, running)))).toBe(
    [
      'Waits on you',
      '  SQ-2 Which backoff?',
      '',
      'Now',
      '  SQ-3 Trace uploads  sonnet, 1h 2m',
      '',
      'Being checked',
      '  SQ-4 Show the sync time',
      '',
      'Next',
      '  SQ-1 Retry failed uploads',
      '',
      'Done',
      '  SQ-5 Fix the footer',
    ].join('\n'),
  )
})
