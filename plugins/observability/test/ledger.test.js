'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')

const {
  addAgent,
  addStep,
  addSubagentUsage,
  addToolCall,
  appendLine,
  firstLine,
  foldTurn,
  freshRecording,
  nextRecording,
  notePrompt,
  projectSlug,
  rowsSince,
  ticketRef,
  tokensOf,
} = require('../hooks/ledger.ts')

const usage = (input, output, cacheRead, cacheWrite) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
})

function recordedTurn() {
  let turn = { ...freshRecording(1.25), name: 'Fix the ledger', ticket: 'SQ-12' }
  turn = addStep(turn, { model: 'claude-opus', latencyMs: 1200, usage: tokensOf(usage(100, 20, 3000, 50)) })
  turn = addStep(turn, { model: 'claude-haiku', latencyMs: 300, usage: tokensOf(usage(10, 5, 0, 0)) })
  turn = addToolCall(turn, { tool: 'Bash', ms: 400, isError: false, isDenied: false })
  turn = addToolCall(turn, { tool: 'Bash', ms: 100, isError: true, isDenied: false })
  turn = addToolCall(turn, { tool: 'Edit', ms: 5, isError: false, isDenied: true })
  turn = addAgent(turn, 'Explore')
  turn = addSubagentUsage(turn, tokensOf(usage(10, 5, 0, 0)))
  return turn
}

const end = {
  at: '2026-10-17T12:00:00.000Z',
  project: 'eigenwise-toolshed',
  session: 'session-1',
  startedAt: 1792000000000,
  turn: 3,
  reason: 'answer',
  durationMs: 4200,
  usage: tokensOf(usage(100, 20, 3000, 50)),
  sessionUsage: {
    startedAt: 1792000000000,
    context: { tokens: 42000, window: 200000, percent: 21, breakdown: { ignored: true } },
    rateLimits: [{ kind: 'five_hour', percentUsed: 12, resetsAt: '2026-10-17T15:00:00.000Z' }],
    cost: { usd: 1.5 },
  },
  model: 'claude-opus',
  version: '2.1.302',
}

test('a turn with two steps and three tool calls folds to the pinned row', () => {
  const row = JSON.parse(JSON.stringify(foldTurn(recordedTurn(), end)))
  assert.deepEqual(row, {
    v: 1,
    at: '2026-10-17T12:00:00.000Z',
    project: 'eigenwise-toolshed',
    session: 'session-1',
    startedAt: 1792000000000,
    name: 'Fix the ledger',
    turn: 3,
    reason: 'answer',
    durationMs: 4200,
    costUsd: 1.5,
    turnCostUsd: 0.25,
    model: 'claude-opus',
    usage: { input: 110, output: 25, cacheRead: 3000, cacheWrite: 50 },
    models: {
      'claude-opus': { input: 100, output: 20, cacheRead: 3000, cacheWrite: 50, requests: 1, latencyMs: 1200 },
      'claude-haiku': { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, requests: 1, latencyMs: 300 },
    },
    tools: {
      Bash: { calls: 2, errors: 1, denies: 0, ms: 500 },
      Edit: { calls: 1, errors: 0, denies: 1, ms: 5 },
    },
    agents: { Explore: 1 },
    context: { tokens: 42000, window: 200000, percent: 21 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 12, resetsAt: '2026-10-17T15:00:00.000Z' }],
    compacted: false,
    ticket: 'SQ-12',
    version: '2.1.302',
  })
  assert.ok(JSON.stringify(row).length < 1024, 'a row stays under 1 KB')
})

test('the next turn keeps name, ticket and the cost baseline and starts its tallies over', () => {
  const next = nextRecording(recordedTurn(), 1.5)
  assert.deepEqual(next, { ...freshRecording(1.5), name: 'Fix the ledger', ticket: 'SQ-12' })
})

test('a session cost below the baseline counts as a restarted engine ledger', () => {
  const row = foldTurn(freshRecording(5), { ...end, sessionUsage: { ...end.sessionUsage, cost: { usd: 0.4 } } })
  assert.equal(row.turnCostUsd, 0.4)
})

test('ticketRef reads an SQ ref from the first line or a route marker', () => {
  assert.equal(ticketRef('Work SQ-3733 now\nand SQ-9 later'), 'SQ-3733')
  assert.equal(ticketRef('Do the thing\n[sidequest-route ticket=SQ-41 model=opus]'), 'SQ-41')
  assert.equal(ticketRef('first line\nSQ-7 only in the body'), undefined)
  assert.equal(ticketRef('XSQ-7 is not a ref'), undefined)
})

test('firstLine names a task by its first prompt line, 60 characters at most', () => {
  assert.equal(firstLine('  Build it\nmore'), 'Build it')
  assert.equal(firstLine('x'.repeat(80)).length, 60)
})

test('notePrompt names the task once and takes the newest ticket', () => {
  const first = notePrompt(freshRecording(), 'Fix SQ-1 first\nbody')
  const second = notePrompt(first, 'Now SQ-2')
  const third = notePrompt(second, 'no ref here')
  assert.equal(third.name, 'Fix SQ-1 first')
  assert.equal(second.ticket, 'SQ-2')
  assert.equal(third.ticket, 'SQ-2')
})

test('projectSlug is the basename plus a short hash of the whole path', () => {
  assert.match(projectSlug('C:\\dev\\eigenwise-toolshed'), /^eigenwise-toolshed-[0-9a-f]{6}$/)
  assert.match(projectSlug('/home/me/my project/'), /^my_project-[0-9a-f]{6}$/)
  assert.notEqual(projectSlug('C:\\a\\app'), projectSlug('C:\\b\\app'))
  assert.equal(projectSlug('C:\\dev\\App'), projectSlug('c:/dev/App/'))
})

test('appendLine adds one JSON line and rowsSince reads back recent rows, skipping broken lines', () => {
  const row = foldTurn(recordedTurn(), end)
  const old = { ...row, at: '2026-01-01T00:00:00.000Z' }
  const text = appendLine(appendLine('{"cut short', old), row)
  assert.equal(text.split('\n').length, 4)
  assert.ok(text.endsWith('\n'))
  assert.deepEqual(rowsSince(text, Date.parse('2026-10-01T00:00:00.000Z')), [JSON.parse(JSON.stringify(row))])
})
