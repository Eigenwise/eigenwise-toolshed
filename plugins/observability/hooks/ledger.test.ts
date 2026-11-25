import { expect, test } from 'claude-code/testing'
import type { PromptOrigin, PromptSubmitInput } from 'claude-code'

import { addToolCall, carryOverIntoNextTurn, freshRecording, isPersonsOwnPrompt, notePrompt, projectSlug, turnCostSince } from './ledger'
import { ledgerFoldersOf, olderConfigDirectoryOf, rowsSince, sessionLedgerFile } from './ledger-files'
import { boardWrittenText, parseSwitchChoice, recordingStatusText, switchKeyOf } from './recording-switch'

test('a turn costs what the session cost grew by', () => {
  expect(turnCostSince(1, 1.25)).toBe(0.25)
})

test('a cost below the baseline means the engine started over, so the whole cost is the turn', () => {
  expect(turnCostSince(5, 0.5)).toBe(0.5)
})

test('no cost from the engine gives no turn cost', () => {
  expect(turnCostSince(5, undefined)).toBeUndefined()
})

test('the project slug keeps the folder name and tells same-named folders apart', () => {
  expect(projectSlug('/work/demo')).toBe('demo-7b8bd8')
  expect(projectSlug('/work/demo/')).toBe('demo-7b8bd8')
  expect(projectSlug('/other/demo')).not.toBe(projectSlug('/work/demo'))
})

test('the first prompt names the task and a later one does not rename it', () => {
  const named = notePrompt(freshRecording(), 'Fix the login\nmore detail')
  expect(named.name).toBe('Fix the login')
  expect(notePrompt(named, 'Another thing').name).toBe('Fix the login')
})

test('a prompt that names a ticket sets it, with any board prefix', () => {
  expect(notePrompt(freshRecording(), 'SQ-31 work on it').ticket).toBe('SQ-31')
  expect(notePrompt(freshRecording(), 'Ticket PL-12: work on it').ticket).toBe('PL-12')
  expect(notePrompt(freshRecording(), 'PL-12 [route:review] check it').ticket).toBe('PL-12')
})

test('a story id or a ticket further in the prompt sets nothing', () => {
  expect(notePrompt(freshRecording(), 'PL-S3 plan it')).not.toHaveProperty('ticket')
  expect(notePrompt(freshRecording(), 'compare SQ-3 and SQ-4')).not.toHaveProperty('ticket')
})

test('tool calls add up per tool', () => {
  const once = addToolCall(freshRecording(), { tool: 'Bash', durationMs: 10, isError: true, isDenied: false })
  const twice = addToolCall(once, { tool: 'Bash', durationMs: 5, isError: false, isDenied: true })
  expect(twice.tools.Bash).toEqual({ calls: 2, errors: 1, denies: 1, ms: 15 })
})

test('the next turn keeps the name and the cost baseline but not the ticket', () => {
  const recording = notePrompt(freshRecording(2), 'SQ-31 work on it')
  const next = carryOverIntoNextTurn(recording, 3)
  expect(next).toMatchObject({ name: 'SQ-31 work on it', costUsd: 3 })
  expect(next).not.toHaveProperty('ticket')
})

const promptFrom = (origin: PromptOrigin, text = 'Fix the login', extra: Partial<PromptSubmitInput> = {}): PromptSubmitInput => ({ text, origin, wait: false, ...extra })

test('a prompt the person typed, sent from their phone or gave to a headless run names the session', () => {
  expect(isPersonsOwnPrompt(promptFrom({ kind: 'composer' }))).toBe(true)
  expect(isPersonsOwnPrompt(promptFrom({ kind: 'bridge' }))).toBe(true)
  expect(isPersonsOwnPrompt(promptFrom({ kind: 'sdk' }))).toBe(true)
})

test("another session's message, a task notification, a schedule or a plugin never names the session", () => {
  expect(isPersonsOwnPrompt(promptFrom({ kind: 'peer' }))).toBe(false)
  expect(isPersonsOwnPrompt(promptFrom({ kind: 'peer-send-message' }))).toBe(false)
  expect(isPersonsOwnPrompt(promptFrom({ kind: 'task-notification' }))).toBe(false)
  expect(isPersonsOwnPrompt(promptFrom({ kind: 'scheduled-trigger' }))).toBe(false)
  expect(isPersonsOwnPrompt(promptFrom({ kind: 'plugin', name: 'other' }))).toBe(false)
})

test('a slash command, a hidden prompt or an empty one names nothing either', () => {
  expect(isPersonsOwnPrompt(promptFrom({ kind: 'composer' }, '/compact', { command: { name: 'compact', args: '' } }))).toBe(false)
  expect(isPersonsOwnPrompt(promptFrom({ kind: 'composer' }, 'hidden', { isMeta: true }))).toBe(false)
  expect(isPersonsOwnPrompt(promptFrom({ kind: 'composer' }, '   '))).toBe(false)
})

test('the switch key is the older plugin’s, so a project it recorded keeps recording', () => {
  expect(switchKeyOf('/work/demo')).toBe('track:/work/demo')
})

test('track takes on, off and status, and nothing else', () => {
  expect(parseSwitchChoice('on')).toBe('on')
  expect(parseSwitchChoice(' OFF ')).toBe('off')
  expect(parseSwitchChoice('')).toBe('status')
  expect(parseSwitchChoice('sideways')).toBeUndefined()
})

test('the status says whether the project is recorded and where the ledger is', () => {
  expect(recordingStatusText(true, '/work/demo', '/cfg/ledger/demo.session-1.jsonl')).toBe('observability: recording turns for /work/demo, into /cfg/ledger/demo.session-1.jsonl')
  expect(recordingStatusText(false, '/work/demo', '/cfg/ledger/demo.session-1.jsonl')).toContain('not recording turns for /work/demo')
  expect(recordingStatusText(false, '/work/demo', '/cfg/ledger/demo.session-1.jsonl')).toContain('/cfg/ledger/demo.session-1.jsonl')
})

test('a usage page written for someone away from this screen says where it is', () => {
  expect(boardWrittenText('/cfg/observability/board.html', false)).toBe('observability: usage page written to /cfg/observability/board.html on this computer; open it there.')
  expect(boardWrittenText('/cfg/observability/board.html', true)).toBe('observability: usage page written to /cfg/observability/board.html')
})

test('each session has its own ledger file', () => {
  expect(sessionLedgerFile('/ledger', 'demo-7b8bd8', 'session-1')).toBe('/ledger/demo-7b8bd8.session-1.jsonl')
  expect(sessionLedgerFile('/ledger', 'demo-7b8bd8', 'a/b:c')).toBe('/ledger/demo-7b8bd8.a_b_c.jsonl')
})

test('the older plugin looked at HOME before USERPROFILE, so both folders are read where they differ', () => {
  expect(olderConfigDirectoryOf({ HOME: '/home-folder', USERPROFILE: '/profile-folder' })).toBe('/home-folder/.claude')
  expect(ledgerFoldersOf({ HOME: '/home-folder', USERPROFILE: '/profile-folder' })).toEqual([
    '/profile-folder/.claude/observability/ledger',
    '/home-folder/.claude/observability/ledger',
  ])
  expect(ledgerFoldersOf({ HOME: '/same', USERPROFILE: '/same/' })).toEqual(['/same/.claude/observability/ledger'])
  expect(ledgerFoldersOf({ CLAUDE_CONFIG_DIR: '/configured', HOME: '/home-folder' })).toEqual(['/configured/observability/ledger'])
})

test('rows are read since a time, a line cut short is skipped, and a quality field rides along unread', () => {
  const text = [
    JSON.stringify({ at: '2026-11-01T00:00:00.000Z', name: 'old' }),
    JSON.stringify({ at: '2026-11-10T00:00:00.000Z', name: 'new', quality: { ccMax: 8 } }),
    '{"at":"2026-11-11T00:00:00.000Z", cut',
  ].join('\n')
  expect(rowsSince(text, Date.parse('2026-11-05T00:00:00.000Z')).map(row => row.name)).toEqual(['new'])
})
