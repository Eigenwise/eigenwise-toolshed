import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { serializeProposal } from '../proposals'
import type { Proposal } from '../proposals'
import { REASON_HINT, REASON_LABEL, inboxText, noticedCandidates, projectNameOf, UNNAMED_PROJECT } from './inbox'
import { candidateToOffer, isRealPause } from './offer'

const NOW = Date.parse('2026-11-16T10:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000
const QUARTERMASTER_FOLDER = '/repo/.claude/quartermaster'
const FINGERPRINT = 'script:npm run'
const SENTENCE = 'ran `npm run` by hand 14 times over 2 days'

const PANE = {
  plugin: 'quartermaster',
  component: 'Pane',
  requestId: 'quartermaster',
  props: {
    title: 'Quartermaster',
    isFocused: true,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
// Four mounts in one test ran past the 5 s default on a slow Windows runner (CI run 44288588237).
const EVERY_SURFACE = { timeoutMs: 20_000 }

const SEEDED: Proposal = {
  id: 'P-0007',
  kind: 'script',
  target: 'npm run build',
  status: 'offered',
  authority: 'ask',
  evidence: ['fix:bash: npm test'],
  expect: 'hand-typed npm run build per week',
  baseline: 14,
  created: '2026-11-15',
  body: '## What\nAdd a build script.\n\n## Why\nIt is typed by hand every day.',
}

const directChildren = (files: Map<string, string>, directory: string) =>
  [...files.keys()]
    .filter(path => path.startsWith(`${directory}/`) && !path.slice(directory.length + 1).includes('/'))
    .map(path => ({ name: path.slice(directory.length + 1), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false }))

const hasDirectory = (files: Map<string, string>, path: string): boolean =>
  [...files.keys()].some(file => file.startsWith(`${path}/`))

// The engine hands `fs.*` hooks an absolute native path (`C:\repo\a` on Windows).
const portable = (path: string): string => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

const brokenWrites = { pathPart: undefined as string | undefined }
const brokenSession = { cannotTakeLines: false }

const fakeDisk = (on: On, files: Map<string, string>): void => {
  on('fs.exists', (_, e) => ({ value: files.has(portable(e.path)) || hasDirectory(files, portable(e.path)) }))
  on('fs.read', (_, e) => ({ value: files.get(portable(e.path)) ?? '' }))
  on('fs.write', (_, e) => {
    if (brokenWrites.pathPart !== undefined && portable(e.path).includes(brokenWrites.pathPart)) throw new Error('disk is full')
    files.set(portable(e.path), e.text)

    return { value: undefined }
  })
  on('fs.list', (_, e) => ({ value: directChildren(files, portable(e.path)) }))
}

const commandRuns = (day: string, count: number): string =>
  Array.from({ length: count }, () => `${JSON.stringify({ kind: 'typed', at: `${day}T09:00:00.000Z`, prefix: 'npm run' })}\n`).join('')

/** Fourteen hand-typed `npm run` over two days: one candidate, `script:npm run`. */
const seedCandidate = (files: Map<string, string>): void => {
  files.set('/home/.claude/quartermaster/events/repo/2026-11-14.jsonl', commandRuns('2026-11-14', 7))
  files.set('/home/.claude/quartermaster/events/repo/2026-11-15.jsonl', commandRuns('2026-11-15', 7))
}

const seedProposal = (files: Map<string, string>, proposal: Proposal = SEEDED): void => {
  files.set(`${QUARTERMASTER_FOLDER}/proposals/${proposal.id}.md`, serializeProposal(proposal))
}

type World = {
  files: Map<string, string>
  toasts: string[]
  statuses: (string | undefined)[]
  ran: string[]
  submitted: string[]
  isPlaced: boolean
}

const startSession = async ($: Engine, on: On, seed: (files: Map<string, string>) => void): Promise<World> => {
  const world: World = { files: new Map(), toasts: [], statuses: [], ran: [], submitted: [], isPlaced: true }
  brokenWrites.pathPart = undefined
  brokenSession.cannotTakeLines = false
  seed(world.files)
  fakeDisk(on, world.files)
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home' })
  on('tool.register', (_, e) => ({ value: { tool: `mcp__quartermaster__${e.name}` } }))
  on('command.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'quartermaster' } }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('agent.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: world.isPlaced ? { isPlaced: true } : { isPlaced: false, reason: 'no surface' } }))
  on('ui.toast', (_, e) => {
    world.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    world.statuses.push(e.text)

    return { value: undefined }
  })
  on('command.run', (_, e) => {
    world.ran.push(`/${e.command} ${e.args}`)

    return {}
  })
  on('prompt.submit', (_, e) => {
    if (brokenSession.cannotTakeLines) throw new Error('the session is closing')
    world.submitted.push(e.text)

    return { text: e.text }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('skill.prompt', () => ({ text: '' }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  return world
}

const endTurn = ($: Engine) =>
  $.turn.complete({ answer: 'done', durationMs: 1200, isAborted: false, turnId: 't1', reason: 'answer' })

const runQuartermasterCommand = ($: Engine) =>
  $.command.run({
    command: 'quartermaster',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })

const endSession = ($: Engine) =>
  $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })

const IMPRESSIONS = '/home/.claude/quartermaster/events/repo/impressions.jsonl'

const impressionKinds = (world: World): string[] =>
  (world.files.get(IMPRESSIONS) ?? '')
    .split('\n')
    .filter(line => line !== '')
    .map(line => String(JSON.parse(line).kind))

test('the inbox lists a seeded proposal and a noticed candidate on every surface', EVERY_SURFACE, async ($, on) => {
  const world = await startSession($, on, files => {
    seedCandidate(files)
    seedProposal(files)
  })
  expect(lastStatus(world)).toBe('Quartermaster: 1 to review: Add a script for: npm run build (/quartermaster)')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: 'Waiting on you' }))?.text).toBe('Waiting on you')
    expect((await ui.find({ key: 'P-0007' }))?.text).toBe('Add a script for: npm run build')
    expect((await ui.find({ key: FINGERPRINT }))?.text).toBe(SENTENCE)

    await ui.press({ key: 'P-0007' })
    expect((await ui.find({ type: 'Text', text: /^Quartermaster checks later/ }))?.text).toBe(
      'Quartermaster checks later whether this helped: hand-typed npm run build per week. Today: 14.',
    )
    expect((await ui.find({ type: 'Text', text: /^Approve makes/ }))?.text).toBe(
      'Approve makes the change now, and it can be undone. Reject is remembered for this project. Already handled closes it without that, so it may come back if the same thing keeps happening. Later hides it for a few days.',
    )
    expect(await ui.find({ key: 'approve' })).toBeDefined()
    await ui.press({ key: 'back' })
    expect(await ui.find({ key: 'P-0007' })).toBeDefined()
    await ui.unmount()
  }
})

test('Approve marks the proposal accepted and queues the apply skill', async ($, on) => {
  const world = await startSession($, on, seedProposal)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'P-0007' })
  await ui.press({ key: 'approve' })

  expect(world.ran).toEqual(['/quartermaster:apply P-0007'])
  expect(world.files.get(`${QUARTERMASTER_FOLDER}/proposals/P-0007.md`)?.includes('status: accepted')).toBe(true)
  expect(world.statuses[world.statuses.length - 1]).toBe(undefined)
  await ui.unmount()
})

test('Reject declines the proposal and writes the rejection', async ($, on) => {
  const world = await startSession($, on, seedProposal)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'P-0007' })
  await ui.press({ key: 'reject' })

  const rejected = world.files.get(`${QUARTERMASTER_FOLDER}/rejected.md`) ?? ''
  expect(rejected.includes('- `script:npm run build` 2026-11-16: no reason given')).toBe(true)
  expect(world.toasts).toEqual(['Rejected. Quartermaster will not suggest this again in this project.'])
  expect(world.files.get(`${QUARTERMASTER_FOLDER}/proposals/P-0007.md`)?.includes('status: declined')).toBe(true)
  expect(world.ran).toEqual([])
  await ui.unmount()
})

test('the reason field is a label, a hint and a field, and Enter in it keeps the words and rejects nothing', async ($, on) => {
  const world = await startSession($, on, seedProposal)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'P-0007' })
  expect((await ui.find({ type: 'Text', text: REASON_LABEL }))?.text).toBe(REASON_LABEL)
  expect((await ui.find({ type: 'Text', text: REASON_HINT }))?.text).toBe(REASON_HINT)
  await ui.input({ key: 'reason', text: 'we use make here' })

  expect(world.files.get(`${QUARTERMASTER_FOLDER}/rejected.md`)).toBe(undefined)
  expect(world.files.get(`${QUARTERMASTER_FOLDER}/proposals/P-0007.md`)?.includes('status: offered')).toBe(true)
  expect(world.toasts).toEqual([])
  expect(world.submitted).toEqual([])
  expect(await ui.find({ key: 'reject' })).toBeDefined()
  await ui.press({ key: 'reject' })

  const rejected = world.files.get(`${QUARTERMASTER_FOLDER}/rejected.md`) ?? ''
  expect(rejected.includes('- `script:npm run build` 2026-11-16: we use make here')).toBe(true)
  expect(world.toasts).toEqual(['Rejected. Quartermaster will not suggest this again in this project.'])
  await ui.unmount()
})

test('a reject puts one line with the title and the reason into the open session', async ($, on) => {
  const world = await startSession($, on, seedProposal)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'P-0007' })
  await ui.input({ key: 'reason', text: 'we use make here' })
  await ui.press({ key: 'reject' })

  expect(world.submitted).toEqual([
    'Quartermaster: the person answered "Add a script for: npm run build" (P-0007) as rejected: we use make here',
  ])
  await ui.unmount()
})

test('an answer with no reason typed sends the session nothing and starts no turn', async ($, on) => {
  const world = await startSession($, on, seedProposal)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'P-0007' })
  await ui.press({ key: 'handled' })

  expect(world.files.get(`${QUARTERMASTER_FOLDER}/proposals/P-0007.md`)?.includes('status: handled')).toBe(true)
  expect(world.submitted).toEqual([])
  await ui.unmount()
})

test('a session that cannot take the line leaves the answer saved and the toast shown', async ($, on) => {
  const world = await startSession($, on, seedProposal)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  brokenSession.cannotTakeLines = true

  await ui.press({ key: 'P-0007' })
  await ui.input({ key: 'reason', text: 'we use make here' })
  await ui.press({ key: 'reject' })

  expect(world.files.get(`${QUARTERMASTER_FOLDER}/proposals/P-0007.md`)?.includes('status: declined')).toBe(true)
  expect(world.files.get(`${QUARTERMASTER_FOLDER}/rejected.md`)?.includes('we use make here')).toBe(true)
  expect(world.toasts).toEqual(['Rejected. Quartermaster will not suggest this again in this project.'])
  expect(world.submitted).toEqual([])
  await ui.unmount()
})

test('Already handled closes the proposal with the reason and writes no never-again line', async ($, on) => {
  const world = await startSession($, on, seedProposal)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'P-0007' })
  await ui.input({ key: 'reason', text: 'the Makefile has it\nsince Monday' })
  await ui.press({ key: 'handled' })

  const proposal = world.files.get(`${QUARTERMASTER_FOLDER}/proposals/P-0007.md`) ?? ''
  expect(proposal.includes('status: handled')).toBe(true)
  expect(proposal.includes('answered: 2026-11-16')).toBe(true)
  expect(proposal.includes('reason: the Makefile has it since Monday')).toBe(true)
  expect(world.files.get(`${QUARTERMASTER_FOLDER}/rejected.md`)).toBe(undefined)
  expect(world.submitted).toEqual([
    'Quartermaster: the person answered "Add a script for: npm run build" (P-0007) as already handled: the Makefile has it since Monday',
  ])
  expect(await ui.find({ key: 'P-0007' })).toBe(undefined)
  expect(lastStatus(world)).toBe(undefined)
  await ui.unmount()
})

const handledOn = (day: string): Proposal => ({
  ...SEEDED,
  target: 'npm run',
  status: 'handled',
  evidence: [FINGERPRINT],
  answered: day,
  reason: 'done',
})

test('a proposal closed as already handled keeps its candidate off the list while the evidence window covers it', async ($, on) => {
  await startSession($, on, files => {
    seedCandidate(files)
    seedProposal(files, handledOn('2026-11-10'))
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ key: FINGERPRINT })).toBe(undefined)
  await ui.unmount()
})

test('a candidate comes back after the window when its proposal was closed as already handled', async ($, on) => {
  await startSession($, on, files => {
    seedCandidate(files)
    seedProposal(files, handledOn('2026-10-01'))
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ key: FINGERPRINT })).toBeDefined()
  await ui.unmount()
})

test('a reject whose never-again write fails says the proposal is rejected, keeps the reason and offers no answer', async ($, on) => {
  const world = await startSession($, on, seedProposal)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'P-0007' })
  await ui.input({ key: 'reason', text: 'we use make here', kind: 'change' })
  brokenWrites.pathPart = '/rejected.md'
  await ui.press({ key: 'reject' })

  expect(world.files.get(`${QUARTERMASTER_FOLDER}/proposals/P-0007.md`)?.includes('status: declined')).toBe(true)
  const problem = (await ui.find({ type: 'Text', text: /^P-0007 is rejected/ }))?.text ?? ''
  expect(problem).toContain('the never-again line was not written to rejected.md')
  expect(problem).toContain('fs.write')
  expect(problem).not.toContain('was not saved')
  expect(await ui.find({ key: 'reject' })).toBe(undefined)
  expect(await ui.find({ key: 'handled' })).toBe(undefined)
  expect(await ui.find({ key: 'back' })).toBeDefined()
  expect(world.toasts).toHaveLength(1)
  expect(world.submitted).toHaveLength(1)
  expect((await ui.find({ type: 'Text', text: /^Your reason: / }))?.text).toBe('Your reason: we use make here')
  await ui.unmount()
})

test('Back clears the red problem line, as the next press does', async ($, on) => {
  const world = await startSession($, on, seedProposal)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  brokenWrites.pathPart = '/proposals/'

  await ui.press({ key: 'P-0007' })
  await ui.press({ key: 'reject' })
  expect(await ui.find({ type: 'Text', text: /^Your answer for P-0007 was not saved/ })).toBeDefined()
  await ui.press({ key: 'back' })

  expect(await ui.find({ type: 'Text', text: /^Your answer for/ })).toBe(undefined)
  expect(world.submitted).toEqual([])
  await ui.unmount()
})

test('a very long title is cut in the status line', async ($, on) => {
  const target = `npm run ${'build-the-whole-monorepo-with-every-flag '.repeat(4)}`.trim()
  const world = await startSession($, on, files => seedProposal(files, { ...SEEDED, target }))

  const status = lastStatus(world) ?? ''
  expect(status.startsWith('Quartermaster: 1 to review: Add a script for: npm run build-the-whole')).toBe(true)
  expect(status.endsWith('... (/quartermaster)')).toBe(true)
  expect(status.length).toBeLessThan(120)
})

test('a title cut in the status line never leaves half an emoji', async ($, on) => {
  const target = `${'x'.repeat(38)}${'\u{1F600}'.repeat(5)}`
  const world = await startSession($, on, files => seedProposal(files, { ...SEEDED, target }))

  const status = lastStatus(world) ?? ''
  expect(status).toContain('\u{1F600}... (/quartermaster)')
  expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(status)).toBe(false)
})

test('Later records the impression and closes the detail', async ($, on) => {
  const world = await startSession($, on, seedProposal)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  await ui.press({ key: 'P-0007' })
  await ui.press({ key: 'later' })

  expect(impressionKinds(world)).toEqual(['not-now', 'not-now'])
  expect(world.files.get(`${QUARTERMASTER_FOLDER}/proposals/P-0007.md`)?.includes('status: offered')).toBe(true)
  expect(await ui.find({ key: 'approve' })).toBe(undefined)
  await ui.unmount()
})

const lastStatus = (world: World): string | undefined => world.statuses[world.statuses.length - 1]

test('Later takes the proposal out of the count and the pane draws it as a dim row saying until when', async ($, on) => {
  const world = await startSession($, on, seedProposal)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'P-0007' })
  await ui.press({ key: 'later' })

  expect(lastStatus(world)).toBe(undefined)
  const row = await ui.find({ type: 'Text', text: /set aside/ })
  expect(row?.text).toBe('Add a script for: npm run build: set aside until 2026-11-19')
  expect(await ui.find({ type: 'Text', text: 'Waiting on you' })).toBe(undefined)
  await ui.unmount()
})

test('the status line names the first proposal and counts the rest, and is cleared with none', async ($, on) => {
  const world = await startSession($, on, files => {
    seedProposal(files)
    seedProposal(files, { ...SEEDED, id: 'P-0008', target: 'npm test' })
    seedProposal(files, { ...SEEDED, id: 'P-0009', target: 'npm lint', status: 'applied' })
  })
  expect(lastStatus(world)).toBe('Quartermaster: 2 to review: Add a script for: npm run build and 1 more (/quartermaster)')
})

test('with nothing waiting the status line is cleared', async ($, on) => {
  const world = await startSession($, on, () => undefined)

  expect(lastStatus(world)).toBe(undefined)
})

test('a press whose proposal write fails keeps the row and says what failed in the pane', async ($, on) => {
  const world = await startSession($, on, seedProposal)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  brokenWrites.pathPart = '/proposals/'

  await ui.press({ key: 'P-0007' })
  await ui.press({ key: 'reject' })

  expect(world.files.get(`${QUARTERMASTER_FOLDER}/proposals/P-0007.md`)?.includes('status: offered')).toBe(true)
  expect(world.files.get(`${QUARTERMASTER_FOLDER}/rejected.md`)).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /^Your answer for P-0007 was not saved: / }))?.text).toContain('fs.write')
  expect(await ui.find({ key: 'reject' })).toBeDefined()
  expect(world.toasts).toHaveLength(1)
  expect(world.toasts[0]).toMatch(/^Your answer for P-0007 was not saved: /)
  expect(lastStatus(world)).toBe('Quartermaster: 1 to review: Add a script for: npm run build (/quartermaster)')

  brokenWrites.pathPart = undefined
  await ui.press({ key: 'reject' })
  expect(world.files.get(`${QUARTERMASTER_FOLDER}/proposals/P-0007.md`)?.includes('status: declined')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /^Your answer for/ })).toBe(undefined)
  await ui.unmount()
})

test('opening the pane reads the proposal files again, so one written behind the session back is seen', async ($, on) => {
  const world = await startSession($, on, seedProposal)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'P-0008' })).toBe(undefined)

  seedProposal(world.files, { ...SEEDED, id: 'P-0008', target: 'npm test' })
  await runQuartermasterCommand($)

  expect((await ui.find({ key: 'P-0008' }))?.text).toBe('Add a script for: npm test')
  expect(lastStatus(world)).toBe('Quartermaster: 2 to review: Add a script for: npm run build and 1 more (/quartermaster)')
  await ui.unmount()
})

test('Ignore in this project records a rejection and the noticed line leaves the list', async ($, on) => {
  const world = await startSession($, on, seedCandidate)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: FINGERPRINT })
  await ui.press({ key: 'never' })

  expect((world.files.get(`${QUARTERMASTER_FOLDER}/rejected.md`) ?? '').includes(`\`${FINGERPRINT}\``)).toBe(true)
  expect(await ui.find({ key: FINGERPRINT })).toBe(undefined)
  await ui.unmount()
})

test('Later on a noticed line starts the backoff, so the next offer waits', async ($, on) => {
  const world = await startSession($, on, seedCandidate)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: FINGERPRINT })
  await ui.press({ key: 'not-now' })
  await endTurn($)

  expect(impressionKinds(world)).toEqual(['not-now'])
  expect(world.toasts).toEqual([])
  expect(await ui.find({ key: FINGERPRINT })).toBe(undefined)
  await ui.unmount()
})

test('Draft a fix queues resupply for that noticed line', async ($, on) => {
  const world = await startSession($, on, seedCandidate)
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })

  await ui.press({ key: FINGERPRINT })
  await ui.press({ key: 'draft' })

  expect(world.ran).toEqual([`/quartermaster:resupply ${FINGERPRINT}`])
  await ui.unmount()
})

test('the offer fires once per session, is reviewed by /quartermaster, and adds nothing to the transcript', async ($, on) => {
  const world = await startSession($, on, seedCandidate)

  expect(await endTurn($)).toEqual({ text: '' })
  await endTurn($)

  expect(world.toasts).toEqual([`Quartermaster: ${SENTENCE}. Type /quartermaster to see a fix.`])
  expect(await runQuartermasterCommand($)).toEqual({})
  await endSession($)
  expect(impressionKinds(world)).toEqual(['shown', 'review'])
})

test('an offer nobody reviews is logged as ignored when the session ends', async ($, on) => {
  const world = await startSession($, on, seedCandidate)

  await endTurn($)
  await endSession($)

  expect(impressionKinds(world)).toEqual(['shown', 'ignored'])
})

test('the offer respects the backoff after an ignored offer', async ($, on) => {
  const yesterday = new Date(NOW - DAY_MS).toISOString()
  const world = await startSession($, on, files => {
    seedCandidate(files)
    files.set(IMPRESSIONS, `${JSON.stringify({ at: yesterday, fingerprint: FINGERPRINT, kind: 'ignored' })}\n`)
  })

  await endTurn($)

  expect(world.toasts).toEqual([])
})

test('no offer when the candidate was rejected', async ($, on) => {
  const world = await startSession($, on, files => {
    seedCandidate(files)
    files.set(`${QUARTERMASTER_FOLDER}/rejected.md`, `# Rejected\n\n- \`${FINGERPRINT}\` 2026-11-10: not here\n`)
  })

  await endTurn($)

  expect(world.toasts).toEqual([])
})

test('no offer mid-work: an aborted turn or a running agent', async ($, on) => {
  const world = await startSession($, on, seedCandidate)

  await $.turn.complete({ answer: '', durationMs: 10, isAborted: true, turnId: 't2', reason: 'aborted' })

  expect(world.toasts).toEqual([])
  expect(isRealPause({ reason: 'answer' }, ['running'])).toBe(false)
  expect(isRealPause({ reason: 'answer' }, ['completed', 'idle'])).toBe(true)
})

test('/quartermaster answers in text where nothing draws a pane', async ($, on) => {
  const world = await startSession($, on, files => {
    seedCandidate(files)
    seedProposal(files)
  })
  world.isPlaced = false

  const answer = await runQuartermasterCommand($)

  expect(answer.text).toBe(
    [
      'Quartermaster inbox in repo:',
      'Waiting on you:',
      '- P-0007 Add a script for: npm run build. Quartermaster checks later whether this helped: hand-typed npm run build per week. Today: 14.',
      'Noticed in this project:',
      `- ${SENTENCE}`,
      '',
      'Answer in this chat, by id: say "approve P-0007", "reject P-0007", "already handled P-0007" or "later P-0007".',
    ].join('\n'),
  )
})

test('a candidate already proposed or rejected is not noticed, and backoff picks the next one', async () => {
  const candidate = (fingerprint: string) => ({
    fingerprint,
    kind: 'script' as const,
    target: fingerprint,
    count: 9,
    firstSeen: '',
    lastSeen: '',
    sentence: fingerprint,
  })
  const records = {
    proposals: [{ ...SEEDED, evidence: ['script:a'] }],
    rejected: ['script:b'],
  }
  const noticed = noticedCandidates([candidate('script:a'), candidate('script:b'), candidate('script:c')], records)
  expect(noticed.map(each => each.fingerprint)).toEqual(['script:c'])

  const pushedBack = [{ at: new Date(NOW).toISOString(), fingerprint: 'script:c', kind: 'not-now' as const }]
  expect(candidateToOffer(noticed, pushedBack, NOW)).toBe(undefined)
  expect(candidateToOffer(noticed, pushedBack, NOW + 4 * DAY_MS)?.fingerprint).toBe('script:c')
  expect(inboxText({ proposals: [], rejected: [] }, [], 'repo')).toBe('Quartermaster has nothing for you in repo.')
})

const EVENTS_FOLDER = '/home/.claude/quartermaster/events/repo'

const sessionFile = (files: Map<string, string>, day: string, session: string, text = ''): void => {
  files.set(`${EVENTS_FOLDER}/${day}.${session}.jsonl`, text)
}

/** Sixteen sessions over seven days holding thirty-two hand-typed commands: past every threshold for a round. */
const seedPileForRound = (files: Map<string, string>): void => {
  for (let session = 0; session < 16; session++) {
    const day = `2026-11-${String(4 + (session % 7)).padStart(2, '0')}`
    sessionFile(files, day, `s${session}`, commandRuns(day, 2))
  }
}

const seedAppliedChange = (files: Map<string, string>, laterDays: readonly string[] = ['2026-11-11', '2026-11-12', '2026-11-13']): void => {
  seedProposal(files, { ...SEEDED, status: 'applied', created: '2026-11-01', evidence: [] })
  files.set(
    `${QUARTERMASTER_FOLDER}/changes/C-0007/change.json`,
    JSON.stringify({ id: 'C-0007', proposal: 'P-0007', created: '2026-11-10T09:00:00.000Z', files: [] }),
  )
  laterDays.forEach((day, index) => sessionFile(files, day, `r${index}`))
}

const ROUND_TOAST =
  'Quartermaster: 16 sessions and 32 snags in the last 30 days. Type /quartermaster:resupply to see what would make this easier.'
const REVIEW_TOAST =
  'Quartermaster: change C-0007 (Add a script for: npm run build) has had 3 sessions to show whether it helps. Type /quartermaster:review to judge it.'

const offeredRound = (world: World): boolean => world.toasts.some(toast => toast.includes('/quartermaster:resupply'))

test('evidence past the threshold with no round since is one offer of a resupply round, and it starts nothing', async ($, on) => {
  const world = await startSession($, on, seedPileForRound)

  await endTurn($)
  await endTurn($)

  expect(world.toasts).toEqual([ROUND_TOAST])
  expect(world.ran).toEqual([])
  expect([...world.files.keys()].some(path => path.includes('/proposals/'))).toBe(false)
})

test('an applied change whose check window has passed is one offer of the review, naming the change', async ($, on) => {
  const world = await startSession($, on, files => seedAppliedChange(files))

  await endTurn($)
  await endTurn($)

  expect(world.toasts).toEqual([REVIEW_TOAST])
  expect(world.ran).toEqual([])
})

test('inside the window, nothing is offered for the change', async ($, on) => {
  const world = await startSession($, on, files => seedAppliedChange(files, ['2026-11-11', '2026-11-12']))

  await endTurn($)

  expect(world.toasts).toEqual([])
})

test('below the threshold nothing is offered for a round', async ($, on) => {
  const world = await startSession($, on, files => {
    seedPileForRound(files)
    files.delete(`${EVENTS_FOLDER}/2026-11-04.s0.jsonl`)
    files.delete(`${EVENTS_FOLDER}/2026-11-05.s1.jsonl`)
  })

  await endTurn($)

  expect(offeredRound(world)).toBe(false)
})

test('when both are due one is shown, and the other is not shown in the same session', async ($, on) => {
  const world = await startSession($, on, files => {
    seedPileForRound(files)
    seedAppliedChange(files)
  })

  await endTurn($)
  await endTurn($)

  expect(world.toasts).toHaveLength(1)
  expect(world.toasts[0]).toContain('/quartermaster:review')
})

test('an ignored offer of a round is not shown again until its back-off has passed', async ($, on) => {
  const yesterday = new Date(NOW - DAY_MS).toISOString()
  const world = await startSession($, on, files => {
    seedPileForRound(files)
    files.set(IMPRESSIONS, `${JSON.stringify({ at: yesterday, fingerprint: 'offer:resupply', kind: 'ignored' })}\n`)
  })

  await endTurn($)

  expect(offeredRound(world)).toBe(false)
})

test('an offer nobody answers is logged as ignored when the session ends', async ($, on) => {
  const world = await startSession($, on, seedPileForRound)

  await endTurn($)
  await endSession($)

  expect(impressionKinds(world)).toEqual(['shown', 'ignored'])
})

test('running the offered skill is the answer, so it is not logged as ignored', async ($, on) => {
  const world = await startSession($, on, seedPileForRound)

  await endTurn($)
  await $.skill.prompt({ skill: 'quartermaster:resupply', text: '' })
  await endSession($)

  expect(impressionKinds(world)).toEqual(['shown', 'review'])
})

test('a hand-written change record with no creation time, or a number, is left out and nothing else stops', async ($, on) => {
  const world = await startSession($, on, files => {
    seedCandidate(files)
    seedAppliedChange(files)
    files.set(`${QUARTERMASTER_FOLDER}/changes/C-0007/change.json`, JSON.stringify({ id: 'C-0007', proposal: 'P-0007', files: [] }))
    seedProposal(files, { ...SEEDED, id: 'P-0008', status: 'loaded', created: '2026-11-01', evidence: [] })
    files.set(`${QUARTERMASTER_FOLDER}/changes/C-0008/change.json`, JSON.stringify({ id: 'C-0008', proposal: 'P-0008', created: 1763000000000, files: [] }))
  })

  await endTurn($)

  expect(world.toasts).toEqual([`Quartermaster: ${SENTENCE}. Type /quartermaster to see a fix.`])
})

test('the inbox names the project from the checkout that holds a session worktree, and never by a slash', () => {
  expect(projectNameOf('C:\\work\\photo-library\\.claude\\worktrees\\agent-1')).toBe('photo-library')
  expect(projectNameOf('/home/me/repo/.claude/worktrees/agent-1')).toBe('repo')
  expect(projectNameOf('/home/me/repo/')).toBe('repo')
  expect(projectNameOf('/')).toBe(UNNAMED_PROJECT)
})
