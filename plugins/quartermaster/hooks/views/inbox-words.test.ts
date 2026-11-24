import { expect, test } from 'claude-code/testing'

import { proposalInWords, proposalLine, refusalInWords, whyItWasProposed } from './inbox'
import type { Candidate, ProposalCard } from './inbox'

const card = (fields: Partial<ProposalCard>): ProposalCard => ({
  id: 'P-0003',
  kind: 'rule',
  target: 'no floating promises',
  status: 'offered',
  evidence: [],
  expect: '',
  baseline: 0,
  created: '2026-11-20',
  body: '',
  ...fields,
})

test('a proposal reads as what it would do, and only the text form carries its id', () => {
  expect(proposalInWords(card({}))).toBe('Add a rule: no floating promises')
  expect(proposalInWords(card({ kind: 'permission', target: '`npm run lint`' }))).toBe('Let Claude run `npm run lint` without asking')
  expect(proposalInWords(card({ kind: 'retire', target: 'old-skill' }))).toBe('Remove unused: old-skill')
  expect(proposalInWords(card({ kind: 'something-new', target: 'x' }))).toBe('something-new: x')
  expect(proposalLine(card({}))).toBe('P-0003 Add a rule: no floating promises')
})

test('why it was proposed is the noticed sentence, and nothing once that stopped happening', () => {
  const noticed: Candidate = {
    fingerprint: 'script:npm run build',
    kind: 'script',
    target: 'npm run build',
    count: 9,
    firstSeen: '2026-11-18T09:00:00.000Z',
    lastSeen: '2026-11-23T09:00:00.000Z',
    sentence: 'ran `npm run build` by hand 9 times over 3 days',
  }
  const proposed = card({ evidence: ['script:npm run build', 'script:gone since'] })

  expect(whyItWasProposed(proposed, [noticed])).toEqual(['Why: ran `npm run build` by hand 9 times over 3 days'])
  expect(whyItWasProposed(proposed, [])).toEqual([])
})

test('a refusal written for the session is toasted in a few plain words', () => {
  expect(refusalInWords('quartermaster: P-0003 is accepted and cannot become accepted; from accepted it can become applied')).toBe(
    'That one was already answered.',
  )
  expect(refusalInWords('quartermaster: there is no proposal P-0003')).toBe(
    "That suggestion's file is missing or broken: .claude/quartermaster/proposals/P-0003.md",
  )
  expect(refusalInWords('quartermaster: the disk is full')).toBe('Quartermaster could not do that: the disk is full')
})
