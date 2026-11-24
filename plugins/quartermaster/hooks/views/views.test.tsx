import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { serializeProposal } from '../proposals'
import type { Proposal } from '../proposals'
import { inboxText, noticedCandidates } from './inbox'
import { candidateToOffer, isRealPause } from './offer'

const NOW = Date.parse('2026-11-16T10:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000
const QM = '/repo/.claude/quartermaster'
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

const fakeDisk = (on: On, files: Map<string, string>): void => {
  on('fs.exists', (_, e) => ({ value: files.has(portable(e.path)) || hasDirectory(files, portable(e.path)) }))
  on('fs.read', (_, e) => ({ value: files.get(portable(e.path)) ?? '' }))
  on('fs.write', (_, e) => {
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
  files.set(`${QM}/proposals/${proposal.id}.md`, serializeProposal(proposal))
}

type World = {
  files: Map<string, string>
  toasts: string[]
  statuses: (string | undefined)[]
  ran: string[]
  isPlaced: boolean
}

const startSession = async ($: Engine, on: On, seed: (files: Map<string, string>) => void): Promise<World> => {
  const world: World = { files: new Map(), toasts: [], statuses: [], ran: [], isPlaced: true }
  seed(world.files)
  fakeDisk(on, world.files)
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home' })
  on('tool.register', (_, e) => ({ value: { tool: `mcp__quartermaster__${e.name}` } }))
  on('command.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'qm' } }))
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
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  return world
}

const endTurn = ($: Engine) =>
  $.turn.complete({ answer: 'done', durationMs: 1200, isAborted: false, turnId: 't1', reason: 'answer' })

const runQm = ($: Engine) =>
  $.command.run({
    command: 'qm',
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
  expect(world.statuses[world.statuses.length - 1]).toBe('Quartermaster: 1 to review')

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
      'Approve makes the change now, and it can be undone. Reject is remembered for this project. Later hides it for a few days.',
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
  expect(world.files.get(`${QM}/proposals/P-0007.md`)?.includes('status: accepted')).toBe(true)
  expect(world.statuses[world.statuses.length - 1]).toBe(undefined)
  await ui.unmount()
})

test('Reject declines the proposal and writes the rejection', async ($, on) => {
  const world = await startSession($, on, seedProposal)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'P-0007' })
  await ui.press({ key: 'reject' })

  const rejected = world.files.get(`${QM}/rejected.md`) ?? ''
  expect(rejected.includes('- `script:npm run build` 2026-11-16: no reason given')).toBe(true)
  expect(world.toasts).toEqual(['Rejected. Quartermaster will not suggest this again in this project.'])
  expect(world.files.get(`${QM}/proposals/P-0007.md`)?.includes('status: declined')).toBe(true)
  expect(world.ran).toEqual([])
  await ui.unmount()
})

test('Reject with a typed reason writes that reason to rejected.md', async ($, on) => {
  const world = await startSession($, on, seedProposal)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'P-0007' })
  await ui.input({ key: 'reason', text: 'we use make here' })

  const rejected = world.files.get(`${QM}/rejected.md`) ?? ''
  expect(rejected.includes('- `script:npm run build` 2026-11-16: we use make here')).toBe(true)
  expect(world.toasts).toEqual(['Rejected. Quartermaster will not suggest this again in this project.'])
  await ui.unmount()
})

test('Later records the impression and closes the detail', async ($, on) => {
  const world = await startSession($, on, seedProposal)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  await ui.press({ key: 'P-0007' })
  await ui.press({ key: 'later' })

  expect(impressionKinds(world)).toEqual(['not-now', 'not-now'])
  expect(world.files.get(`${QM}/proposals/P-0007.md`)?.includes('status: offered')).toBe(true)
  expect(await ui.find({ key: 'approve' })).toBe(undefined)
  await ui.unmount()
})

test('Later hides the proposal from the pane until its wait is over, and it still counts as waiting', async ($, on) => {
  const world = await startSession($, on, seedProposal)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'P-0007' })
  await ui.press({ key: 'later' })

  expect(await ui.find({ key: 'P-0007' })).toBe(undefined)
  expect(world.statuses[world.statuses.length - 1]).toBe('Quartermaster: 1 to review')
  await ui.unmount()
})

test('Ignore in this project records a rejection and the noticed line leaves the list', async ($, on) => {
  const world = await startSession($, on, seedCandidate)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: FINGERPRINT })
  await ui.press({ key: 'never' })

  expect((world.files.get(`${QM}/rejected.md`) ?? '').includes(`\`${FINGERPRINT}\``)).toBe(true)
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

test('the offer fires once per session, is reviewed by /qm, and adds nothing to the transcript', async ($, on) => {
  const world = await startSession($, on, seedCandidate)

  expect(await endTurn($)).toEqual({ text: '' })
  await endTurn($)

  expect(world.toasts).toEqual([`Quartermaster: ${SENTENCE}. Type /qm to see a fix.`])
  expect(await runQm($)).toEqual({})
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
    files.set(`${QM}/rejected.md`, `# Rejected\n\n- \`${FINGERPRINT}\` 2026-11-10: not here\n`)
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

test('/qm answers in text where nothing draws a pane', async ($, on) => {
  const world = await startSession($, on, files => {
    seedCandidate(files)
    seedProposal(files)
  })
  world.isPlaced = false

  const answer = await runQm($)

  expect(answer.text).toBe(
    [
      'Waiting on you:',
      '- P-0007 Add a script for: npm run build. Quartermaster checks later whether this helped: hand-typed npm run build per week. Today: 14.',
      'Noticed in this project:',
      `- ${SENTENCE}`,
      '',
      'Answer by id, like "approve P-0001", "reject P-0001" or "later P-0001".',
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
  expect(inboxText({ proposals: [], rejected: [] }, [])).toBe('Quartermaster has nothing for you.')
})
