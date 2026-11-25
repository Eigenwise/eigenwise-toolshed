import { expect, test } from 'claude-code/testing'

import type { Candidate } from './detectors'
import type { SensedEvent } from './events'
import type { Proposal } from './proposals'
import {
  REVIEW_MIN_SESSIONS,
  ROUND_MIN_DAYS,
  ROUND_MIN_SESSIONS,
  ROUND_MIN_SNAGS,
  dueOffers,
  dueOffersOrNone,
  hasUsableCreated,
  lastRoundDay,
  sessionDaysAfter,
} from './standing-due'
import type { AppliedChange, Due, EvidenceSoFar } from './standing-due'
import { standingToOffer, standingToast } from './views/offer'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-11-16T10:00:00.000Z')

const dayName = (dayNumber: number): string => `2026-11-${String(dayNumber).padStart(2, '0')}`

const sessionFilesOn = (days: readonly number[]): string[] => days.map((day, index) => `${dayName(day)}.s${index}.jsonl`)

const snags = (count: number, day = 10): SensedEvent[] =>
  Array.from({ length: count }, () => ({ kind: 'typed' as const, at: `${dayName(day)}T09:00:00.000Z`, prefix: 'npm run' }))

const CANDIDATE: Candidate = {
  fingerprint: 'script:npm run',
  kind: 'script',
  target: 'npm run',
  count: 14,
  firstSeen: '2026-11-10T09:00:00.000Z',
  lastSeen: '2026-11-15T09:00:00.000Z',
  sentence: 'ran `npm run` by hand 14 times over 2 days',
}

const PROPOSAL: Proposal = {
  id: 'P-0007',
  kind: 'script',
  target: 'npm run build',
  status: 'applied',
  authority: 'ask',
  evidence: ['script:npm run build'],
  expect: 'hand-typed npm run build per week',
  baseline: 14,
  created: '2026-11-10',
  body: '',
}

const CHANGE: AppliedChange = { id: 'C-0007', proposal: 'P-0007', kind: 'script', target: 'npm run build', created: '2026-11-10T09:00:00.000Z' }

// Sixteen sessions over seven days with thirty-two snags: just past every threshold, with something to look at.
const PILED_UP: EvidenceSoFar = {
  events: snags(ROUND_MIN_SNAGS + 2),
  sessionFiles: sessionFilesOn([4, 5, 6, 7, 8, 9, 10, 4, 5, 6, 7, 8, 9, 10, 4, 5]),
  candidates: [CANDIDATE],
  proposals: [],
  changes: [],
  now: NOW,
}

const skillRun = (skill: string, day: number): SensedEvent => ({ kind: 'skill', at: `${dayName(day)}T09:00:00.000Z`, skill })

test('sessions after a day are counted per session file, each file once', () => {
  const files = ['2026-11-09.a.jsonl', '2026-11-10.a.jsonl', '2026-11-10.b.jsonl', '2026-11-10.b.jsonl', '2026-11-11.jsonl']

  expect(sessionDaysAfter(files, '2026-11-09')).toEqual(['2026-11-10', '2026-11-10', '2026-11-11'])
  expect(sessionDaysAfter(files, undefined)).toHaveLength(4)
})

test('enough sessions, days and snags with something to look at is one resupply round to offer', () => {
  expect(dueOffers(PILED_UP)).toEqual([{ kind: 'resupply', sessions: 16, snags: ROUND_MIN_SNAGS + 2 }])
})

test('below any one threshold, or with nothing to look at, no round is offered', () => {
  expect(ROUND_MIN_SESSIONS).toBe(15)
  expect(dueOffers({ ...PILED_UP, sessionFiles: PILED_UP.sessionFiles.slice(0, ROUND_MIN_SESSIONS - 1) })).toEqual([])
  expect(dueOffers({ ...PILED_UP, events: snags(ROUND_MIN_SNAGS - 1) })).toEqual([])
  expect(dueOffers({ ...PILED_UP, sessionFiles: sessionFilesOn(Array.from({ length: 16 }, (_, index) => 4 + (index % (ROUND_MIN_DAYS - 1)))) })).toEqual([])
  expect(dueOffers({ ...PILED_UP, candidates: [] })).toEqual([])
})

test('a candidate that already has a proposal is not something to look at', () => {
  const proposal: Proposal = { ...PROPOSAL, status: 'declined', created: '2026-11-01', evidence: [CANDIDATE.fingerprint] }

  expect(dueOffers({ ...PILED_UP, proposals: [proposal] })).toEqual([])
})

test('a candidate closed as already handled is something to look at again once the evidence window has passed', () => {
  const handled = (answered: string | undefined): Proposal => ({
    ...PROPOSAL,
    status: 'handled',
    created: '2026-08-30',
    evidence: [CANDIDATE.fingerprint],
    ...(answered === undefined ? {} : { answered }),
  })

  expect(dueOffers({ ...PILED_UP, proposals: [handled('2026-09-02')] })).toHaveLength(1)
  expect(dueOffers({ ...PILED_UP, proposals: [handled('2026-11-10')] })).toEqual([])
  expect(dueOffers({ ...PILED_UP, proposals: [handled(undefined)] })).toHaveLength(1)
  expect(dueOffers({ ...PILED_UP, proposals: [{ ...handled('2026-09-02'), status: 'declined' }] })).toEqual([])
})

test('right after a round nothing is offered, whether it left a proposal or only ran', () => {
  const afterProposal = { ...PILED_UP, proposals: [{ ...PROPOSAL, status: 'offered' as const, evidence: [], created: dayName(10) }] }
  const afterRun = { ...PILED_UP, events: [...PILED_UP.events, skillRun('quartermaster:resupply', 10)] }

  expect(lastRoundDay(afterRun.events, [])).toBe(dayName(10))
  expect(dueOffers(afterProposal)).toEqual([])
  expect(dueOffers(afterRun)).toEqual([])
})

test('a round counts only the evidence after it', () => {
  const roundOnDay = (day: number) => ({ ...PILED_UP, events: [...PILED_UP.events, skillRun('resupply', day)] })

  expect(dueOffers(roundOnDay(3))).toHaveLength(1)
  expect(dueOffers(roundOnDay(4))).toEqual([])
})

test('a change is offered for review once three sessions have passed since it landed', () => {
  const sessionFiles = sessionFilesOn([10, 11, 12, 13])
  const base: EvidenceSoFar = { events: [], sessionFiles, candidates: [], proposals: [PROPOSAL], changes: [CHANGE], now: NOW }

  expect(REVIEW_MIN_SESSIONS).toBe(3)
  expect(dueOffers(base)).toEqual([{ kind: 'review', change: 'C-0007', proposalKind: 'script', target: 'npm run build', sessions: 3, more: 0 }])
  expect(dueOffers({ ...base, sessionFiles: sessionFilesOn([10, 11, 12]) })).toEqual([])
})

test('a review that ran after the window closed answers it, one that ran too early does not', () => {
  const base: EvidenceSoFar = { events: [], sessionFiles: sessionFilesOn([11, 12, 13, 14]), candidates: [], proposals: [PROPOSAL], changes: [CHANGE], now: NOW }

  expect(dueOffers({ ...base, events: [skillRun('quartermaster:review', 11)] })).toHaveLength(1)
  expect(dueOffers({ ...base, events: [skillRun('quartermaster:review', 13)] })).toEqual([])
})

test('a change already judged or rolled back is not offered', () => {
  const base: EvidenceSoFar = { events: [], sessionFiles: sessionFilesOn([11, 12, 13]), candidates: [], proposals: [PROPOSAL], changes: [CHANGE], now: NOW }

  expect(dueOffers({ ...base, proposals: [{ ...PROPOSAL, status: 'useful' }] })).toEqual([])
  expect(dueOffers({ ...base, proposals: [{ ...PROPOSAL, status: 'rolled-back' }] })).toEqual([])
})

test('when both are due the review comes first and the round is next in line', () => {
  const both: EvidenceSoFar = {
    ...PILED_UP,
    sessionFiles: [...PILED_UP.sessionFiles, ...sessionFilesOn([11, 12, 13])],
    proposals: [{ ...PROPOSAL, created: '2026-11-01' }],
    changes: [CHANGE],
    now: NOW,
  }
  const due = dueOffers(both)

  expect(due.map(each => each.kind)).toEqual(['review', 'resupply'])
  expect(standingToOffer(due, [], NOW)?.kind).toBe('review')
  const reviewIgnored = [{ at: new Date(NOW).toISOString(), fingerprint: 'offer:review', kind: 'ignored' as const }]
  expect(standingToOffer(due, reviewIgnored, NOW)?.kind).toBe('resupply')
})

test('an ignored round waits three days, then six, and is forgotten once a round has run', () => {
  const [round] = dueOffers(PILED_UP)
  if (round === undefined) throw new Error('the pile should be due')
  const ignoredAt = (daysAgo: number) => ({
    at: new Date(NOW - daysAgo * DAY_MS).toISOString(),
    fingerprint: 'offer:resupply',
    kind: 'ignored' as const,
  })

  expect(standingToOffer([round], [ignoredAt(1)], NOW)).toBe(undefined)
  expect(standingToOffer([round], [ignoredAt(3)], NOW)).toBe(round)
  expect(standingToOffer([round], [ignoredAt(7), ignoredAt(3)], NOW)).toBe(undefined)
  expect(standingToOffer([round], [ignoredAt(7), ignoredAt(3)], NOW + 3 * DAY_MS)).toBe(round)
  const afterARound: Due = { kind: 'resupply', sessions: 16, snags: 32, since: dayName(15) }
  expect(standingToOffer([afterARound], [ignoredAt(1.5)], NOW)).toBe(afterARound)
})

test('the offers say what piled up and name the skill to type', () => {
  const [round] = dueOffers(PILED_UP)
  const [review] = dueOffers({ events: [], sessionFiles: sessionFilesOn([11, 12, 13]), candidates: [], proposals: [PROPOSAL], changes: [CHANGE], now: NOW })

  expect(round && standingToast(round)).toBe(
    'Quartermaster: 16 sessions and 32 snags in the last 30 days. Type /quartermaster:resupply to see what would make this easier.',
  )
  expect(standingToast({ kind: 'resupply', sessions: 16, snags: 32, since: dayName(4) })).toBe(
    'Quartermaster: 16 sessions and 32 snags since the last resupply round. Type /quartermaster:resupply to see what would make this easier.',
  )
  expect(review && standingToast(review)).toBe(
    'Quartermaster: change C-0007 (Add a script for: npm run build) has had 3 sessions to show whether it helps. Type /quartermaster:review to judge it.',
  )
})

test('one review offer covers every change due, naming the first and counting the rest', () => {
  const second: AppliedChange = { ...CHANGE, id: 'C-0008', proposal: 'P-0008', target: 'npm test' }
  const proposals = [PROPOSAL, { ...PROPOSAL, id: 'P-0008', target: 'npm test' }]
  const due = dueOffers({ events: [], sessionFiles: sessionFilesOn([11, 12, 13]), candidates: [], proposals, changes: [CHANGE, second], now: NOW })

  expect(due).toHaveLength(1)
  expect(due[0] && standingToast(due[0])).toBe(
    'Quartermaster: change C-0007 (Add a script for: npm run build) and 1 more have had enough sessions to show whether they help. Type /quartermaster:review to judge them.',
  )
})

test('a review or resupply skill of another plugin answers nothing of ours', () => {
  const reviewed: EvidenceSoFar = {
    events: [skillRun('other-plugin:review', 13)],
    sessionFiles: sessionFilesOn([11, 12, 13]),
    candidates: [],
    proposals: [PROPOSAL],
    changes: [CHANGE],
    now: NOW,
  }

  expect(dueOffers(reviewed)).toHaveLength(1)
  expect(dueOffers({ ...PILED_UP, events: [...PILED_UP.events, skillRun('other-plugin:resupply', 10)] })).toHaveLength(1)
})

test('a change record with no usable creation time is never read for a review', () => {
  expect(hasUsableCreated('2026-11-10T09:00:00.000Z')).toBe(true)
  expect(hasUsableCreated(undefined)).toBe(false)
  expect(hasUsableCreated(1763000000000)).toBe(false)
  expect(hasUsableCreated('last tuesday')).toBe(false)
})

test('whatever throws while working out what is due means nothing is due', () => {
  const hostile: EvidenceSoFar = {
    ...PILED_UP,
    get events(): readonly SensedEvent[] {
      throw new Error('broken')
    },
  }

  expect(() => dueOffers(hostile)).toThrow()
  expect(dueOffersOrNone(hostile)).toEqual([])
})
