import { expect, test } from 'claude-code/testing'

import { DEFAULT_BOARD_CONFIG } from './board-config'
import { answerBoardView } from './board-tool'
import { answeredByHuman } from './human-answers'
import type { BoardFiles } from './store'
import { newTicket, parseTicket, serializeTicket } from './tickets'
import type { Ticket } from './tickets'

const ASKED = '2026-11-25T09:00Z'
const ANSWERED = '2026-11-25T16:20Z'
const LATER = '2026-11-25T16:25Z'

const waiting: Ticket = newTicket('SQ-3', { title: 'Pick a backoff', status: 'needs-you', mode: 'hitl', forYou: 'Question: How long?' }, ASKED)

const answeredOnce = (): Ticket => {
  const written = answeredByHuman(waiting, 'B. Ten seconds', ANSWERED)
  if (written === undefined) throw new Error('the first press wrote nothing')

  return written.ticket
}

test('an answer pressed on a waiting question keeps its words and the minute, through the file', () => {
  const reread = parseTicket(serializeTicket(answeredOnce()))

  expect(reread.answerSent).toBe('B. Ten seconds')
  expect(reread.answerSentAt).toBe(ANSWERED)
})

test('a second press on an answered question writes nothing and tells the session nothing', () => {
  const first = answeredOnce()

  expect(answeredByHuman(first, 'B. Ten seconds', LATER)).toBeUndefined()
  expect(first.log.filter(line => line.includes('answered by human'))).toHaveLength(1)
})

const filesOf = (tickets: Ticket[]): BoardFiles => ({
  config: DEFAULT_BOARD_CONFIG,
  configText: undefined,
  tickets,
  stories: [],
  checkedOutBranch: 'main',
  folderRead: undefined,
})

const summaryOf = (tickets: Ticket[]): string => {
  const answer = answerBoardView({ view: 'summary' }, filesOf(tickets), LATER, undefined, undefined, new Map())

  return 'text' in answer ? answer.text : ''
}

test('the board summary names an answered question nobody has acted on, and no longer counts it as waiting', () => {
  const summary = summaryOf([answeredOnce()])

  expect(summary).toContain('Answered on the board, nobody has acted on it yet, so act on it or ask again: SQ-3 (Pick a backoff).')
  expect(summary).toContain('0 waiting on you')
})

test('the board summary says nothing of answers when none is waiting for a session', () => {
  expect(summaryOf([waiting])).not.toContain('Answered on the board')
})

const OLDER_COPY_FILE = `---
id: SQ-3
title: "Pick a backoff"
status: needs-you
kind: review
mode: hitl
created: 2026-11-16
updated: 2026-11-25
---

## For you
Question: How long?

## Log
- 2026-11-16T00:00Z filed
- 2026-11-25T16:05Z moved by human to needs-you
- 2026-11-25T16:06Z answered by human in the board: A. Reads well now
- 2026-11-25T16:06Z answered by human in the board: A. Reads well now
`

test('a file an older copy wrote, with the answer last on its log, reads as answered and takes no third press', () => {
  const ticket = parseTicket(OLDER_COPY_FILE)

  expect(ticket.answerSent).toBe('A. Reads well now')
  expect(ticket.answerSentAt).toBe('2026-11-25T16:06Z')
  expect(answeredByHuman(ticket, 'A. Reads well now', LATER)).toBeUndefined()
  expect(summaryOf([ticket])).toContain('Answered on the board, nobody has acted on it yet, so act on it or ask again: SQ-3 (Pick a backoff).')
  expect(summaryOf([ticket])).toContain('0 waiting on you')
})

test('anything on the log after the answer means the ticket asks again', () => {
  const ticket = parseTicket(`${OLDER_COPY_FILE}- 2026-11-25T16:30Z note asked again with a new question\n`)

  expect(ticket.answerSent).toBeUndefined()
})

test('the summary says them when several answers wait for a session', () => {
  const second = { ...answeredOnce(), id: 'SQ-4', title: 'Pick a limit' }

  expect(summaryOf([answeredOnce(), second])).toContain('nobody has acted on them yet, so act on them or ask again: SQ-3 (Pick a backoff), SQ-4 (Pick a limit).')
})
