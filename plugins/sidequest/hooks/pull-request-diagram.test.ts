import { expect, test } from 'claude-code/testing'

import { mergeBoardConfig } from './board-config'
import { keptSteps, pathAsMermaid } from './pull-request-diagram'
import type { PathStep } from '../types'

const step = (what: string, line: number, changed = false): PathStep => ({ what, file: 'src/upload.ts', line, note: '', ...(changed ? { changed: true } : {}) })

test('a story path comes back as a mermaid flowchart with the changed steps marked', () => {
  const diagram = pathAsMermaid([step('The upload is sent', 12), step('A failure is retried', 40, true), step('The person sees it', 7)])

  expect(diagram).toBe(
    [
      '```mermaid',
      'flowchart TD',
      '  step1["The upload is sent<br/>src/upload.ts:12"]',
      '  step2["A failure is retried (changed)<br/>src/upload.ts:40"]:::changed',
      '  step3["The person sees it<br/>src/upload.ts:7"]',
      '  step1 --> step2',
      '  step2 --> step3',
      '  classDef changed stroke-width:3px',
      '```',
    ].join('\n'),
  )
})

test('a label with quotes, brackets, a pipe or a fence cannot break the block', () => {
  const diagram = pathAsMermaid([step('Reads "name" from [rows] | then ``` and #1', 3)])
  const label = /step1\["(.*)"\]$/m.exec(diagram)?.[1] ?? ''

  expect(label).toBe('Reads #quot;name#quot; from #91;rows#93; #124; then #96;#96;#96; and #35;1<br/>src/upload.ts:3')
  expect(diagram.split('\n').filter(line => line.startsWith('```'))).toEqual(['```mermaid', '```'])
})

test('a long path keeps at most ten nodes: the first, the changed and the last, and says how many were left out', () => {
  const path = Array.from({ length: 14 }, (_, index) => step(`Step ${index + 1}`, index + 1, index === 5 || index === 9))

  expect(keptSteps(path).map(kept => kept.index + 1)).toEqual([1, 6, 10, 14])
  expect(pathAsMermaid(path)).toContain('  step1 -.->|4 steps left out| step6')

  const everyStepChanged = Array.from({ length: 14 }, (_, index) => step(`Step ${index + 1}`, index + 1, true))
  expect(keptSteps(everyStepChanged).length).toBe(10)
})

test('the pull request diagram setting is read from board.json, and absent means not asked yet', () => {
  expect(mergeBoardConfig({}).settings.pullRequestDiagram).toBeUndefined()
  expect(mergeBoardConfig({ settings: { pullRequestDiagram: true } }).settings.pullRequestDiagram).toBe(true)
  expect(mergeBoardConfig({ settings: { pullRequestDiagram: false } }).settings.pullRequestDiagram).toBe(false)
  expect(mergeBoardConfig({ settings: { pullRequestDiagram: 'yes' } }).settings.pullRequestDiagram).toBeUndefined()
})
