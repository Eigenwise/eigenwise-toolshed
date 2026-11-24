import { expect, test } from 'claude-code/testing'

import { applyStoryPatch, newStory, parseStory, serializeStory } from './tickets'
import type { Story } from './tickets'
import { longShortVersionNote } from './plan-in-the-chat'

const STAMP = '2026-11-24T10:02Z'
const storyWith = (analysis: string): Story => applyStoryPatch(newStory('ST-1', 'Tags on items', STAMP), { destination: 'Items carry tags.', analysis }, STAMP)
const readBack = (story: Story): Story => parseStory(serializeStory(story), 'ST-1')

test('an analysis line that would open another section of the story stays inside the analysis', () => {
  const written = readBack(storyWith('What is asked.\n\n## Decisions\n- a line that is not a decision\n\n## Options\nstill here'))

  expect(written.analysis).toContain('### Decisions\n- a line that is not a decision')
  expect(written.analysis).toContain('### Options\nstill here')
  expect(written.decisions).toBe('')
  expect(written.otherSections).toEqual([])
})

test('an analysis that brings its own heading keeps its text through a write and a later patch', () => {
  const written = readBack(storyWith('## Analysis\nWhat is asked.'))
  const patchedLater = readBack(applyStoryPatch(written, { outOfScope: 'Renaming tags.' }, STAMP))

  expect(written.analysis).toBe('What is asked.')
  expect(patchedLater.analysis).toBe('What is asked.')
})

test('a story with no analysis writes no Analysis section', () => {
  expect(serializeStory(storyWith(''))).not.toContain('## Analysis')
})

test('the short version is kept in its own section after the destination and reads back as it was written', () => {
  const inShort = 'Asked: tags.\n\nA. a tag field (recommended)\nB. a tag table'
  const text = serializeStory(applyStoryPatch(storyWith('What is asked.'), { inShort }, STAMP))

  expect(text).toContain(`## Destination\nItems carry tags.\n\n## In short\n${inShort}\n\n## Analysis`)
  expect(parseStory(text, 'ST-1').inShort).toBe(inShort)
  expect(parseStory(text, 'ST-1').otherSections).toEqual([])
})

test('a short version past about 200 words is noted, and one within it is not', () => {
  const story = storyWith('')

  expect(longShortVersionNote({ ...story, inShort: 'word '.repeat(201) })[0]).toContain('is 201 words, past about 200 (written anyway)')
  expect(longShortVersionNote({ ...story, inShort: 'word '.repeat(200) })).toEqual([])
})
