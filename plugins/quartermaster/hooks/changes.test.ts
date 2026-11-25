import { expect, test } from 'claude-code/testing'

import { planRollback } from './changes'
import { FIRST_BACKOFF_DAYS, mayOfferNow, nextOffer } from './impressions'
import type { Impression } from './impressions'

test('a rollback restores what existed and deletes what the change created, when each is as the change left it', async () => {
  const steps = planRollback([
    { path: 'scripts/build.sh', existed: false, written: 'echo built', current: 'echo built' },
    { path: '.claude/settings.json', existed: true, prior: '{}', written: '{"a":1}', current: '{"a":1}' },
  ])

  expect(steps).toEqual([
    { action: 'delete', path: 'scripts/build.sh' },
    { action: 'restore', path: '.claude/settings.json', prior: '{}' },
  ])
})

test('a file that already holds its prior bytes, or is already gone, has nothing left to undo', async () => {
  expect(
    planRollback([
      { path: 'a.json', existed: true, prior: '{}', written: '{"a":1}', current: '{}' },
      { path: 'b.sh', existed: false, written: 'echo', current: undefined },
    ]),
  ).toEqual([
    { action: 'already-undone', path: 'a.json' },
    { action: 'already-undone', path: 'b.sh' },
  ])
})

test('a file edited after the change is left, with the difference and what the change did', async () => {
  const [step] = planRollback([{ path: 'a.json', existed: true, prior: '{}', written: 'one\ntwo', current: 'one\nthree' }])

  expect(step).toEqual({
    action: 'leave',
    path: 'a.json',
    report: [
      'a.json changed since the change was applied, so it was left alone.',
      'Since then (- what the change wrote, + what the file holds now):',
      '- two',
      '+ three',
      'To undo the change by hand (- it removed, + it added):',
      '- {}',
      '+ one',
      '+ two',
    ].join('\n'),
  })
})

test('the difference shown stops at twenty lines and says how many more there are', async () => {
  const written = Array.from({ length: 25 }, (_, index) => `line ${index}`).join('\n')
  const [step] = planRollback([{ path: 'a.txt', existed: true, prior: '', written, current: 'edited' }])

  expect(step?.action === 'leave' && step.report.includes('... 6 more lines')).toBe(true)
})

test('a record without saved written bytes is left alone and the report says it cannot tell', async () => {
  const [step] = planRollback([{ path: 'a.json', existed: true, prior: '{}', current: '{"a":1}' }])

  expect(step?.action === 'leave' && step.report.includes('cannot tell whether the file changed since')).toBe(true)
})

const DAY_MS = 24 * 60 * 60 * 1000
const START = Date.parse('2026-11-01T00:00:00.000Z')

const impression = (days: number, kind: Impression['kind']): Impression => ({
  at: new Date(START + days * DAY_MS).toISOString(),
  fingerprint: 'script:npm run',
  kind,
})

test('a fingerprint never pushed back can be offered now', async () => {
  expect(nextOffer('script:npm run', [impression(0, 'shown')])).toEqual({ kind: 'now' })
})

test('an ignored offer waits three days, and the wait doubles each time', async () => {
  expect(nextOffer('script:npm run', [impression(0, 'ignored')])).toEqual({
    kind: 'after',
    at: START + FIRST_BACKOFF_DAYS * DAY_MS,
  })
  expect(nextOffer('script:npm run', [impression(0, 'ignored'), impression(4, 'not-now')])).toEqual({
    kind: 'after',
    at: START + (4 + 2 * FIRST_BACKOFF_DAYS) * DAY_MS,
  })
})

test('never ends offers for good and leaves other fingerprints alone', async () => {
  const impressions = [impression(0, 'never')]

  expect(mayOfferNow('script:npm run', impressions, START + 365 * DAY_MS)).toBe(false)
  expect(mayOfferNow('fix:edit', impressions, START)).toBe(true)
})

test('an offer is allowed again once the wait is over', async () => {
  const impressions = [impression(0, 'not-now')]

  expect(mayOfferNow('script:npm run', impressions, START + 2 * DAY_MS)).toBe(false)
  expect(mayOfferNow('script:npm run', impressions, START + 3 * DAY_MS)).toBe(true)
})
