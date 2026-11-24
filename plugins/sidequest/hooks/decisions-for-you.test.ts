import { expect, test } from 'claude-code/testing'

import { chatBlockOf, decisionsForYouLines, missingOtherCostsLine } from './decisions-for-you'
import { applyStoryPatch, newStory, parseStory, serializeStory } from './tickets'
import type { Story } from './tickets'

const STAMP = '2026-11-24T10:02Z'
const QUESTIONS = [
  { question: 'How many retries?', recommended: 'retries: 2', otherCosts: 'Three makes a failure show a minute later.' },
  { question: 'Where does the retry live?', recommended: 'uploadWithRetry(file)', otherCosts: '' },
  { question: 'Which test proves it?', recommended: 'a failed upload is retried twice', otherCosts: 'A unit test alone never sees the real queue.' },
]
const storyWith = (story: Story, questions: typeof QUESTIONS): Story => applyStoryPatch(story, { analysis: 'What is asked.', questions }, STAMP)
const readBack = (story: Story): Story => parseStory(serializeStory(story), 'ST-1')

test('a story with open questions writes them numbered under Decisions for you, after the analysis, and reads them back', () => {
  const written = serializeStory(storyWith(newStory('ST-1', 'Uploads', STAMP), QUESTIONS))

  expect(written).toContain(
    [
      '## Analysis',
      'What is asked.',
      '',
      '## Decisions for you',
      '1. How many retries?',
      '   Recommended: retries: 2',
      '   The other answer costs: Three makes a failure show a minute later.',
      '2. Where does the retry live?',
      '   Recommended: uploadWithRetry(file)',
      '3. Which test proves it?',
    ].join('\n'),
  )
  expect(parseStory(written, 'ST-1').questions).toEqual(QUESTIONS)
  expect(parseStory(written, 'ST-1').otherSections).toEqual([])
})

test('an empty list of questions removes the section', () => {
  const asked = readBack(storyWith(newStory('ST-1', 'Uploads', STAMP), QUESTIONS))

  expect(serializeStory(applyStoryPatch(asked, { questions: [] }, STAMP))).not.toContain('Decisions for you')
  expect(serializeStory(applyStoryPatch(asked, { outOfScope: 'Downloads.' }, STAMP))).toContain('## Decisions for you')
})

test('the chat block counts the decisions, gives each the question, the recommended answer as written and the other answer, one line each, and says how to answer', () => {
  expect(chatBlockOf(QUESTIONS)).toBe(
    [
      'Three decisions for you',
      '',
      '1. How many retries?',
      '   - Recommended: retries: 2',
      '   - Otherwise: Three makes a failure show a minute later.',
      '2. Where does the retry live?',
      '   - Recommended: uploadWithRetry(file)',
      '3. Which test proves it?',
      '   - Recommended: a failed upload is retried twice',
      '   - Otherwise: A unit test alone never sees the real queue.',
      '',
      'Answer by number, or yes takes all three recommended answers. The reasoning for each is in the plan on the board (/board opens it).',
    ].join('\n'),
  )
  expect(chatBlockOf(QUESTIONS.slice(0, 1))).toMatch(/^One decision for you\n[\s\S]*yes takes the recommended answer\./)
})

const LIST_ANSWER = {
  question: 'What does the new option look like?',
  recommended: '`archived: "exclude" | "include" | "only"`\ndefault "exclude" (today\'s behaviour)',
  otherCosts: 'includeArchived: boolean can never ask for archived notes alone.',
}

test('a recommended answer with several parts is one part per line, in the chat, the plan view and the story file, and only the parts the session put in backticks are code', () => {
  expect(chatBlockOf([LIST_ANSWER]).split('\n').slice(2, 7)).toEqual([
    '1. What does the new option look like?',
    '   - Recommended:',
    '     - `archived: "exclude" | "include" | "only"`',
    '     - default "exclude" (today\'s behaviour)',
    '   - Otherwise: includeArchived: boolean can never ask for archived notes alone.',
  ])
  expect(decisionsForYouLines([LIST_ANSWER])).toEqual([
    {
      question: '1. What does the new option look like?',
      recommended: ['Recommended:', '- `archived: "exclude" | "include" | "only"`', '- default "exclude" (today\'s behaviour)'],
      otherwise: 'Otherwise: includeArchived: boolean can never ask for archived notes alone.',
    },
  ])
  expect(readBack(storyWith(newStory('ST-1', 'Uploads', STAMP), [LIST_ANSWER])).questions).toEqual([LIST_ANSWER])
})

test('a question with no other answer is named for the session, and an answer that brings its own backticks is not wrapped again', () => {
  expect(missingOtherCostsLine(QUESTIONS)).toBe(
    'Question 2 has no otherCosts (written anyway): patch questions with what the other answer is and what it costs, so the person sees what turning it down means.',
  )
  expect(missingOtherCostsLine(QUESTIONS.filter(question => question.otherCosts !== ''))).toBe('')
  expect(decisionsForYouLines([{ question: 'Where?', recommended: 'in `src/upload.ts`', otherCosts: '' }])[0]?.recommended).toEqual(['Recommended: in `src/upload.ts`'])
})

test('a recommended answer of one prose line comes out plain, with no backticks the session did not write', () => {
  const prose = { question: 'Where does refunds go?', recommended: 'Leave it out of the first release.', otherCosts: '' }

  expect(decisionsForYouLines([prose])[0]?.recommended).toEqual(['Recommended: Leave it out of the first release.'])
  expect(chatBlockOf([prose])).toContain('   - Recommended: Leave it out of the first release.')
})

test('a recommended answer of one part the session put in backticks keeps them, once', () => {
  const code = { question: 'How many retries?', recommended: '`retries: 2`', otherCosts: '' }

  expect(decisionsForYouLines([code])[0]?.recommended).toEqual(['Recommended: `retries: 2`'])
  expect(chatBlockOf([code]).split('\n')).toContain('   - Recommended: `retries: 2`')
})
