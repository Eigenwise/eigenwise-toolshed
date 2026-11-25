import { expect, test } from 'claude-code/testing'

import { boardConfigProblems } from './board-config'
import { applyStoryPatch, newStory, newTicket, parseStory, serializeStory } from './tickets'
import type { Story, Ticket } from './tickets'
import { waitingText } from './waiting-view'

const STAMP = '2026-11-23T10:02Z'
const storyWith = (handOver: string): Story => applyStoryPatch(newStory('ST-1', 'Tags on items', STAMP), { handOver }, STAMP)
const readBack = (story: Story): Story => parseStory(serializeStory(story), 'ST-1')

test('a hand-over that brings its own heading keeps its text through a write and a later patch', () => {
  const written = readBack(storyWith('## Hand-over\n### Goal\nkeep me\n### Risks\nnone'))
  const patchedLater = readBack(applyStoryPatch(written, { outOfScope: 'Renaming tags.' }, STAMP))

  expect(written.handOver).toBe('### Goal\nkeep me\n### Risks\nnone')
  expect(patchedLater.handOver).toBe(written.handOver)
})

test('a hand-over line that would open another section of the story stays inside the hand-over', () => {
  const written = readBack(storyWith('### Goal\nkeep\n\n## Decisions\n- a line that is not a decision\n### Risks\nstill here'))

  expect(written.handOver).toContain('### Decisions\n- a line that is not a decision')
  expect(written.handOver).toContain('still here')
  expect(written.decisions).toBe('')
})

const boardWith = (beforeBuilding: unknown): string => JSON.stringify({ version: 1, settings: { beforeBuilding } })

test('a read-back of the wrong type is named, so nobody builds thinking the result was read back', () => {
  const problems = boardConfigProblems(boardWith({ label: 'design note', how: 'the design-note skill', readBack: 5 }))

  expect(problems).toEqual(['setting "beforeBuilding.readBack" must be text, so the result of the step is not read back.'])
  expect(boardConfigProblems(boardWith({ label: 'design note', how: 'the design-note skill', readBack: 'Read the note again.' }))).toEqual([])
})

const NOW = Date.parse('2026-11-23T10:00:00Z')
const waitingTicket = (id: string, title: string, stamp: string): Ticket => ({
  ...newTicket(id, { title, status: 'needs-you', mode: 'hitl', forYou: `Question: What about ${title}?` }, stamp),
  log: [],
})

test('the waiting view calls a question earlier work by the same rule as the band: untouched here and a day old', () => {
  const threeDaysOld = waitingTicket('SQ-3', 'Two things from outside', '2026-11-20T09:00Z')
  const fromThisSession = waitingTicket('SQ-40', 'Pick the limit', '2026-11-23T09:00Z')
  const text = waitingText([threeDaysOld, fromThisSession], undefined, NOW, new Set(['SQ-40']))

  expect(text).toContain('\n\nWhat about Pick the limit?\n   To answer in this chat: done, or what you found.')
  expect(text).toContain('Still waiting on you from earlier sessions:\n- SQ-3 Two things from outside, waiting 3 days. To answer in this chat: ask for ticket SQ-3, then answer it.')
})
