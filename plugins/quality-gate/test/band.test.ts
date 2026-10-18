import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'
import type { TurnMeasurement } from '../types'

const CWD = '/work/main'
const PROPS: RenderPropsOf['AbovePrompt'] = { hasSurvey: false, isWorking: false, bodyColumns: 80, maxRows: 10, scroll: { offset: 0, bodyRows: 10 }, view: {} }
const BELOW = { type: 'Text', props: {}, children: ['other band'] } as const
const REPORT: TurnMeasurement = { at: '', bodies: [{ file: 'a.ts', name: 'changed', cc: 6, state: 'modified-raised', verdict: 'fail' }], signals: [], unverified: true, tests: { status: 'none', at: '', stale: true } }

function world(on: On, enabled = true) {
  mock.store(on, { enabled })
  const clock = mock.clock(on)
  const measurement = { report: REPORT }
  on('session.cwd', () => ({ value: CWD }))
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [], cost: { usd: 1.234 } } }))
  on('ui.render', { component: 'AbovePrompt' }, () => BELOW)
  on('classic.PostToolUse', () => ({}))
  on('turn.complete', () => ({ text: 'done' }))
  on('ui.status', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(measurement.report), stderr: '' } }))
  return { measurement, clock }
}

async function publish($: Engine, cwd = CWD) {
  await $.classic.PostToolUse({ cwd, tool_name: 'Edit', tool_input: { file_path: `${cwd}/a.ts` }, tool_response: {}, tool_use_id: 'edit' })
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 'turn', reason: 'answer' })
}

async function mount($: Engine, props = PROPS) {
  return $.ui.mount({ plugin: 'quality-gate', component: 'AbovePrompt', surface: 'terminal', props })
}

test('no turn state returns the drawing beneath, then state writes redraw with SPLIT above it', async ($, on) => {
  const { clock } = world(on)
  const drawing = await mount($)
  expect(await drawing.drawn()).toMatchObject(BELOW)
  await publish($)
  expect((await drawing.find({ type: 'Text', text: 'SPLIT' }))?.text).toBe('$1.23 · CC 6 SPLIT 1 · tests none stale · coverage not set up')
  expect(await drawing.drawn()).toMatchObject({ type: 'Box', props: { width: 80, flexDirection: 'column' }, children: [expect.anything(), BELOW] })
  await drawing.redraw()
  expect((await drawing.find({ type: 'Text', text: 'coverage not set up' }))?.text).toMatch('coverage not set up')
  await clock.advance(100)
  await publish($)
  expect((await drawing.find({ type: 'Text', text: 'SPLIT' }))?.text).toBe('$1.23 · CC 6 SPLIT 1 · tests none stale')
})

test('off returns the drawing beneath even with a SPLIT report', async ($, on) => {
  world(on, false)
  await publish($)
  expect(await (await mount($)).drawn()).toMatchObject(BELOW)
})

test('hasSurvey yields the drawing beneath even with a SPLIT report', async ($, on) => {
  world(on)
  await publish($)
  expect(await (await mount($, { ...PROPS, hasSurvey: true })).drawn()).toMatchObject(BELOW)
})

test('only session cwd is shown and high legacy complexity does not request SPLIT', async ($, on) => {
  const { measurement } = world(on)
  await publish($, '/work/child')
  const drawing = await mount($)
  expect(await drawing.drawn()).toMatchObject(BELOW)
  measurement.report = { ...REPORT, unverified: false, bodies: [{ ...REPORT.bodies[0], cc: 20, state: 'legacy-unchanged' }] }
  await publish($)
  expect((await drawing.find({ type: 'Text', text: 'CC 20' }))?.text).toBe('$1.23 · CC 20 ok · tests none stale')
})
