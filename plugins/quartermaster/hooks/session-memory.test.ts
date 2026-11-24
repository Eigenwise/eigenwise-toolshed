import { expect, test } from 'claude-code/testing'

import type { SensedEvent } from './events'
import { SessionMemory } from './session-memory'
import { readImpressions } from './store'
import type { FileSystem } from './store'

const NOW = Date.parse('2026-11-16T10:00:00.000Z')
const HOME_EVENTS = '/home/.claude/quartermaster/events/repo'

const turnOn = (day: string): SensedEvent => ({ kind: 'turn', at: `${day}T09:00:00.000Z`, durationMs: 1, toolCount: 1 })

const linesOf = (text: string | undefined): string[] => (text ?? '').split('\n').filter(line => line !== '')

const memoryDisk = (
  refuses: (path: string) => boolean,
  reads: (path: string) => string | undefined = () => undefined,
): { files: FileSystem; disk: Map<string, string> } => {
  const disk = new Map<string, string>()
  const files: FileSystem = {
    read: async path => reads(path) ?? disk.get(path) ?? '',
    write: async (path, text) => {
      if (refuses(path)) throw new Error('disk is full')
      disk.set(path, text)
    },
    exists: async path => disk.has(path),
    list: async () => [],
  }

  return { files, disk }
}

test('only the day file that failed is kept in the project, and nothing is written twice', async () => {
  const { files, disk } = memoryDisk(path => path.startsWith(HOME_EVENTS) && path.includes('2026-11-16'))
  const memory = new SessionMemory(files, '/repo', HOME_EVENTS, [], 'abc')

  const error = await memory.flush([turnOn('2026-11-15'), turnOn('2026-11-16')], NOW)

  expect(error).toBe('disk is full')
  expect(linesOf(disk.get(`${HOME_EVENTS}/2026-11-15.abc.jsonl`))).toHaveLength(1)
  expect(disk.has(`${HOME_EVENTS}/2026-11-16.abc.jsonl`)).toBe(false)
  expect(disk.has('/repo/.claude/quartermaster/events/2026-11-15.abc.jsonl')).toBe(false)
  expect(disk.has('/repo/.claude/quartermaster/events/2026-11-16.abc.jsonl')).toBe(true)
})

test('a write that works reports no problem and adds to its file without reading it', async () => {
  const { files, disk } = memoryDisk(
    () => false,
    path => {
      throw new Error(`a flush must not read ${path}`)
    },
  )
  const memory = new SessionMemory(files, '/repo', HOME_EVENTS, [], 'abc')

  expect(await memory.flush([turnOn('2026-11-16')], NOW)).toBeUndefined()
  expect(await memory.flush([turnOn('2026-11-16')], NOW)).toBeUndefined()

  expect(linesOf(disk.get(`${HOME_EVENTS}/2026-11-16.abc.jsonl`))).toHaveLength(2)
})

test('offers logged in the project before impressions moved still count', async () => {
  const { files, disk } = memoryDisk(() => false)
  const old = { at: '2026-11-10T00:00:00.000Z', fingerprint: 'script:npm run', kind: 'ignored' }
  disk.set('/repo/.claude/quartermaster/impressions.jsonl', `${JSON.stringify(old)}\n`)

  const impressions = await readImpressions(files, '/repo', `${HOME_EVENTS}/impressions.jsonl`)

  expect(impressions.map(impression => impression.kind)).toEqual(['ignored'])
})
