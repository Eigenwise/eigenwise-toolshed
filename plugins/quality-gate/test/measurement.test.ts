import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { TurnMeasurement } from '../types'
import { TEST_COMMAND } from '../hooks/measure.ts'

const REPORT = { bodies: [{ file: 'src/a.ts', name: 'answer', cc: 1, state: 'new', verdict: 'unverified' }], signals: [], unverified: true, lcov: null }
const CWD = '/work/executor'

function engine(on: On) {
  const clock = mock.clock(on)
  const observed: { turn?: Record<string, TurnMeasurement>; notice?: boolean } = {}
  on('state.set', { plugin: 'quality-gate', key: 'turn' }, ($, event, next) => { observed.turn = event.value; return next(event) })
  on('state.set', { plugin: 'quality-gate', key: 'coverageNoticeShown' }, ($, event, next) => { observed.notice = event.value; return next(event) })
  on('session.cwd', () => ({ value: CWD }))
  on('turn.start', ($, event) => ({ turnId: event.turnId }))
  on('turn.complete', ($, event) => ({ text: event.answer }))
  on('classic.PostToolUse', () => ({}))
  on('tool.call', { tool: ['Bash', 'PowerShell'] }, ($, event) => ({ result: { stdout: '', stderr: '', interrupted: false }, isError: event.tool === 'PowerShell' }))
  return { observed, clock }
}

async function edit($: Engine, cwd = CWD, agent_id?: string) {
  await $.classic.PostToolUse({ cwd, agent_id, tool_name: 'Edit', tool_input: { file_path: `${cwd}/src/a.ts` }, tool_response: {}, tool_use_id: 'edit-1' })
}

async function complete($: Engine, agentId?: string) {
  await $.turn.complete({ answer: 'done', durationMs: 100, isAborted: false, turnId: 'turn-1', reason: 'answer', agentId })
}

test('edits run one project-local CLI at turn end with the turn start, then clear', async ($, on) => {
  const { observed, clock } = engine(on)
  const calls: { argv: readonly string[]; cwd?: string; timeoutMs?: number }[] = []
  on('process.run', ($, event) => {
    calls.push({ argv: event.argv, ...event.init })
    expect(event.argv[1]).toMatch(/quality-gate[\\/]bin[\\/]quality-gate\.js$/)
    return { value: { exitCode: 0, stdout: JSON.stringify(REPORT), stderr: '' } }
  })
  on('ui.status', () => ({ value: undefined }))
  await $.turn.start({ text: 'fix', turnId: 'turn-1' })
  const since = new Date(clock.now()).toISOString()
  await clock.advance(100)
  await edit($)
  await edit($)
  expect(calls).toEqual([])
  await complete($)
  expect(calls.length).toBe(1)
  expect(calls[0].argv.slice(2)).toEqual(['turn', '--json', '--project', CWD, '--since', since])
  expect(calls[0].cwd).toBe(CWD)
  expect(calls[0].timeoutMs).toBe(20000)
  expect(observed.turn?.[CWD]).toMatchObject({ bodies: REPORT.bodies, signals: [], unverified: true, tests: { status: 'none', at: '', stale: true } })
  await complete($)
  expect(calls.length).toBe(1)
})

test('passing tests clear stale, another edit makes tests stale, and a failed command records fail', async ($, on) => {
  const { observed } = engine(on)
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ ...REPORT, unverified: false }), stderr: '' } }))
  await edit($)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await complete($)
  expect(observed.turn?.[CWD].tests).toMatchObject({ status: 'pass', stale: false })
  await edit($)
  await complete($)
  expect(observed.turn?.[CWD].tests).toMatchObject({ status: 'pass', stale: true })
  await edit($)
  await $.tool.call({ tool: 'PowerShell', command: 'pytest' })
  await complete($)
  expect(observed.turn?.[CWD].tests).toMatchObject({ status: 'fail', stale: false })
})

for (const failure of ['exit', 'throw', 'json']) {
  test(`CLI ${failure} failure leaves state untouched and completes`, async ($, on) => {
    const { observed } = engine(on)
    on('process.run', () => {
      if (failure === 'throw') throw new Error('process unavailable')
      return { value: { exitCode: failure === 'exit' ? 1 : 0, stdout: 'invalid JSON', stderr: '' } }
    })
    await edit($)
    await complete($)
    expect(observed).toEqual({})
  })
}

test('coverage notice shows once across projects and subagent cwd stays separate', async ($, on) => {
  const { observed } = engine(on)
  const notices: string[] = []
  const projects: string[] = []
  on('ui.status', ($, event) => { notices.push(event.text ?? ''); return { value: undefined } })
  on('process.run', ($, event) => {
    projects.push(event.init?.cwd ?? '')
    return { value: { exitCode: 0, stdout: JSON.stringify(REPORT), stderr: '' } }
  })
  await edit($)
  await edit($, '/work/subagent', 'child-1')
  await complete($, 'child-1')
  expect(projects).toEqual(['/work/subagent'])
  await complete($)
  expect(projects).toEqual(['/work/subagent', CWD])
  expect(notices).toEqual(['quality-gate: complexity only, coverage not set up'])
  expect(Object.keys(observed.turn ?? {}).sort()).toEqual([CWD, '/work/subagent'].sort())
})

for (const command of ['npm test', 'pnpm run test', 'yarn test', 'bun test', 'node --test a.test.js', 'pytest -q', 'vitest run', 'jest', 'go test ./...', 'cargo test']) {
  test(`recognizes test runner: ${command}`, () => { expect(TEST_COMMAND.test(command)).toBe(true) })
}
for (const command of ['npm install', 'echo testing', 'node script.js', 'contest', 'npm run build']) {
  test(`ignores non-test command: ${command}`, () => { expect(TEST_COMMAND.test(command)).toBe(false) })
}
