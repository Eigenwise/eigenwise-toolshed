import { expect, test } from 'claude-code/testing'

import { projectNameOf } from './project-name'
import { newTicket } from './tickets'
import type { Ticket } from './tickets'
import { nowWaitingNote, waitingAroundWrite, waitingText } from './waiting-view'

const STAMP = '2026-11-25T10:00Z'

const askingTicket = (id: string, question: string): Ticket => ({
  ...newTicket(id, { title: question, status: 'needs-you' }, STAMP),
  forYou: `Question: ${question}\nOptions:\n- Yes: it ships Costs: nothing\n- No: it waits Costs: a day\nRecommended: A`,
})

const SHIP_QUESTION = askingTicket('SQ-1', 'Ship the retry change?')
const TWO_QUESTIONS = [SHIP_QUESTION, askingTicket('SQ-2', 'Rename the flag?')]

test('the waiting view names the project once at the top and every item ends with where to answer it', () => {
  const text = waitingText(TWO_QUESTIONS, undefined, undefined, undefined, { stories: [], projectName: 'toolshed' })

  expect(text.startsWith('Waiting on you in toolshed, most blocking first:\n\n1. ')).toBe(true)
  expect(text.split('toolshed')).toHaveLength(2)
  const items = text.split('\n\n').filter(part => /^\d+\. /.test(part))
  expect(items).toHaveLength(2)
  for (const item of items) expect(item.split('\n').at(-1)).toMatch(/^ {3}To answer in this chat: \d and a letter, like \dA\. Ticket SQ-\d\.$/)
})

test('the waiting view without a known project still says where to answer', () => {
  const text = waitingText([SHIP_QUESTION])

  expect(text.startsWith('Waiting on you, most blocking first:')).toBe(true)
  expect(text.split('\n').at(-1)).toBe('   To answer in this chat: a letter, like A. Ticket SQ-1.')
})

test('the block a write prints for a ticket that now waits names the project and where to answer', () => {
  const ticket = SHIP_QUESTION
  const around = waitingAroundWrite({ stories: [], projectName: 'toolshed' }, new Set(), [ticket.id], STAMP)

  const note = nowWaitingNote([ticket], [ticket], around)

  expect(note).toContain('Show the person this as it is:\nWaiting on you in toolshed:\n\nShip the retry change?')
  expect(note.split('\n').at(-1)).toBe('   To answer in this chat: a letter, like A. Ticket SQ-1.')
})

test('a project is named after the last folder of its root, without a bare repository suffix', () => {
  expect(projectNameOf('C:/work/photo-library/')).toBe('photo-library')
  expect(projectNameOf('C:\\work\\toolshed')).toBe('toolshed')
  expect(projectNameOf('/srv/git/toolshed.git')).toBe('toolshed')
  expect(projectNameOf('/')).toBeUndefined()
})

test('an item from an earlier session ends with where to answer and the project is named once', () => {
  const now = Date.parse('2026-11-25T10:00:00Z')
  const old = askingTicket('SQ-3', 'Pick the limit?')
  const older = { ...old, updated: '2026-11-20T09:00Z', log: [] }
  const text = waitingText([SHIP_QUESTION, older], undefined, now, new Set(['SQ-1']), { stories: [], projectName: 'toolshed' })

  expect(text.split('toolshed')).toHaveLength(2)
  expect(text.split('\n').at(-1)).toMatch(/^- SQ-3 .*To answer in this chat: ask for ticket SQ-3, then answer it\.$/)
})

test('nothing waiting still names the project', () => {
  expect(waitingText([], undefined, undefined, undefined, { stories: [], projectName: 'toolshed' })).toBe('Nothing waits on you in toolshed.')
})
