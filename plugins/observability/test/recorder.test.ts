import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TYPED_IN_COMPOSER = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }
const REPO = { root: '/work/demo', remote: null, internal: false, name: 'demo' }

function fakeProject(on: On) {
  mock.store(on)
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg' })
  on('session.repo', () => ({ value: REPO }))
}

test('track reports, turns on and turns off recording for this project', async ($, on) => {
  fakeProject(on)
  const track = async (args: string) => (await $.command.run({ command: 'track', args, ...TYPED_IN_COMPOSER })).text ?? ''

  expect(await track('status')).toContain('not recording turns for /work/demo')
  expect(await track('on')).toContain('recording turns for /work/demo, into /cfg/observability/ledger/demo-7b8bd8.jsonl')
  expect(await track('')).toContain('into /cfg/observability/ledger/demo-7b8bd8.jsonl')
  expect(await track('off')).toContain('not recording')
  expect(await track('sideways')).toContain('Usage: /observability:track on|off|status')
})

// A session and a file system in memory; returns the files written, keyed by forward-slash path.
function fakeSession(on: On, onComplete?: () => void) {
  fakeProject(on)
  const files = new Map<string, string>()
  const slashed = (path: string) => path.replace(/\\/g, '/')
  on('fs.exists', ($$, e) => ({ value: files.has(slashed(e.path)) }))
  on('fs.read', ($$, e) => ({ value: files.get(slashed(e.path)) ?? '' }))
  on('fs.write', ($$, e) => {
    files.set(slashed(e.path), e.text)
    return { value: undefined }
  })
  on('fs.list', () => ({ value: [] }))
  on('prompt.submit', ($$, e) => ({ text: e.text }))
  on('turn.complete', ($, event) => {
    onComplete?.()
    return { text: event.answer }
  })
  on('session.usage', () => ({ value: { startedAt: 1000, context: { window: 200000, tokens: 5000, percent: 2.5 }, rateLimits: [], cost: { usd: 0.75 } } }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.turns', () => ({ value: 1 }))
  on('session.model', () => ({ value: 'claude-opus' }))
  on('session.version', () => ({ value: { version: '2.1.302' } }))
  return files
}

const LEDGER = /\/cfg\/observability\/ledger\/demo-7b8bd8\.jsonl$/
const BOARD = /\/cfg\/observability\/board\.html$/

test('a tracked turn appends one row to the project ledger and rebuilds the board two seconds later', async ($, on) => {
  const files = fakeSession(on)
  const clock = mock.clock(on)
  await $.command.run({ command: 'track', args: 'on', ...TYPED_IN_COMPOSER })

  await $.prompt.submit({ text: 'Fix SQ-12 now\nplease', origin: { kind: 'composer' }, wait: false })
  await $.turn.complete({ answer: 'done', durationMs: 900, isAborted: false, turnId: 't1', reason: 'answer' })

  expect([...files.keys()]).toEqual([expect.stringMatching(LEDGER)])
  const rows = ([...files.values()][0] ?? '').trim().split('\n').map(line => JSON.parse(line))
  expect(rows.length).toBe(1)
  expect(rows[0]).toMatchObject({ v: 1, name: 'Fix SQ-12 now', ticket: 'SQ-12', project: 'demo-7b8bd8', session: 'session-1', reason: 'answer', durationMs: 900, model: 'claude-opus' })

  await clock.advance(2000)
  expect([...files.keys()]).toEqual([expect.stringMatching(LEDGER), expect.stringMatching(BOARD)])
})

test('an untracked project records nothing', async ($, on) => {
  const files = fakeSession(on)
  const clock = mock.clock(on)

  await $.prompt.submit({ text: 'Fix SQ-12 now', origin: { kind: 'composer' }, wait: false })
  await $.turn.complete({ answer: 'done', durationMs: 900, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(2000)

  expect([...files.keys()]).toEqual([])
})


test('turn quality uses fresh post-completion state for this cwd and omits stale or absent state', async ($, on) => {
  let completed = false
  const files = fakeSession(on, () => { completed = true })
  const clock = mock.clock(on)
  await clock.advance(10000)
  on('session.cwd', () => ({ value: '/work/demo/subdirectory' }))
  const at = new Date(clock.now()).toISOString()
  const measurement = {
    at,
    bodies: [
      { file: 'example.ts', name: 'newBody', cc: 6, state: 'new' as const, verdict: 'fail' },
      { file: 'example.ts', name: 'raisedBody', cc: 7, state: 'modified-raised' as const, verdict: 'fail' },
      { file: 'example.ts', name: 'legacyBody', cc: 12, state: 'legacy-unchanged' as const, verdict: 'unverified' },
    ],
    signals: [], unverified: true, tests: { status: 'pass' as const, at, stale: true },
  }
  let published: Record<string, typeof measurement> | undefined
  on('state.get', { plugin: 'quality-gate', key: 'turn' }, ($$, event, next) => {
    expect(completed).toBe(true)
    if (published === undefined) return next(event)
    return { value: { value: published, version: 1 } }
  })
  await $.command.run({ command: 'track', args: 'on', ...TYPED_IN_COMPOSER })
  published = { '/work/demo/subdirectory': measurement, '/work/demo': { ...measurement, bodies: [] } }
  await $.turn.complete({ answer: 'done', durationMs: 900, isAborted: false, turnId: 'fresh', reason: 'answer' })
  published = { '/work/demo/subdirectory': { ...measurement, at: new Date(Date.parse(at) - 901).toISOString() } }
  await $.turn.complete({ answer: 'done', durationMs: 900, isAborted: false, turnId: 'stale', reason: 'answer' })
  published = undefined
  await $.turn.complete({ answer: 'done', durationMs: 900, isAborted: false, turnId: 'absent', reason: 'answer' })
  const rows = ([...files.values()][0] ?? '').trim().split('\n').map(line => JSON.parse(line))
  expect(rows.length).toBe(3)
  expect(rows[0].quality).toEqual({ at, ccMax: 12, split: 2, unverified: true, tests: { status: 'pass', stale: true } })
  expect(rows[1].quality).toBeUndefined()
  expect(rows[2].quality).toBeUndefined()
})
