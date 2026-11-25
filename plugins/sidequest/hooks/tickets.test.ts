import { expect, test } from 'claude-code/testing'

import { boardIdsOf, EARLIER_BOARD_IDS, idsOnBoard, idsOnEmptyBoard } from './board-ids'
import {
  appendLogLine,
  applyStoryPatch,
  applyTicketPatch,
  DECISION_WORDS_LIMIT,
  decisionsRead,
  idNumber,
  newStory,
  newTicket,
  parseStory,
  parseTicket,
  serializeStory,
  serializeTicket,
  validateTicket,
} from './tickets'
import type { Decision } from './tickets'
import { decisionsAsDrawn } from './views/first-screen'

const TICKET_FILE = `---
id: SQ-12
title: Retry failed uploads
status: ready
kind: build
mode: afk
category: build
story: ST-3
blockedBy: [SQ-11]
decisions: [D-2, D-5]
created: 2026-11-16
updated: 2026-11-16
owner: someone
---

## What
The behaviour this ticket makes work.

## Done when
- [ ] A check that fails today and passes when this is done.

## Log
- 2026-11-16T10:02Z started worker sonnet/medium

## Notes
Kept as written.
`

test('a ticket file parses and writes back unchanged', () => {
  const ticket = parseTicket(TICKET_FILE)

  expect(ticket.blockedBy).toEqual(['SQ-11'])
  expect(ticket.log).toEqual(['2026-11-16T10:02Z started worker sonnet/medium'])
  expect(ticket.otherFields).toEqual({ owner: 'someone' })
  expect(serializeTicket(ticket)).toBe(TICKET_FILE)
})

const ON_AN_EARLIER_BOARD = idsOnEmptyBoard(EARLIER_BOARD_IDS)

test('a valid ticket has no problems', () => {
  expect(validateTicket(parseTicket(TICKET_FILE), ON_AN_EARLIER_BOARD)).toEqual([])
})

test('ids are checked in the board own prefix, and an id already on the board still counts after the prefix changed', () => {
  const onTheBoard = idsOnBoard(boardIdsOf('TN'), new Set(['SQ-11', 'SQ-12']), new Set(['ST-3']))
  const onAnEmptyBoard = idsOnEmptyBoard(boardIdsOf('TN'))

  expect(validateTicket(parseTicket(TICKET_FILE), onTheBoard)).toEqual([])
  expect(validateTicket(parseTicket(TICKET_FILE), onAnEmptyBoard)).toEqual([
    'SQ-12: id "SQ-12" is not like TN-12',
    'SQ-12: story "ST-3" is not like TN-S3',
    'SQ-12: blockedBy [SQ-11] holds something that is not a ticket id',
  ])
  expect(validateTicket({ ...newTicket('TN-2', { title: 'Two', story: 'TN-S1', blockedBy: ['TN-1'] }, '2026-11-16T10:02Z') }, onAnEmptyBoard)).toEqual([])
  expect(idNumber('TN-S14')).toBe(14)
  expect(idNumber('SQ-7')).toBe(7)
})

test('each broken field is named, and a category with no route is not one of them', () => {
  const broken = {
    ...newTicket('SQ-1', {}, '2026-11-16T10:02Z'),
    status: 'started',
    kind: 'chore',
    mode: 'later',
    category: 'misc',
    story: 'story three',
    blockedBy: ['eleven'],
  }
  const problems = validateTicket(broken, ON_AN_EARLIER_BOARD)

  expect(problems.length).toBe(6)
  expect(problems[0]).toBe('SQ-1: title is empty')
  expect(problems.some(problem => problem.includes('category'))).toBe(false)
})

test('a patch changes only the keys it holds and logs append', () => {
  const ticket = parseTicket(TICKET_FILE)
  const patched = applyTicketPatch(ticket, { title: 'Retry uploads' }, '2026-11-17T09:00Z')
  const logged = appendLogLine(patched, '2026-11-17T09:01Z', 'note checked by hand')

  expect(logged.title).toBe('Retry uploads')
  expect(logged.what).toBe(ticket.what)
  expect(logged.updated).toBe('2026-11-17')
  expect(logged.log[1]).toBe('2026-11-17T09:01Z note checked by hand')
})

test('a story keeps numbered decisions', () => {
  const stamp = '2026-11-16T10:02Z'
  const first = applyStoryPatch(
    newStory('ST-1', 'Uploads', stamp),
    { destination: 'Uploads survive a flaky network.', decisions: [{ question: 'Retries?', answer: 'Three', decidedBy: 'human' }] },
    stamp,
  )
  const second = applyStoryPatch(first, { decisions: [{ question: 'Backoff?', answer: 'Doubling', decidedBy: 'default' }] }, stamp)
  const reread = parseStory(serializeStory(second))

  expect(reread.decisions).toBe(
    '- D-1: Retries? Answer: Three Decided by: human on 2026-11-16\n- D-2: Backoff? Answer: Doubling Decided by: default on 2026-11-16',
  )
  expect(reread.destination).toBe('Uploads survive a flaky network.')
})

test('a decision the person took keeps their words up to 200 characters, and a default keeps none', () => {
  const stamp = '2026-11-25T16:15Z'
  const story = applyStoryPatch(
    newStory('ST-1', 'Uploads', stamp),
    {
      decisions: [
        { question: 'Retries?', answer: 'Three', decidedBy: 'human', words: 'Three, more feels slow.' },
        { question: 'Backoff?', answer: 'Doubling', decidedBy: 'human', words: 'x'.repeat(250) },
        { question: 'Jitter?', answer: 'No', decidedBy: 'default', words: 'ignored' },
      ],
    },
    stamp,
  )
  const [retries, backoff, jitter] = decisionsRead(parseStory(serializeStory(story)).decisions)

  expect(retries).toEqual({ question: 'Retries?', answer: 'Three', decidedBy: 'human', decidedOn: '2026-11-25', words: 'Three, more feels slow.' })
  expect(backoff?.words).toBe('x'.repeat(DECISION_WORDS_LIMIT))
  expect(jitter).toEqual({ question: 'Jitter?', answer: 'No', decidedBy: 'default', decidedOn: '2026-11-25' })
})

test('a story file written before decisions kept a day still parses, and its decisions read with no day', () => {
  const older = [
    '---',
    'id: ST-1',
    'title: Uploads',
    'created: 2026-11-10',
    'updated: 2026-11-10',
    '---',
    '',
    '## Decisions',
    '- D-1: Retries? Answer: Three Decided by: human',
    '- D-2: Backoff? Answer: Doubling Decided by: default',
    '',
  ].join('\n')

  expect(decisionsRead(parseStory(older).decisions)).toEqual([
    { question: 'Retries?', answer: 'Three', decidedBy: 'human' },
    { question: 'Backoff?', answer: 'Doubling', decidedBy: 'default' },
  ])
})

const decisionsOf = (decisions: Decision[], stamp = '2026-11-25T16:15Z'): Decision[] =>
  decisionsRead(parseStory(serializeStory(applyStoryPatch(newStory('ST-1', 'Uploads', stamp), { decisions }, stamp))).decisions)

test('decisions of one day keep their order, day and who decided, and a question decided again keeps each line', () => {
  const read = decisionsOf([
    { question: 'Retries?', answer: 'Three', decidedBy: 'human', words: 'Three is plenty' },
    { question: 'Backoff?', answer: 'Doubling', decidedBy: 'default' },
    { question: 'Retries?', answer: 'Five', decidedBy: 'human', words: 'Five after all' },
  ])

  expect(read.map(decision => [decision.question, decision.answer, decision.decidedBy, decision.decidedOn, decision.words])).toEqual([
    ['Retries?', 'Three', 'human', '2026-11-25', 'Three is plenty'],
    ['Backoff?', 'Doubling', 'default', '2026-11-25', undefined],
    ['Retries?', 'Five', 'human', '2026-11-25', 'Five after all'],
  ])
})

test('words are cut by whole characters, so an emoji at the cut is kept whole or left out', () => {
  const [decision] = decisionsOf([{ question: 'Mood?', answer: 'Good', decidedBy: 'human', words: `${'a'.repeat(199)}\u{1F600}\u{1F600}` }])

  expect(decision?.words).toBe(`${'a'.repeat(199)}\u{1F600}`)
  expect(decision?.words).not.toContain('\uFFFD')
})

test('a flag, a joined emoji or an accented letter at the cut is kept whole or left out, never halved', () => {
  const flag = '\u{1F1E7}\u{1F1EA}'
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'
  const accented = 'e\u0301'
  const wordsOf = (typed: string) => decisionsOf([{ question: 'Mood?', answer: 'Good', decidedBy: 'human', words: typed }])[0]?.words

  expect(wordsOf(`${'a'.repeat(199)}${flag}${flag}`)).toBe(`${'a'.repeat(199)}${flag}`)
  expect(wordsOf(`${'a'.repeat(200)}${flag}`)).toBe('a'.repeat(200))
  expect(wordsOf(`${'a'.repeat(199)}${family}`)).toBe(`${'a'.repeat(199)}${family}`)
  expect(wordsOf(`${'a'.repeat(199)}${accented}z`)).toBe(`${'a'.repeat(199)}${accented}`)
  expect(wordsOf(family.repeat(250))).toBe(family.repeat(200))
})

test('words with a lone carriage return or the text of a status line stay words and read back as typed', () => {
  const lookalike = 'fine. Decided by: default. Their words: "no"'
  const read = decisionsOf([
    { question: 'Carriage?', answer: 'Yes', decidedBy: 'human', words: 'one\rtwo' },
    { question: 'Lookalike?', answer: 'Yes', decidedBy: 'human', words: lookalike },
  ])

  expect(read.map(decision => [decision.answer, decision.decidedBy, decision.words])).toEqual([
    ['Yes', 'human', 'one two'],
    ['Yes', 'human', lookalike],
  ])
})

test('a decision that retired another has no answer and still reads', () => {
  const text = '- D-4: Superseded by D-8: an early scope of only the first-prompt line. Decided by: human\n- D-5: Why? Answer: Because. Decided by: default'

  expect(decisionsRead(text)).toEqual([
    { question: 'Superseded by D-8: an early scope of only the first-prompt line.', answer: '', decidedBy: 'human' },
    { question: 'Why?', answer: 'Because.', decidedBy: 'default' },
  ])
})

test('the board speaks the status of a decision and leaves a person\'s quoted words as they said them', () => {
  const text = '- D-1: Retries? Answer: Three Decided by: human on 2026-11-25. Their words: "Decided by: human, and Decided by: default"'

  expect(decisionsAsDrawn(text)).toBe('- D-1: Retries? Answer: Three Decided by: you on 2026-11-25. Their words: "Decided by: human, and Decided by: default"')
})

const HAND_EDITED_LINES = ['id: SQ-3', 'title: Retry failed uploads', 'status: ready', 'kind: build', 'mode: afk', 'category: build']
const HAND_EDITED_END = ['created: 2026-11-10', 'updated: 2026-11-10', 'owner: dana']
const HAND_EDITED_BODY =
  '\n## What\nIt works.\n\n## Done when\n- [ ] A check passes.\n\n## Log\n- 2026-11-10T09:00Z started worker sonnet/medium\n\n## Notes\nWritten by hand.\n'

const handEditedFile = (middleLines: string[], options: { start?: string; close?: string } = {}): string =>
  `${options.start ?? ''}---\n${[...HAND_EDITED_LINES, ...middleLines, ...HAND_EDITED_END].join('\n')}\n${options.close ?? '---\n'}${HAND_EDITED_BODY}`

const expectNothingLostOnWrite = (text: string, expected: { status: string; blockedBy: string[] }): void => {
  const ticket = parseTicket(text)
  const rewritten = parseTicket(serializeTicket(ticket))

  for (const reread of [ticket, rewritten]) {
    expect(reread.title).toBe('Retry failed uploads')
    expect(reread.status).toBe(expected.status)
    expect(reread.kind).toBe('build')
    expect(reread.blockedBy).toEqual(expected.blockedBy)
    expect(reread.otherFields).toEqual({ owner: 'dana' })
    expect(reread.otherSections).toEqual([{ heading: 'Notes', text: 'Written by hand.' }])
  }
}

test('a byte-order mark is skipped on read and kept on write', () => {
  const text = handEditedFile(['blockedBy: []'], { start: '﻿' })

  expectNothingLostOnWrite(text, { status: 'ready', blockedBy: [] })
  expect(serializeTicket(parseTicket(text)).startsWith('﻿---\n')).toBe(true)
})

test('frontmatter with no closing fence is named as damaged and refused on write', () => {
  const ticket = parseTicket(handEditedFile(['blockedBy: []'], { close: '' }))
  let refusal = ''
  try {
    serializeTicket(ticket)
  } catch (error) {
    refusal = error instanceof Error ? error.message : ''
  }

  expect(ticket.isDamaged).toBe(true)
  expect(refusal).toContain('no closing ---')
  expect(parseTicket('# Just notes').isDamaged).toBe(undefined)
  expect(parseTicket('').isDamaged).toBe(undefined)
})

test('a list written one value per indented line reads as that list, with spaces or tabs', () => {
  const indented = (indent: string) => handEditedFile(['blockedBy:', `${indent}- SQ-2`, `${indent}- "SQ-4"`])

  expectNothingLostOnWrite(indented('  '), { status: 'ready', blockedBy: ['SQ-2', 'SQ-4'] })
  expectNothingLostOnWrite(indented('\t'), { status: 'ready', blockedBy: ['SQ-2', 'SQ-4'] })
})

test('decisions, uses and an unknown field read as lists when written one value per line', () => {
  const ticket = parseTicket(handEditedFile(['decisions:', '  - D-1', '  - D-2', 'uses:', '\t- stack', 'tags:', '  - one']))
  const rewritten = parseTicket(serializeTicket(ticket))

  expect(ticket.decisions).toEqual(['D-1', 'D-2'])
  expect(ticket.uses).toEqual(['stack'])
  expect(rewritten.decisions).toEqual(['D-1', 'D-2'])
  expect(rewritten.uses).toEqual(['stack'])
  expect(rewritten.otherFields).toEqual({ owner: 'dana', tags: ['one'] })
})

test('a duplicated key keeps its last value and is reported once', () => {
  const text = handEditedFile(['blockedBy: []', 'status: done', 'status: parked'])

  expectNothingLostOnWrite(text, { status: 'parked', blockedBy: [] })
  expect(parseTicket(text).duplicatedKeys).toEqual(['status'])
  expect(parseTicket(handEditedFile(['blockedBy: []'])).duplicatedKeys).toBe(undefined)
})

test('a title with a colon, Windows line endings and a status outside the list are read and kept', () => {
  const colon = handEditedFile(['blockedBy: []']).replace('title: Retry failed uploads', 'title: Retry failed uploads: all paths')
  const colonTicket = parseTicket(colon)
  const windows = handEditedFile(['blockedBy: []']).replace(/\n/g, '\r\n')
  const unlisted = handEditedFile(['blockedBy: []']).replace('status: ready', 'status: finished')

  expect(colonTicket.title).toBe('Retry failed uploads: all paths')
  expect(parseTicket(serializeTicket(colonTicket)).title).toBe('Retry failed uploads: all paths')
  expectNothingLostOnWrite(windows, { status: 'ready', blockedBy: [] })
  expectNothingLostOnWrite(unlisted, { status: 'finished', blockedBy: [] })
})
