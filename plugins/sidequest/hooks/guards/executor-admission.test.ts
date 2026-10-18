import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { SnapshotRow } from './context-guards.js'
import {
  ADMISSION_FAILED, closedExecutorCandidate, needsDecision, parseDecision, rewrittenCall, shellNeedsDecision, writeNeedsDecision,
} from './executor-admission.js'
import type { Caller } from './executor-admission.js'

function row(fields: Partial<SnapshotRow>): SnapshotRow {
  return {
    ref: 'SQ-1', sessionId: 'main-session', claimSessionId: null, agentId: 'agent-1', agentName: 'sq-1-exec', executor: 'sidequest-exec-high',
    worktree: null, sharedTree: true, readonly: false, state: 'claimed', deniedTools: [], ...fields,
  }
}

function caller(fields: Partial<Caller>): Caller {
  return { agentId: 'agent-1', type: 'sidequest-exec-high', sessionId: 'main-session', rows: [row({})], ...fields }
}

// The engine calls the guard makes outside a session: no snapshot on disk, the main loop's session.
function session(on: On) {
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:\Users\kenny' })
  on('session.cwd', () => ({ value: 'C:/repo' }))
  on('session.id', () => ({ value: 'main-session' }))
  on('agent.list', () => ({ value: [] }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
}

const PROJECT = 'C:/Users/kenny/.claude/sidequest/projects/toolshed-1234abcd'

test('an executor\'s ordinary shell, write and board calls need no decision process', () => {
  const executor = caller({})
  expect(shellNeedsDecision(executor, 'npm test > out.log')).toBe(false)
  expect(writeNeedsDecision(executor, 'C:/repo/src/a.ts', `${PROJECT}/..`)).toBe(false)
  expect(needsDecision('Bash', { command: 'git status' }, caller({ agentId: '' }), PROJECT)).toBe(false)
  expect(needsDecision('mcp__plugin_sidequest_board__update', { ref: 'SQ-1' }, caller({ agentId: '' }), PROJECT)).toBe(false)
})

test('a call the decision could refuse runs it', () => {
  expect(shellNeedsDecision(caller({}), 'node sidequest.js dispatch SQ-9')).toBe(true)
  expect(needsDecision('mcp__plugin_sidequest_board__update', { ref: 'SQ-1', files: [] }, caller({}), PROJECT)).toBe(true)
  const readOnly = caller({ type: 'sidequest-exec-readonly-high' })
  expect(shellNeedsDecision(readOnly, 'git log --oneline 2>&1')).toBe(false)
  expect(shellNeedsDecision(readOnly, 'echo x > notes.txt')).toBe(true)
  expect(shellNeedsDecision(readOnly, 'git commit -m x')).toBe(true)
})

test('a finished executor is sent to the decision only by its own closed row', () => {
  expect(closedExecutorCandidate(caller({ rows: [row({ state: 'done' })] }))).toBe(true)
  expect(closedExecutorCandidate(caller({ rows: [row({ state: 'done', agentId: null, agentName: 'sq-1-exec' })], agentId: 'sq-1-exec-2' }))).toBe(true)
  expect(closedExecutorCandidate(caller({ rows: [row({ state: 'done', sessionId: 'other' })] }))).toBe(false)
  expect(closedExecutorCandidate(caller({ rows: [row({ state: 'done', agentId: 'agent-2', agentName: 'sq-2' })] }))).toBe(false)
})

test('a helper write is decided when it targets evidence or its session holds a ticket', () => {
  const helper = (rows: SnapshotRow[]) => caller({ agentId: 'helper-1', type: 'general-purpose', rows })
  expect(writeNeedsDecision(helper([]), 'C:/repo/a.ts', 'C:/Users/kenny/.claude/sidequest/projects')).toBe(false)
  expect(writeNeedsDecision(helper([]), 'C:\\Users\\kenny\\.claude\\sidequest\\projects\\p\\verification\\SQ-1\\x.txt', 'C:/Users/kenny/.claude/sidequest/projects')).toBe(true)
  expect(writeNeedsDecision(helper([row({ agentId: 'agent-1' })]), 'C:/repo/a.ts', 'C:/Users/kenny/.claude/sidequest/projects')).toBe(true)
})

test('the decision output maps to deny, rewrite with context, or pass', () => {
  expect(parseDecision('')).toEqual({})
  expect(parseDecision(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'no' } }))).toEqual({ deny: 'no' })
  expect(parseDecision(JSON.stringify({ hookSpecificOutput: { updatedInput: { prompt: 'p' }, additionalContext: 'note' } })))
    .toEqual({ updatedInput: { prompt: 'p' }, context: 'note' })
  const rewritten = rewrittenCall({ tool: 'Agent', tool_use_id: 't1', agentId: 'a1', prompt: 'p', isolation: 'worktree' }, { prompt: 'p', mode: 'bypassPermissions' })
  expect(rewritten).toEqual({ tool: 'Agent', tool_use_id: 't1', agentId: 'a1', prompt: 'p', mode: 'bypassPermissions' })
})

test('an Agent spawn fails closed when the admission decision cannot run', async ($, on) => {
  session(on)
  on('process.run', () => ({ deny: 'node missing' }))
  on('tool.call', () => ({ result: 'ran', text: 'ran' }) as never)
  const denied = await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: 'sidequest-exec-high' })
  expect(denied).toMatchObject({ deny: ADMISSION_FAILED })
})

test('an admitted spawn runs with the decision\'s rewritten arguments and its note', async ($, on) => {
  session(on)
  const decisions: string[][] = []
  on('process.run', ($$, e) => {
    decisions.push([...e.argv])
    return { value: { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { description: 'd', prompt: 'p', subagent_type: 'Explore', name: 'n' }, additionalContext: 'sidequest: corrected' } }), stderr: '' } }
  })
  const seen: unknown[] = []
  on('tool.call', ($$, e) => {
    seen.push(e)
    return { result: 'ran', text: 'ran' } as never
  })
  const ran = await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: 'Explore', isolation: 'worktree' })
  expect(decisions.length).toBe(1)
  expect(decisions[0]?.[1]).toMatch(/hooks\/force-exec-bypass\.js$/)
  expect(seen[0]).toMatchObject({ name: 'n' })
  expect(seen[0]).not.toHaveProperty('isolation')
  expect(ran).toMatchObject({ text: 'ran', context: ['sidequest: corrected'] })
})

// The late-steer decision records the dropped message on the ticket, so it must run before the peer guard denies.
test('a message to a died executor reaches the late-steer decision before the peer guard', async ($, on) => {
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:/Users/kenny' })
  on('session.cwd', () => ({ value: 'C:/repo' }))
  on('session.id', () => ({ value: 'main-session' }))
  on('agent.list', () => ({ value: [] }))
  const snapshot = JSON.stringify({ v: 1, routed: true, dispatches: [row({ state: 'died', agentName: 'dead-exec' })] })
  on('fs.read', ($$, e) => (e.path.endsWith('dispatch-snapshot.json') ? { value: snapshot } : { deny: 'ENOENT' }))
  const steer = 'sidequest: SQ-1 is already died and dead-exec has ended, so this steer would be dropped. It is now a comment on the ticket.'
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: steer } }), stderr: '' } }))
  on('tool.call', () => ({ result: 'ran', text: 'ran' }) as never)
  expect(await $.tool.call({ tool: 'SendMessage', to: 'dead-exec', message: 'stop' } as never)).toMatchObject({ deny: steer })
})

// US-84 measurement: the 50-call mix from the main loop spawns one decision process, the Agent call's.
test('the 50-call mix runs one decision process', async ($, on) => {
  session(on)
  let decisions = 0
  on('process.run', () => {
    decisions += 1
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('tool.call', () => ({ result: 'ran', text: 'ran' }) as never)
  for (let index = 0; index < 15; index += 1) await $.tool.call({ tool: 'Bash', command: `echo ${index}` })
  for (let index = 0; index < 5; index += 1) await $.tool.call({ tool: 'PowerShell', command: `Write-Output ${index}` })
  for (let index = 0; index < 15; index += 1) await $.tool.call({ tool: 'Read', file_path: `C:/repo/file-${index}.ts` })
  for (let index = 0; index < 10; index += 1) await $.tool.call({ tool: 'Edit', file_path: `C:/repo/file-${index}.ts`, old_string: 'a', new_string: 'b' })
  for (const tool of ['claim', 'comment', 'update']) await $.tool.call({ tool: `mcp__plugin_sidequest_board__${tool}`, ref: 'SQ-1' } as never)
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: 'Explore' })
  await $.tool.call({ tool: 'Skill', skill: 'verify' } as never)
  expect(decisions).toBe(1)
})
