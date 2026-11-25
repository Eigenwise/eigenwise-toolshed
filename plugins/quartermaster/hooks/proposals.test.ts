import { expect, test } from 'claude-code/testing'

import { fingerprintOf } from './detectors'
import { failureSignature } from './events'
import { canMove, nextProposalId, parseProposal, proposalProblems, serializeProposal } from './proposals'
import type { Proposal } from './proposals'
import { parseRejections, serializeRejections, withRejections } from './rejections'

const PROPOSAL: Proposal = {
  id: 'P-0007',
  kind: 'script',
  target: 'npm run build:docs',
  status: 'offered',
  authority: 'ask',
  evidence: ['script:npm run', 'fix:bash: npm run'],
  expect: 'hand runs of `npm run` per week',
  baseline: 14,
  created: '2026-11-16',
  body: '## What\nA script.\n\n## Rollback\nDelete it.',
}

test('a proposal survives a round trip through its file', async () => {
  const text = serializeProposal(PROPOSAL)

  expect(text.startsWith('---\nid: P-0007\nkind: script\n')).toBe(true)
  expect(text.includes('evidence: [script:npm run, fix:bash: npm run]')).toBe(true)
  expect(parseProposal(text)).toEqual({ proposal: PROPOSAL })
})

test('a proposal with a kind outside the enum names the allowed kinds', async () => {
  const parsed = parseProposal(serializeProposal(PROPOSAL).replace('kind: script', 'kind: other'))

  expect('problems' in parsed && parsed.problems[0]?.startsWith('kind must be one of skill,')).toBe(true)
})

test('a proposal without frontmatter or with a bad baseline is refused', async () => {
  expect(parseProposal('just text')).toEqual({ problems: ['the file has no frontmatter between --- lines'] })
  expect(parseProposal(serializeProposal({ ...PROPOSAL, baseline: -1 }))).toEqual({
    problems: ['baseline must be a count, zero or more'],
  })
})

test('the ladder allows forward moves and refuses the rest', async () => {
  expect(canMove('offered', 'accepted')).toBe(true)
  expect(canMove('applied', 'rolled-back')).toBe(true)
  expect(canMove('offered', 'applied')).toBe(false)
  expect(canMove('declined', 'accepted')).toBe(false)
  expect(canMove('useful', 'applied')).toBe(false)
})

test('a failure whose text has a comma still gives a fingerprint a proposal can cite', async () => {
  const signature = failureSignature("Error: ENOENT: no such file or directory, open 'C:/repo/a.json'")
  const fingerprint = fingerprintOf('fix', `Read: ${signature}`)

  expect(fingerprint).toBe('fix:read: error: enoent: no such file or directory open')
  expect(proposalProblems({ ...PROPOSAL, evidence: [fingerprint] })).toEqual([])
})

test('the next id follows the highest one on disk', async () => {
  expect(nextProposalId([])).toBe('P-0001')
  expect(nextProposalId(['P-0002.md', 'P-0010.md', 'notes.md'])).toBe('P-0011')
})

test('rejections round trip and a fingerprint is listed once', async () => {
  const first = [{ fingerprint: 'script:npm run', reason: 'I like typing it', date: '2026-11-16' }]
  const merged = withRejections(first, [{ fingerprint: 'script:npm run', reason: 'again', date: '2026-11-17' }])

  expect(merged).toEqual(first)
  expect(parseRejections(serializeRejections(merged))).toEqual(first)
})
