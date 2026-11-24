import { expect, test } from 'claude-code/testing'

import { fencedDiffOf } from './code-path'
import { applyStoryPatch, newStory, parseStory, serializeStory } from './tickets'

const STAMP = '2026-11-24T10:02Z'
const PATH = [
  { what: 'The upload is sent', file: 'src/upload.ts', line: 12, note: '' },
  { what: 'A failure is reported', file: 'src/report.ts', line: 40, note: 'retry goes here' },
]
const EXCERPTS = [{ file: 'src/upload.ts', firstLine: 12, lines: 'export const upload = (file: File) =>\n  send(file)' }]

test('a story with a path and excerpts keeps them readable in its file and reads them back', () => {
  const written = serializeStory(applyStoryPatch(newStory('ST-1', 'Uploads', STAMP), { path: PATH, excerpts: EXCERPTS }, STAMP))

  expect(written).toContain('## Path\n1. The upload is sent (src/upload.ts:12)\n2. A failure is reported (src/report.ts:40) retry goes here')
  expect(written).toContain('## Excerpts\nsrc/upload.ts:12\n```\nexport const upload = (file: File) =>\n  send(file)\n```')
  const readBack = parseStory(written, 'ST-1')
  expect(readBack.path).toEqual(PATH)
  expect(readBack.excerpts).toEqual(EXCERPTS)
  expect(readBack.otherSections).toEqual([])
  expect(serializeStory(applyStoryPatch(readBack, { path: [], excerpts: [] }, STAMP))).not.toMatch(/## (Path|Excerpts)/)
})

test('a fenced diff is taken out of the words around it', () => {
  const { diff, withoutDiff } = fencedDiffOf('### Question\nShip this?\n\n```diff\n@@ -1 +1 @@\n-a\n+b\n```\n\n### Recommended\nYes')

  expect(diff).toBe('@@ -1 +1 @@\n-a\n+b')
  expect(withoutDiff).toBe('### Question\nShip this?\n\n### Recommended\nYes')
})
