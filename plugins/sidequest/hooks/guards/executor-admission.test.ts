import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { SnapshotRow } from './context-guards.js'
import {
  ADMISSION_FAILED, finishedExecutorUnproven, needsDecision, parseDecision, rewrittenCall, shellNeedsDecision, writeNeedsDecision,
} from './executor-admission.js'
import type { Caller } from './executor-admission.js'

function row(fields: Partial<SnapshotRow>): SnapshotRow {
  return {
    ref: 'SQ-1', sessionId: 'main-session', claimSessionId: null, agentId: 'agent-1', agentName: 'sq-1-exec', executor: 'sidequest-exec-high',
    worktree: null, sharedTree: true, readonly: false, state: 'claimed', deniedTools: [], ...fields,
  }
}

function caller(fields: Partial<Caller>): Caller {
  return { agentId: 'agent-1', type: 'sidequest-exec-high', sessionId: 'main-session', row: row({}), fresh: true, ...fields }
}

const MAIN_LOOP = caller({ agentId: '', type: '', row: null })

// The engine calls the guard makes outside a session: no snapshot on disk, the main loop's session.
function session(on: On) {
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:\Users\kenny' })
  on('session.cwd', () => ({ value: 'C:/repo' }))
  on('session.id', () => ({ value: 'main-session' }))
  on('agent.list', () => ({ value: [] }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
}

// Each test names its own cwd, so the guard's per-project snapshot cache never carries one test's rows into another.
function sessionWithSnapshot(on: On, cwd: string, sessionId: string, snapshot: object) {
  mock.env(on, { OS: 'Windows_NT', USERPROFILE: 'C:/Users/kenny' })
  on('session.cwd', () => ({ value: cwd }))
  on('session.id', () => ({ value: sessionId }))
  const text = JSON.stringify({ v: 1, routed: true, ...snapshot })
  on('fs.read', ($$, e) => (e.path.endsWith('dispatch-snapshot.json') ? { value: text } : { deny: 'ENOENT' }))
}

function decisionDenies(reason: string) {
  return { value: { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: reason } }), stderr: '' } }
}

test('an executor\'s ordinary shell, write and board calls need no decision process', () => {
  const executor = caller({})
  expect(shellNeedsDecision(executor, 'npm test > out.log')).toBe(false)
  expect(writeNeedsDecision(executor)).toBe(false)
  expect(needsDecision('Bash', { command: 'git status' }, MAIN_LOOP)).toBe(false)
  expect(needsDecision('Edit', { file_path: 'C:/repo/a.ts' }, MAIN_LOOP)).toBe(false)
  expect(needsDecision('mcp__plugin_sidequest_board__update', { ref: 'SQ-1' }, MAIN_LOOP)).toBe(false)
})

test('a call the decision could refuse runs it', () => {
  expect(shellNeedsDecision(caller({}), 'node sidequest.js dispatch SQ-9')).toBe(true)
  expect(needsDecision('mcp__plugin_sidequest_board__update', { ref: 'SQ-1', files: [] }, caller({}))).toBe(true)
  expect(needsDecision('SendMessage', { to: 'sq-1-exec', message: 'm' }, MAIN_LOOP)).toBe(true)
  const readOnly = caller({ type: 'sidequest-exec-readonly-high' })
  expect(shellNeedsDecision(readOnly, 'git log --oneline 2>&1')).toBe(false)
  expect(shellNeedsDecision(readOnly, 'echo x > notes.txt')).toBe(true)
  expect(shellNeedsDecision(readOnly, 'git commit -m x')).toBe(true)
})

test('only a fresh live row of this session proves an executor is not finished', () => {
  expect(finishedExecutorUnproven(caller({}))).toBe(false)
  expect(finishedExecutorUnproven(caller({ fresh: false }))).toBe(true)
  expect(finishedExecutorUnproven(caller({ row: null }))).toBe(true)
  expect(finishedExecutorUnproven(caller({ row: row({ sessionId: 'other' }) }))).toBe(true)
  expect(finishedExecutorUnproven(caller({ type: 'general-purpose', row: null }))).toBe(false)
})

test('a helper write is always decided, since its owner may sit in another project', () => {
  expect(writeNeedsDecision(caller({ agentId: 'helper-1', type: 'general-purpose', row: null }))).toBe(true)
  expect(writeNeedsDecision(caller({ agentId: 'helper-1', type: 'general-purpose', row: null, fresh: false }))).toBe(true)
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
  on('process.run', () => decisionDenies(steer))
  on('tool.call', () => ({ result: 'ran', text: 'ran' }) as never)
  expect(await $.tool.call({ tool: 'SendMessage', to: 'dead-exec', message: 'stop' } as never)).toMatchObject({ deny: steer })
})

// SQ-3759 review: an empty snapshot is no proof the helper's session holds no ticket; the live store's SQ-1 does.
test('a helper write with no snapshot row still runs the scope decision', async ($, on) => {
  sessionWithSnapshot(on, 'C:/repo-helper', 'session-1', { at: new Date().toISOString(), dispatches: [] })
  on('agent.list', () => ({ value: [{ id: 'helper-1', type: 'general-purpose' }] }))
  const outside = 'sidequest: refusing helper write to private.txt. It is outside SQ-1\'s effective scope.'
  on('process.run', () => decisionDenies(outside))
  on('tool.call', () => ({ result: 'ran', text: 'ran' }) as never)
  const written = await $.tool.call({ tool: 'Write', file_path: 'C:/repo/private.txt', content: 'x', agentId: 'helper-1' } as never)
  expect(written).toMatchObject({ deny: outside })
})

test('a stale snapshot does not prove an executor is still live', async ($, on) => {
  sessionWithSnapshot(on, 'C:/repo-stale', 'main-session', { at: new Date(Date.now() - 120_000).toISOString(), dispatches: [row({})] })
  on('agent.list', () => ({ value: [{ id: 'agent-1', type: 'sidequest-exec-high' }] }))
  const closed = 'sidequest: SQ-1 is closed (done; delivered by orchestrator). End this turn now without further calls.'
  on('process.run', () => decisionDenies(closed))
  on('tool.call', () => ({ result: 'ran', text: 'ran' }) as never)
  expect(await $.tool.call({ tool: 'Bash', command: 'git status', agentId: 'agent-1' } as never)).toMatchObject({ deny: closed })
})

// SQ-3759 review: an agent.list failure once skipped the guard and admitted a subagent's force-remove.
test('a subagent\'s main-thread-only board call is refused even when the engine fails', async ($, on) => {
  sessionWithSnapshot(on, 'C:/repo-engine-down', 'main-session', { at: new Date().toISOString(), dispatches: [] })
  on('agent.list', () => ({ deny: 'agent.list unavailable' }))
  on('process.run', () => ({ deny: 'node missing' }))
  on('tool.call', () => ({ result: 'ran', text: 'ran' }) as never)
  const removed = await $.tool.call({ tool: 'mcp__plugin_sidequest_board__remove', ref: 'SQ-1', force: true, agentId: 'child-1' } as never)
  expect(removed).toMatchObject({ deny: 'sidequest: subagents cannot force-remove a ticket. Release your claim, or ask the orchestrator to remove it from the main thread.' })
})

// SQ-3759 review: a teammate is its own session's main loop, known only by the session that claimed its ticket.
test('a read-only teammate\'s shell write reaches the decision as its claimed executor', async ($, on) => {
  const teammate = row({ sessionId: 'preparer-session', claimSessionId: 'teammate-session', agentId: 'worker-1', executor: 'sidequest-exec-readonly-high', readonly: true })
  sessionWithSnapshot(on, 'C:/repo-teammate', 'teammate-session', { at: new Date().toISOString(), dispatches: [teammate] })
  on('agent.list', () => ({ value: [] }))
  const decisionInputs: string[] = []
  on('process.run', ($$, e) => {
    decisionInputs.push(JSON.stringify(e))
    return decisionDenies('sidequest: read-only executor cannot write private.txt')
  })
  on('tool.call', () => ({ result: 'ran', text: 'ran' }) as never)
  const written = await $.tool.call({ tool: 'PowerShell', command: 'Set-Content C:/repo/private.txt x' } as never)
  expect(written).toMatchObject({ deny: 'sidequest: read-only executor cannot write private.txt' })
  expect(decisionInputs[0]).toContain('sidequest-exec-readonly-high')
  expect(decisionInputs[0]).not.toContain('preparer-session')
  const update = await $.tool.call({ tool: 'mcp__plugin_sidequest_board__update', ref: 'SQ-1', status: 'done' } as never)
  expect(Reflect.get(update, 'deny')).toContain('subagents cannot update closeout fields')
})

const MAIN_LOOP_MIX: object[] = [
  ...Array.from({ length: 15 }, (_, index) => ({ tool: 'Bash', command: `echo ${index}` })),
  ...Array.from({ length: 5 }, (_, index) => ({ tool: 'PowerShell', command: `Write-Output ${index}` })),
  ...Array.from({ length: 15 }, (_, index) => ({ tool: 'Read', file_path: `C:/repo/file-${index}.ts` })),
  ...Array.from({ length: 10 }, (_, index) => ({ tool: 'Edit', file_path: `C:/repo/file-${index}.ts`, old_string: 'a', new_string: 'b' })),
  ...['claim', 'comment', 'update'].map((tool) => ({ tool: `mcp__plugin_sidequest_board__${tool}`, ref: 'SQ-1' })),
  { tool: 'Agent', description: 'd', prompt: 'p', subagent_type: 'Explore' },
  { tool: 'Skill', skill: 'verify' },
]

// US-84 measurement: the 50-call mix from the main loop spawns one decision process, the Agent call's.
test('the 50-call mix runs one decision process', async ($, on) => {
  session(on)
  let decisions = 0
  on('process.run', () => {
    decisions += 1
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('tool.call', () => ({ result: 'ran', text: 'ran' }) as never)
  expect(MAIN_LOOP_MIX.length).toBe(50)
  for (const call of MAIN_LOOP_MIX) await $.tool.call(call as never)
  expect(decisions).toBe(1)
})
