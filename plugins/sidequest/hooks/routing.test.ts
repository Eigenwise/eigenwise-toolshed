import { expect, test } from 'claude-code/testing'

import { boardConfigProblems, DEFAULT_BOARD_CONFIG, mergeBoardConfig } from './board-config'
import { boardIdsOf, EARLIER_BOARD_IDS } from './board-ids'
import { frontierOf } from './frontier'
import { NO_PROVIDERS, providersOf, resolveRoute, routeRequestIn, spawnRouteFor } from './routing'
import { boardLocationFrom, withExcludeEntry } from './store'
import { newTicket } from './tickets'
import type { Ticket } from './tickets'

const STAMP = '2026-11-16T10:02Z'
const ticket = (id: string, fields: Partial<Ticket>): Ticket => ({ ...newTicket(id, {}, STAMP), title: id, ...fields })

test('the frontier is ready afk tickets whose blockers are all done', () => {
  const tickets = [
    ticket('SQ-1', { status: 'done' }),
    ticket('SQ-2', { blockedBy: ['SQ-1'] }),
    ticket('SQ-3', { blockedBy: ['SQ-2'] }),
    ticket('SQ-4', { mode: 'hitl' }),
    ticket('SQ-5', { status: 'inbox' }),
    ticket('SQ-6', { blockedBy: ['SQ-99'] }),
  ]

  expect(frontierOf(tickets).map(item => item.id)).toEqual(['SQ-2'])
})

test('a partial board.json merges over the defaults', () => {
  const merged = mergeBoardConfig({
    nextTicket: 13,
    tiers: { deep: { model: 'opus', effort: 'xhigh' }, broken: { model: 3 } },
    categories: { docs: { tier: 'light', role: 'worker' } },
    settings: { worktrees: false },
  })

  expect(merged.nextTicket).toBe(13)
  expect(merged.nextStory).toBe(1)
  expect(merged.tiers.deep).toEqual({ model: 'opus', effort: 'xhigh' })
  expect(merged.tiers.broken).toBe(undefined)
  expect(merged.tiers.light).toEqual(DEFAULT_BOARD_CONFIG.tiers.light)
  expect(merged.categories.docs).toEqual({ tier: 'light', role: 'worker', description: '' })
  expect(merged.settings).toEqual({ verify: '', planReviewPasses: 1, worktrees: false, unrouted: 'build' })
  expect(mergeBoardConfig('not a board')).toEqual(DEFAULT_BOARD_CONFIG)
})

test('a board.json written when the setting was intakeReviewPasses keeps its number of blind passes', () => {
  const writtenBeforeTheRename = mergeBoardConfig({ settings: { intakeReviewPasses: 3 } })

  expect(writtenBeforeTheRename.settings).toEqual({ verify: '', planReviewPasses: 3, worktrees: true, unrouted: 'build' })
})

test('planReviewPasses wins over the older name when a board.json has both', () => {
  const withBothNames = mergeBoardConfig({ settings: { intakeReviewPasses: 3, planReviewPasses: 0 } })

  expect(withBothNames.settings.planReviewPasses).toBe(0)
})

test('an older name with a value that is no number is named and the default stands', () => {
  const settings = { intakeReviewPasses: 'two' }

  expect(mergeBoardConfig({ settings }).settings.planReviewPasses).toBe(1)
  expect(boardConfigProblems(JSON.stringify({ settings }))).toContain('setting "intakeReviewPasses" must be a number, so the default is used.')
})

test('a category resolves to its tier model, effort and role', () => {
  expect(resolveRoute('hard', DEFAULT_BOARD_CONFIG, NO_PROVIDERS)).toEqual({
    category: 'hard',
    tier: 'deep',
    role: 'worker',
    requestedModel: 'opus',
    model: 'opus',
    effort: 'high',
  })
  expect(resolveRoute('explore', DEFAULT_BOARD_CONFIG, NO_PROVIDERS)?.role).toBe('scout')
  expect(resolveRoute('nothing', DEFAULT_BOARD_CONFIG, NO_PROVIDERS)).toBe(undefined)
})

test('outside code routes to the reviewer that has no shell, on the deep tier', () => {
  expect(resolveRoute('outside-code', DEFAULT_BOARD_CONFIG, NO_PROVIDERS)).toEqual({
    category: 'outside-code',
    tier: 'deep',
    role: 'outside-code-reviewer',
    requestedModel: 'opus',
    model: 'opus',
    effort: 'high',
  })
  expect(mergeBoardConfig({ categories: { pasted: { tier: 'deep', role: 'outside-code-reviewer' } } }).categories.pasted?.role).toBe(
    'outside-code-reviewer',
  )
})

test('an unknown tier model falls back with a named reason', () => {
  const config = mergeBoardConfig({
    tiers: {
      deep: { model: 'other-model-1', effort: 'high', fallback: 'opus' },
      standard: { model: 'other-model-2', effort: 'medium' },
    },
  })
  const withFallback = resolveRoute('hard', config, NO_PROVIDERS)
  const withoutFallback = resolveRoute('build', config, NO_PROVIDERS)

  expect(withFallback?.model).toBe('opus')
  expect(withFallback?.requestedModel).toBe('other-model-1')
  expect(withFallback?.reason).toContain('the tier fallback')
  expect(withoutFallback?.model).toBe('sonnet')
  expect(withoutFallback?.reason).toContain('no usable fallback is set')
})

test('a tier with no fallback of its own takes the provider file fallback', () => {
  const config = mergeBoardConfig({
    tiers: {
      deep: { model: 'other-model-1', effort: 'high', fallback: 'opus' },
      standard: { model: 'other-model-2', effort: 'medium' },
    },
  })
  const providers = providersOf([
    { name: 'a', models: [{ id: 'other-model-3' }], fallback: 'not-an-alias' },
    { name: 'b', models: [], fallback: 'haiku' },
    { name: 'c', models: [], fallback: 'fable' },
  ])

  expect(providers).toEqual({ modelIds: ['other-model-3'], fallback: 'haiku' })
  expect(resolveRoute('build', config, providers)?.model).toBe('haiku')
  expect(resolveRoute('build', config, providers)?.reason).toContain('runs on haiku (the provider fallback)')
  expect(resolveRoute('hard', config, providers)?.model).toBe('opus')
})

test('a model a provider file lists is legal', () => {
  const config = mergeBoardConfig({ tiers: { deep: { model: 'other-model-1', effort: 'high' } } })
  const providers = providersOf([{ name: 'p', models: [{ id: 'other-model-1', label: 'One' }, { label: 'no id' }] }])

  expect(providers).toEqual({ modelIds: ['other-model-1'] })
  expect(resolveRoute('hard', config, providers)).toEqual({
    category: 'hard',
    tier: 'deep',
    role: 'worker',
    requestedModel: 'other-model-1',
    model: 'other-model-1',
    effort: 'high',
  })
})

test('a spawn is routed by ticket ref or route tag, the tag winning', () => {
  const hardTicket = ticket('SQ-12', { category: 'hard' })

  expect(routeRequestIn('Ticket SQ-12: fix it', 'sq-12', EARLIER_BOARD_IDS)).toEqual({ ticket: 'SQ-12' })
  expect(routeRequestIn('SQ-12 [route:review] check it', '', EARLIER_BOARD_IDS)).toEqual({ ticket: 'SQ-12', category: 'review' })
  expect(routeRequestIn('[route:quick] rename', '', EARLIER_BOARD_IDS)).toEqual({ category: 'quick' })
  expect(routeRequestIn('look around', 'explore', EARLIER_BOARD_IDS)).toBe(undefined)
  expect(spawnRouteFor({ ticket: 'SQ-12' }, DEFAULT_BOARD_CONFIG, hardTicket, NO_PROVIDERS)?.route.model).toBe('opus')
  expect(spawnRouteFor({ ticket: 'SQ-12', category: 'quick' }, DEFAULT_BOARD_CONFIG, hardTicket, NO_PROVIDERS)?.route.model).toBe(
    'sonnet',
  )
  expect(spawnRouteFor({ ticket: 'SQ-404' }, DEFAULT_BOARD_CONFIG, undefined, NO_PROVIDERS)).toBe(undefined)
})

test('a ticket ref counts only at the start of the prompt', () => {
  expect(routeRequestIn('compare SQ-3 and SQ-4', '', EARLIER_BOARD_IDS)).toBe(undefined)
  expect(routeRequestIn('look around', 'SQ-3 parser', EARLIER_BOARD_IDS)).toBe(undefined)
  expect(routeRequestIn('[route:explore] compare SQ-3 and SQ-4', '', EARLIER_BOARD_IDS)).toEqual({ category: 'explore' })
})

test('a ticket ref routes in the board own prefix only, so a tracker key or another board id leading a prompt is no ref', () => {
  const ids = boardIdsOf('TN')

  expect(routeRequestIn('Ticket TN-12: fix it', '', ids)).toEqual({ ticket: 'TN-12' })
  expect(routeRequestIn('TN-12 [route:review] check it', '', ids)).toEqual({ ticket: 'TN-12', category: 'review' })
  expect(routeRequestIn('Ticket SQ-12: fix it', '', ids)).toBe(undefined)
  expect(routeRequestIn('PAY-41 retry uploads', '', ids)).toBe(undefined)
  expect(routeRequestIn('TN-S3 the story', '', ids)).toBe(undefined)
  expect(routeRequestIn('Ticket TN-12: fix it', '', EARLIER_BOARD_IDS)).toBe(undefined)
})

test('a linked worktree resolves the board of the main checkout', () => {
  const answer = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

  expect(boardLocationFrom('C:/repo/.claude/worktrees/a', answer('C:/repo/.git\n'))).toEqual({
    root: 'C:/repo',
    gitCommonDir: 'C:/repo/.git',
  })
  expect(boardLocationFrom('C:/repo/.claude/worktrees/a', answer('C:/repo/.git\nC:/repo/.git/worktrees/a\n'))).toEqual({
    root: 'C:/repo',
    gitCommonDir: 'C:/repo/.git',
    checkoutGitDir: 'C:/repo/.git/worktrees/a',
  })
  expect(boardLocationFrom('C:/repo', answer('C:/repo/.git\nC:/repo/.git\n'))).toEqual({ root: 'C:/repo', gitCommonDir: 'C:/repo/.git' })
  expect(boardLocationFrom('/plain', answer('', 128))).toEqual({ root: '/plain' })
  expect(boardLocationFrom('/plain', undefined)).toEqual({ root: '/plain' })
})

test('the exclude entry is added once', () => {
  expect(withExcludeEntry('')).toBe('.sidequest/\n')
  expect(withExcludeEntry('# git ls-files\n*.log')).toBe('# git ls-files\n*.log\n.sidequest/\n')
  expect(withExcludeEntry('*.log\n/.sidequest\n')).toBe(undefined)
})
