import { expect, test } from 'claude-code/testing'

import {
  REPEATED_COMMAND_DAYS,
  REPEATED_COMMAND_RUNS,
  REPEATED_DENIALS,
  REPEATED_FAILURES,
  REPEATED_FAILURE_DAYS,
  STILL_HAPPENING_DAYS,
  detectCandidates,
  UNUSED_SKILL_DAYS,
  repeatedCommands,
  repeatedDenials,
  repeatedFailures,
  unusedSkills,
  withPlainToolName,
  withoutRejected,
} from './detectors'
import type { SensedEvent } from './events'
import { currentEvidence } from './evidence-tool'
import type { DirectoryEntry, FileSystem } from './store'

const NOW = Date.parse('2026-11-16T12:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000

const daysAgo = (days: number): string => new Date(NOW - days * DAY_MS).toISOString()

const commandRuns = (count: number, days: number): SensedEvent[] =>
  Array.from({ length: count }, (_, index) => ({ kind: 'typed', at: daysAgo(index % days), prefix: 'npm run' }))

test('a command run by hand often enough over enough days is a script candidate', async () => {
  const [candidate] = repeatedCommands(commandRuns(REPEATED_COMMAND_RUNS, REPEATED_COMMAND_DAYS))

  expect(candidate?.fingerprint).toBe('script:npm run')
  expect(candidate?.sentence).toBe('ran `npm run` by hand 8 times over 2 days')
})

test('a command below the run count or on one day is not a candidate', async () => {
  expect(repeatedCommands(commandRuns(REPEATED_COMMAND_RUNS - 1, REPEATED_COMMAND_DAYS))).toEqual([])
  expect(repeatedCommands(commandRuns(REPEATED_COMMAND_RUNS * 2, 1))).toEqual([])
})

const failuresOver = (count: number, days: number): SensedEvent[] =>
  Array.from({ length: count }, (_, index) => ({ kind: 'failure', at: daysAgo(index % days), tool: 'Edit', signature: 'string not found' }))

test('the same failure coming back on another day is a fix candidate, one below the count is not', async () => {
  expect(repeatedFailures(failuresOver(REPEATED_FAILURES, REPEATED_FAILURE_DAYS)).map(candidate => candidate.sentence)).toEqual([
    'Edit: string not found failed 5 times over 2 days',
  ])
  expect(repeatedFailures(failuresOver(REPEATED_FAILURES - 1, REPEATED_FAILURE_DAYS))).toEqual([])
})

test('one burst of the same failure on a single day is one mistake, not a candidate', async () => {
  expect(repeatedFailures(failuresOver(84, 1))).toEqual([])
})

const failuresThatStopped = (daysSinceLast: number): SensedEvent[] =>
  Array.from({ length: REPEATED_FAILURES }, (_, index) => ({ kind: 'failure', at: daysAgo(daysSinceLast + (index % REPEATED_FAILURE_DAYS)), tool: 'Edit', signature: 'string not found' }))

test('a failure that stopped more than a week ago leaves by itself', async () => {
  const judged = (events: SensedEvent[]) => detectCandidates({ events, reachesBeforeWindow: false }, [], NOW)

  expect(judged(failuresThatStopped(STILL_HAPPENING_DAYS + 1))).toEqual([])
  expect(judged(failuresThatStopped(1)).length).toBe(1)
})

test('a connector tool is named by its server and tool, the way a person knows it', async () => {
  expect(withPlainToolName('mcp__plugin_playwright_playwright__browser_run_code_unsafe: error')).toBe('playwright browser_run_code_unsafe: error')
  expect(withPlainToolName('Bash: git log')).toBe('Bash: git log')
})

const denials = (count: number): SensedEvent[] =>
  Array.from({ length: count }, () => ({ kind: 'denial', at: daysAgo(0), tool: 'Bash', target: 'git push' }))

test('the same denial at its threshold is a permission candidate, one below is not', async () => {
  expect(repeatedDenials(denials(REPEATED_DENIALS)).map(candidate => candidate.fingerprint)).toEqual([
    'permission:bash: git push',
  ])
  expect(repeatedDenials(denials(REPEATED_DENIALS - 1))).toEqual([])
})

const skillUse = (daysAgoUsed: number): SensedEvent[] => [
  { kind: 'skill', at: daysAgo(daysAgoUsed), skill: 'deploy' },
  { kind: 'skill', at: daysAgo(1), skill: 'commit' },
]

test('a skill unused for the whole window is a retire candidate', async () => {
  const history = { events: skillUse(UNUSED_SKILL_DAYS + 1), reachesBeforeWindow: true }

  expect(unusedSkills(history, ['deploy', 'commit'], NOW).map(candidate => candidate.fingerprint)).toEqual(['retire:deploy'])
})

test('a skill used inside the window, or a history too short to judge, is not', async () => {
  expect(unusedSkills({ events: skillUse(UNUSED_SKILL_DAYS - 1), reachesBeforeWindow: true }, ['deploy'], NOW)).toEqual([])
  expect(unusedSkills({ events: skillUse(1), reachesBeforeWindow: false }, ['release'], NOW)).toEqual([])
})

test('a window with no skill use at all judges nothing, since skill sensing may be off', async () => {
  const quiet = { events: commandRuns(3, 3), reachesBeforeWindow: true }

  expect(unusedSkills(quiet, ['deploy', 'commit'], NOW)).toEqual([])
})

const memoryDisk = (seeded: Record<string, string>): FileSystem => {
  const files = new Map(Object.entries(seeded))
  const names = (directory: string): DirectoryEntry[] =>
    [...files.keys()]
      .filter(path => path.startsWith(`${directory}/`))
      .map(path => ({ name: path.slice(directory.length + 1), kind: 'file' }))

  return {
    read: async path => files.get(path) ?? '',
    write: async (path, text) => {
      files.set(path, text)
    },
    exists: async path => files.has(path) || names(path).length > 0,
    list: async path => names(path),
  }
}

const dayFile = (daysBack: number, event: SensedEvent): [string, string] => [
  `/events/${daysAgo(daysBack).slice(0, 10)}.jsonl`,
  `${JSON.stringify(event)}\n`,
]

test('history older than the window, read from the day files, lets the retire detector judge', async () => {
  const files = memoryDisk(
    Object.fromEntries([
      dayFile(45, { kind: 'turn', at: daysAgo(45), durationMs: 1, toolCount: 0 }),
      dayFile(10, { kind: 'skill', at: daysAgo(10), skill: 'commit' }),
    ]),
  )
  const sources = { files, cwd: '/repo', eventsDirectory: '/events', pending: [], installedSkills: ['deploy', 'commit'], now: NOW }

  const { candidates } = await currentEvidence(sources)

  expect(candidates.map(candidate => candidate.fingerprint)).toEqual(['retire:deploy'])
})

test('a rejected fingerprint is filtered out', async () => {
  const candidates = repeatedDenials(denials(REPEATED_DENIALS))

  expect(withoutRejected(candidates, new Set(['permission:bash: git push']))).toEqual([])
})
