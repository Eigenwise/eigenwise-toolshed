import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { EVIDENCE_TOOL, PROPOSAL_TOOL } from './tool-specs'
import type { On, ToolCallResult } from 'claude-code'

const NOW = Date.parse('2026-11-16T10:00:00.000Z')
const HOME_EVENTS = '/home/.claude/quartermaster/events/repo'
const EVENTS_FILE = `${HOME_EVENTS}/2026-11-16.${NOW.toString(36)}.jsonl`

const directChildren = (files: Map<string, string>, directory: string) =>
  [...files.keys()]
    .filter(path => path.startsWith(`${directory}/`) && !path.slice(directory.length + 1).includes('/'))
    .map(path => ({ name: path.slice(directory.length + 1), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false }))

const hasDirectory = (files: Map<string, string>, path: string): boolean =>
  [...files.keys()].some(file => file.startsWith(`${path}/`))

// The engine hands `fs.*` hooks an absolute native path (`C:\repo\a` on Windows).
const portable = (path: string): string => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

const statuses: (string | undefined)[] = []

let refusedWritePrefix: string | undefined

/** An in-memory disk beneath the plugin, standing in for the engine's `$.fs`. */
const fakeDisk = (on: On): Map<string, string> => {
  const files = new Map<string, string>()
  on('fs.exists', (_, e) => ({ value: files.has(portable(e.path)) || hasDirectory(files, portable(e.path)) }))
  on('fs.read', (_, e) => ({ value: files.get(portable(e.path)) ?? '' }))
  on('fs.write', (_, e) => {
    if (refusedWritePrefix !== undefined && portable(e.path).startsWith(refusedWritePrefix)) throw new Error('disk is full')
    files.set(portable(e.path), e.text)

    return { value: undefined }
  })
  on('fs.list', (_, e) => ({ value: directChildren(files, portable(e.path)) }))

  return files
}

const textOf = (answer: ToolCallResult): string => (typeof answer.result === 'string' ? answer.result : '')

const startSession = async ($: Engine, on: On, beneath: (on: On) => void = () => {}): Promise<Map<string, string>> => {
  refusedWritePrefix = undefined
  statuses.length = 0
  const files = fakeDisk(on)
  beneath(on)
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home' })
  on('tool.register', (_, e) => ({ value: { tool: `mcp__quartermaster__${e.name}` } }))
  on('command.list', () => ({ value: [] }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'qm' } }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  return files
}


let rowCount = 0

const typeShellLine = ($: Engine, command: string) => {
  rowCount += 1

  return $.session.append({
    door: 'command',
    origin: { kind: 'unclassified' },
    uuid: `row-${rowCount}`,
    message: { type: 'user', content: [{ type: 'text', text: `<bash-input>${command}</bash-input>` }] },
  })
}

const endTurn = ($: Engine) =>
  $.turn.complete({ answer: '', durationMs: 1200, isAborted: false, turnId: 't1', reason: 'answer' })

test('every sensing hook hands the result back unchanged', async ($, on) => {
  const failed = { result: 'boom', text: 'Exit code 1', isError: true } as const
  await startSession($, on, beneath => {
    beneath('tool.call', () => failed)
    beneath('classic.PermissionDenied', () => ({}))
    beneath('skill.prompt', () => ({ text: 'skill body' }))
    beneath('tool.check', { tool: 'WebFetch' }, () => ({ decision: 'deny', reason: 'blocked by rule' }))
    beneath('session.compact', () => ({ skip: 'nothing to compact' }))
  })

  expect(await $.tool.call({ tool: 'Bash', command: 'npm test' })).toEqual(failed)
  expect(await $.tool.check({ tool: 'WebFetch', input: {} })).toEqual({ decision: 'deny', reason: 'blocked by rule' })
  expect(await $.skill.prompt({ skill: 'commit', text: 'skill body' })).toEqual({ text: 'skill body' })
  expect(await $.classic.PermissionDenied({ tool_name: 'Bash', tool_input: {}, tool_use_id: 'u1', reason: 'no' })).toEqual({})
  expect(await $.session.compact({ trigger: 'manual', messages: [] })).toEqual({ skip: 'nothing to compact' })
  expect(await endTurn($)).toEqual({ text: '' })
})

test('denied calls become a permission candidate without their arguments', async ($, on) => {
  await startSession($, on, beneath => {
    beneath('tool.check', { tool: 'Bash' }, () => ({ decision: 'deny', reason: 'blocked by rule' }))
    beneath('tool.call', () => ({ result: 'unreached' }))
    beneath('classic.PermissionDenied', () => ({}))
  })
  for (let run = 0; run < 3; run += 1) await $.tool.call({ tool: 'Bash', command: 'git push origin secret-branch' })
  await $.classic.PermissionDenied({ tool_name: 'Bash', tool_input: { command: 'git push' }, tool_use_id: 'u4', reason: 'no' })
  await endTurn($)

  const answer = await $.tool.call({ tool: 'mcp__quartermaster__evidence' })

  expect(textOf(answer)).toContain('1 candidate in the last 30 days:\n- permission:bash: git push: Claude tried `git push` 4 times and was blocked each time\nLast 30 days, 5 events.')
})

test('a rule-denied call leaves one denial and no failure', async ($, on) => {
  const files = await startSession($, on, beneath => {
    beneath('tool.check', { tool: 'Bash' }, () => ({ decision: 'deny', reason: 'blocked by rule' }))
    beneath('tool.call', () => ({ result: 'blocked by rule', text: 'blocked by rule', isError: true }))
  })

  await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  await endTurn($)

  const kinds = (files.get(EVENTS_FILE) ?? '').split('\n').filter(line => line !== '').map(line => JSON.parse(line).kind)
  expect(kinds).toEqual(['denial', 'turn'])
})

test('a call nobody could be asked about is a denial, not a failure', async ($, on) => {
  const files = await startSession($, on, beneath => {
    beneath('tool.check', { tool: 'Bash' }, () => ({ decision: 'ask', reason: 'needs approval' }))
    beneath('tool.call', () => ({ result: 'needs approval', text: 'needs approval', isError: true }))
  })

  await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  await endTurn($)

  const kinds = (files.get(EVENTS_FILE) ?? '').split('\n').filter(line => line !== '').map(line => JSON.parse(line).kind)
  expect(kinds).toEqual(['denial', 'turn'])
})

test('a compaction with no turn after it is written when the session ends', async ($, on) => {
  const files = await startSession($, on, beneath => {
    beneath('session.compact', () => ({ skip: 'nothing to compact' }))
    beneath('session.end', () => ({ sessionId: 's1' }))
  })

  await $.session.compact({ trigger: 'auto', messages: [] })
  expect(files.has(EVENTS_FILE)).toBe(false)
  await $.session.end({ reason: 'other', sessionId: 's1', resume: { id: 's1' } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

  const answer = await $.tool.call({ tool: 'mcp__quartermaster__evidence' })

  expect(textOf(answer)).toContain('Last 30 days, 1 event.')
})

test('a classifier-denied call leaves one denial and no failure', async ($, on) => {
  const files = await startSession($, on, beneath => {
    beneath('classic.PermissionDenied', () => ({}))
    beneath('tool.call', async (_, e) => {
      await $.classic.PermissionDenied({
        tool_name: 'Bash',
        tool_input: { command: 'git push origin main' },
        tool_use_id: e.tool_use_id,
        reason: 'classifier said no',
      })

      return { result: 'denied', text: 'denied', isError: true }
    })
  })

  await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  await endTurn($)

  const kinds = (files.get(EVENTS_FILE) ?? '').split('\n').filter(line => line !== '').map(line => JSON.parse(line).kind)
  expect(kinds).toEqual(['denial', 'turn'])
})

test('a turn writes its events once, with prefixes and never arguments', async ($, on) => {
  const files = await startSession($, on, beneath => {
    beneath('tool.call', () => ({ result: 'output', text: 'secret output', isError: true }))
  })

  await $.tool.call({ tool: 'Bash', command: 'npm run build -- --token=abc123' })
  expect(files.has(EVENTS_FILE)).toBe(false)
  await endTurn($)

  const written = files.get(EVENTS_FILE) ?? ''
  expect(written.includes('"signature":"npm run"')).toBe(true)
  expect(written.includes('"kind":"typed"')).toBe(false)
  expect(written.includes('"kind":"turn"')).toBe(true)
  expect(written.includes('abc123') || written.includes('secret output')).toBe(false)
})

test('one burst of failures in a single sitting is evidence the tool reports, not a candidate', async ($, on) => {
  await startSession($, on, beneath => {
    beneath('tool.call', () => ({ result: 'x', text: 'Exit code 1', isError: true }))
  })
  for (let run = 0; run < 5; run += 1) await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await endTurn($)

  const answer = await $.tool.call({ tool: 'mcp__quartermaster__evidence' })

  expect(textOf(answer)).toContain('No candidates in the last 30 days (6 events).\nLast 30 days, 6 events.\nSkills exercised: none\nTyped by hand: none\nFailures: Bash: npm test 5\nDenials: none')
})

test('the proposal tool creates, approves, records a change and rolls it back', async ($, on) => {
  const files = await startSession($, on)
  files.set('/repo/package.json', '{ "old": true }')
  const call = (input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__quartermaster__proposal', ...input })

  const created = await call({
    operation: 'create',
    kind: 'script',
    target: 'npm test',
    evidence: ['fix:bash: npm test'],
    expect: 'failed npm test runs per week',
    baseline: 5,
    body: 'Add a test script.',
  })
  expect(textOf(created)).toBe('P-0001 created, status draft.')
  expect(textOf(await call({ operation: 'decide', id: 'P-0001', decision: 'approve' }))).toBe('P-0001 approved, status accepted.')

  const recorded = await call({ operation: 'record-change', id: 'P-0001', files: ['package.json', 'scripts/test.sh'] })
  expect(textOf(recorded)).toBe('C-0001 saved 2 files as they are now. Make the change, then update P-0001 to applied.')
  files.set('/repo/package.json', '{ "new": true }')
  files.set('/repo/scripts/test.sh', 'npm test')
  expect(textOf(await call({ operation: 'update', id: 'P-0001', status: 'applied' }))).toBe('P-0001 updated, status applied.')
  const rolledBack = await call({ operation: 'rollback', id: 'P-0001' })

  expect(textOf(rolledBack)).toBe('P-0001 rolled back, 1 file restored (package.json). Delete these files the change created: scripts/test.sh.')
  expect(files.get('/repo/package.json')).toBe('{ "old": true }')
  expect(files.get('/repo/.claude/quartermaster/proposals/P-0001.md')?.includes('status: rolled-back')).toBe(true)
})

test('the records folder ignores itself, and a team that removed that choice keeps it', async ($, on) => {
  const files = await startSession($, on)
  const call = (input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__quartermaster__proposal', ...input })
  const draft = { operation: 'create', kind: 'script', target: 'npm test', expect: 'failed runs', baseline: 5, body: 'Add it.' }
  const selfIgnore = '/repo/.claude/quartermaster/.gitignore'

  await call(draft)
  expect(files.get(selfIgnore)?.endsWith('\n*\n')).toBe(true)

  files.set(selfIgnore, '# shared with the team\n')
  await call({ ...draft, target: 'npm run build' })
  expect(files.get(selfIgnore)).toBe('# shared with the team\n')
})

test('an illegal move and a rejected fingerprint are refused', async ($, on) => {
  await startSession($, on)
  const call = (input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__quartermaster__proposal', ...input })
  const draft = { operation: 'create', kind: 'permission', target: 'git push', expect: 'denials', baseline: 4, body: 'Allow it.' }

  await call(draft)
  const skipped = await call({ operation: 'update', id: 'P-0001', status: 'useful' })
  expect(skipped.deny).toBe(
    'quartermaster: P-0001 is draft and cannot become useful; from draft it can become offered, accepted, declined, expired',
  )

  await call({ operation: 'decide', id: 'P-0001', decision: 'reject', reason: 'I push by hand on purpose' })
  const again = await call(draft)
  expect(again.deny).toBe('quartermaster: the human already rejected permission:git push; see rejected.md')
})

test('PowerShell is sensed as a shell: its denials group by command', async ($, on) => {
  await startSession($, on, beneath => {
    beneath('tool.check', { tool: 'PowerShell' }, () => ({ decision: 'deny', reason: 'blocked by rule' }))
    beneath('tool.call', () => ({ result: 'unreached' }))
  })
  for (let run = 0; run < 4; run += 1) await $.tool.call({ tool: 'PowerShell', command: 'git push origin main' })
  await endTurn($)

  const answer = await $.tool.call({ tool: 'mcp__quartermaster__evidence' })

  expect(textOf(answer)).toContain('1 candidate in the last 30 days:\n- permission:powershell: git push: Claude tried `git push` 4 times and was blocked each time')
})

test('evidence since a date counts only what came after it', async ($, on) => {
  const files = await startSession($, on, beneath => {
    beneath('tool.call', () => ({ result: 'ok', text: '' }))
  })
  files.set(
    '/home/.claude/quartermaster/events/repo/2026-11-10.jsonl',
    `${JSON.stringify({ kind: 'typed', at: '2026-11-10T09:00:00.000Z', prefix: 'npm run' })}\n`,
  )
  files.set(`${HOME_EVENTS}/2026-11-16.other.jsonl`, `${JSON.stringify({ kind: 'typed', at: '2026-11-16T08:00:00.000Z', prefix: 'npm test' })}\n`)

  const answer = await $.tool.call({ tool: 'mcp__quartermaster__evidence', since: '2026-11-15' })
  const refused = await $.tool.call({ tool: 'mcp__quartermaster__evidence', since: 'last week' })

  expect(textOf(answer)).toBe(
    [
      'No candidates in the last 30 days (1 event).',
      'Since 2026-11-15, 1 event.',
      'Skills exercised: none',
      'Typed by hand: npm test 1',
      'Failures: none',
      'Denials: none',
    ].join('\n'),
  )
  expect(refused.deny).toBe('quartermaster: since must be an ISO date like 2026-11-01, not last week')
})

const PROPOSAL_DRAFT = { operation: 'create', kind: 'script', target: 'npm test', expect: 'runs', baseline: 5, body: 'Add it.' }

test('update cannot decide or roll back; those go through their own operations', async ($, on) => {
  await startSession($, on)
  const call = (input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__quartermaster__proposal', ...input })
  await call(PROPOSAL_DRAFT)

  expect((await call({ operation: 'update', id: 'P-0001', status: 'accepted' })).deny).toBe(
    'quartermaster: use operation: decide to make P-0001 accepted',
  )
  expect((await call({ operation: 'update', id: 'P-0001', status: 'declined' })).deny).toBe(
    'quartermaster: use operation: decide to make P-0001 declined',
  )
  expect((await call({ operation: 'update', id: 'P-0001', status: 'rolled-back' })).deny).toBe(
    'quartermaster: use operation: rollback to make P-0001 rolled-back',
  )
  await call({ operation: 'decide', id: 'P-0001', decision: 'approve' })
  expect(textOf(await call({ operation: 'update', id: 'P-0001', status: 'expired' }))).toBe('P-0001 updated, status expired.')
})

test('a second record-change is refused, so rollback still restores the original bytes', async ($, on) => {
  const files = await startSession($, on)
  files.set('/repo/package.json', 'original')
  const call = (input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__quartermaster__proposal', ...input })
  await call(PROPOSAL_DRAFT)
  await call({ operation: 'decide', id: 'P-0001', decision: 'approve' })

  await call({ operation: 'record-change', id: 'P-0001', files: ['package.json'] })
  files.set('/repo/package.json', 'edited')
  const again = await call({ operation: 'record-change', id: 'P-0001', files: ['package.json'] })
  expect(again.deny).toBe(
    'quartermaster: C-0001 is already recorded for P-0001; recording again would save the edited files over the originals',
  )

  await call({ operation: 'update', id: 'P-0001', status: 'applied' })
  await call({ operation: 'rollback', id: 'P-0001' })
  expect(files.get('/repo/package.json')).toBe('original')
})

test('list with an id reads the whole proposal, body and expect included', async ($, on) => {
  await startSession($, on)
  const call = (input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__quartermaster__proposal', ...input })
  await call(PROPOSAL_DRAFT)

  const read = await call({ operation: 'list', id: 'P-0001' })

  expect(textOf(read).includes('expect: runs')).toBe(true)
  expect(textOf(read).includes('baseline: 5')).toBe(true)
  expect(textOf(read).includes('Add it.')).toBe(true)
})

test('a subagent can list proposals and cannot write them', async ($, on) => {
  await startSession($, on)
  const call = (input: Record<string, unknown>) =>
    $.tool.call({ tool: 'mcp__quartermaster__proposal', agentId: 'agent-1', ...input })

  expect((await call(PROPOSAL_DRAFT)).deny).toBe(
    'quartermaster: a subagent cannot write proposals; return the draft to the main session, which writes it',
  )
  expect(textOf(await call({ operation: 'list' }))).toBe('No proposals.')
})

const eventLinesOf = (kind: string, day: string, count: number): string =>
  Array.from({ length: count }, () => `${JSON.stringify({ kind, at: `${day}T09:00:00.000Z`, prefix: 'git status' })}\n`).join('')

test('eight model-run git status calls offer nothing, and eight typed over two days do', async ($, on) => {
  const files = await startSession($, on, beneath => {
    beneath('tool.call', () => ({ result: 'clean', text: '' }))
  })
  files.set(`${HOME_EVENTS}/2026-11-15.jsonl`, eventLinesOf('command', '2026-11-15', 4))
  for (let count = 0; count < 4; count += 1) await $.tool.call({ tool: 'Bash', command: 'git status' })
  await $.tool.call({ tool: 'Bash', command: 'git status', agentId: 'agent-1' })
  await endTurn($)
  const byModel = await $.tool.call({ tool: 'mcp__quartermaster__evidence' })
  expect(textOf(byModel)).toContain('No candidates in the last 30 days (1 event).')

  files.set(`${HOME_EVENTS}/2026-11-15.jsonl`, eventLinesOf('typed', '2026-11-15', 4))
  for (let count = 0; count < 4; count += 1) await typeShellLine($, 'git status')
  await endTurn($)
  const byHand = await $.tool.call({ tool: 'mcp__quartermaster__evidence' })
  expect(textOf(byHand).includes('script:git status: ran `git status` by hand 8 times over 2 days')).toBe(true)
})

test('a failed events write says why, and the events are still read afterwards', async ($, on) => {
  const files = await startSession($, on, beneath => {
    refusedWritePrefix = HOME_EVENTS
    beneath('skill.prompt', () => ({ text: '' }))
  })
  await $.skill.prompt({ skill: 'commit', text: '' })
  await endTurn($)

  expect(statuses.some(text => /could not save to .*repo \(.+\)/.test(text ?? ''))).toBe(true)
  expect(files.has(EVENTS_FILE)).toBe(false)
  expect([...files.keys()].some(path => path.startsWith('/repo/.claude/quartermaster/events/2026-11-16.'))).toBe(true)
  expect(textOf(await $.tool.call({ tool: 'mcp__quartermaster__evidence', since: '2026-11-16' })).includes('commit 1')).toBe(true)
})

const isContentBlock = (block: unknown): boolean => typeof block === 'object' && block !== null && 'type' in block

const isHostAcceptedResult = (result: unknown): boolean =>
  typeof result === 'string' || (Array.isArray(result) && result.every(isContentBlock))

test('every operation of both tools answers with a result the host accepts', async ($, on) => {
  const files = await startSession($, on)
  files.set('/repo/package.json', '{ "old": true }')
  const called = new Set<string>()
  const proposal = async (input: Record<string, unknown>) => {
    called.add(`proposal:${String(input.operation)}`)

    return $.tool.call({ tool: 'mcp__quartermaster__proposal', ...input })
  }
  const evidence = async (input: Record<string, unknown> = {}) => {
    called.add('evidence')

    return $.tool.call({ tool: 'mcp__quartermaster__evidence', ...input })
  }
  const draft = { operation: 'create', kind: 'script', target: 'npm test', expect: 'failed runs', baseline: 5, body: 'Add it.' }

  const answers = [
    await evidence(),
    await evidence({ since: '2026-11-15' }),
    await proposal({ operation: 'list' }),
    await proposal(draft),
    await proposal({ operation: 'list' }),
    await proposal({ operation: 'list', id: 'P-0001' }),
    await proposal({ operation: 'update', id: 'P-0001', target: 'npm run test' }),
    await proposal({ operation: 'decide', id: 'P-0001', decision: 'later' }),
    await proposal({ operation: 'decide', id: 'P-0001', decision: 'approve' }),
    await proposal({ operation: 'record-change', id: 'P-0001', files: ['package.json'] }),
    await proposal({ operation: 'update', id: 'P-0001', status: 'applied' }),
    await proposal({ operation: 'rollback', id: 'P-0001' }),
  ]

  const operations = PROPOSAL_TOOL.inputSchema.properties.operation.enum.map(operation => `proposal:${operation}`)
  expect([...called].sort()).toEqual([EVIDENCE_TOOL.name, ...operations].sort())
  for (const answer of answers) {
    expect(answer.deny).toBeUndefined()
    expect(isHostAcceptedResult(answer.result)).toBe(true)
  }
})

test('a plain evidence call carries the three tallies, and an unparsable proposal is listed', async ($, on) => {
  const files = await startSession($, on)
  files.set('/repo/.claude/quartermaster/proposals/P-0002.md', 'not a proposal')
  await $.tool.call({ tool: 'mcp__quartermaster__proposal', operation: 'create', kind: 'script', target: 'npm test', expect: 'runs', baseline: 1, body: 'Add it.' })

  const evidence = textOf(await $.tool.call({ tool: 'mcp__quartermaster__evidence' }))
  const list = textOf(await $.tool.call({ tool: 'mcp__quartermaster__proposal', operation: 'list' }))

  expect(evidence).toContain('Last 30 days, 0 events.')
  expect(evidence).toContain('Skills exercised: none\nTyped by hand: none\nFailures: none\nDenials: none')
  expect(list).toContain('P-0002.md does not parse:')
})

test('the evidence text has a denials line', async ($, on) => {
  await startSession($, on, beneath => {
    beneath('tool.check', { tool: 'Bash' }, () => ({ decision: 'deny', reason: 'blocked by rule' }))
    beneath('tool.call', () => ({ result: 'blocked', text: 'blocked', isError: true }))
  })
  await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
  await $.tool.call({ tool: 'Bash', command: 'git push origin dev' })
  await endTurn($)

  const answer = await $.tool.call({ tool: 'mcp__quartermaster__evidence' })

  expect(textOf(answer)).toContain('Failures: none\nDenials: Bash: git push 2')
})

const SETTINGS_PATH = '.claude/settings.local.json'
const SETTINGS_FILE = `/repo/${SETTINGS_PATH}`
const SETTINGS_WITH_CHANGE = '{\n  "permissions": {}\n}\n'

const startAppliedSettingsChange = async ($: Engine, on: On, extraFiles: readonly string[] = []) => {
  const files = await startSession($, on)
  const call = (input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__quartermaster__proposal', ...input })
  files.set(SETTINGS_FILE, '{}\n')
  files.set('/repo/notes.txt', 'before')
  await call(PROPOSAL_DRAFT)
  await call({ operation: 'decide', id: 'P-0001', decision: 'approve' })
  await call({ operation: 'record-change', id: 'P-0001', files: [SETTINGS_PATH, ...extraFiles] })
  files.set(SETTINGS_FILE, SETTINGS_WITH_CHANGE)
  for (const extraFile of extraFiles) files.set(`/repo/${extraFile}`, 'written by the change')
  await call({ operation: 'update', id: 'P-0001', status: 'applied' })

  return { files, call }
}

test('a rollback leaves a file a person edited after the change, and says what to undo by hand', async ($, on) => {
  const { files, call } = await startAppliedSettingsChange($, on)
  const editedSettings = '{\n  "permissions": {},\n  "env": { "TEAM": "1" }\n}\n'
  files.set(SETTINGS_FILE, editedSettings)

  const answer = textOf(await call({ operation: 'rollback', id: 'P-0001' }))

  expect(files.get(SETTINGS_FILE)).toBe(editedSettings)
  expect(answer).toContain(`${SETTINGS_PATH} changed since the change was applied`)
  expect(answer).toContain('+   "env": { "TEAM": "1" }')
  expect(files.get('/repo/.claude/quartermaster/proposals/P-0001.md')?.includes('status: applied')).toBe(true)
})

test('a rollback with nothing edited since restores the file as before', async ($, on) => {
  const { files, call } = await startAppliedSettingsChange($, on)

  const answer = textOf(await call({ operation: 'rollback', id: 'P-0001' }))

  expect(files.get(SETTINGS_FILE)).toBe('{}\n')
  expect(answer).toBe(`P-0001 rolled back, 1 file restored (${SETTINGS_PATH}).`)
})

test('a rollback restores the files that are unchanged and leaves the one that changed', async ($, on) => {
  const { files, call } = await startAppliedSettingsChange($, on, ['notes.txt'])
  files.set(SETTINGS_FILE, `${SETTINGS_WITH_CHANGE}more`)

  const answer = textOf(await call({ operation: 'rollback', id: 'P-0001' }))

  expect(answer).toContain('1 file restored (notes.txt)')
  expect(answer).toContain(`${SETTINGS_PATH} changed since the change was applied`)
  expect(files.get(SETTINGS_FILE)).toBe(`${SETTINGS_WITH_CHANGE}more`)
})

test('a file the change created is deleted when unchanged and left when it changed since', async ($, on) => {
  const { files, call } = await startAppliedSettingsChange($, on, ['scripts/new.sh'])
  files.set('/repo/scripts/new.sh', 'echo changed later')

  const answer = textOf(await call({ operation: 'rollback', id: 'P-0001' }))

  expect(answer).toContain('scripts/new.sh changed since the change was applied')
  expect(answer).not.toContain('Delete these files')
  expect(files.get('/repo/scripts/new.sh')).toBe('echo changed later')
})

test('a created file that is unchanged is still named for deletion', async ($, on) => {
  const { call } = await startAppliedSettingsChange($, on, ['scripts/new.sh'])

  const answer = textOf(await call({ operation: 'rollback', id: 'P-0001' }))

  expect(answer).toContain('Delete these files the change created: scripts/new.sh.')
})

test('a change record from before written bytes were saved is left alone and says why', async ($, on) => {
  const { files, call } = await startAppliedSettingsChange($, on)
  const recordPath = '/repo/.claude/quartermaster/changes/C-0001/change.json'
  const record = JSON.parse(files.get(recordPath) ?? '')
  for (const file of record.files) delete file.after
  files.set(recordPath, JSON.stringify(record))

  const answer = textOf(await call({ operation: 'rollback', id: 'P-0001' }))

  expect(files.get(SETTINGS_FILE)).toBe(SETTINGS_WITH_CHANGE)
  expect(answer).toContain('made before Quartermaster saved what a change wrote')
})
