import { expect, test } from 'claude-code/testing'

import { isReturnedNotRecorded, readResultFields, recordedByBoard } from './agent-returns'
import { namesANeed, readFinishOutcome, readOutcome } from './run-outcome'
import { newTicket } from './tickets'

const STAMP = '2026-11-16T10:02Z'

// The exact last-message shapes agents/worker.md and agents/scout.md ask for, filled in.
const WORKER_ANSWER = [
  '- `result`: Uploads retry three times.',
  '- `checked`: `npm test` exit 0',
  '- `uncertain`: did not try a real flaky network',
  '- `needs`: nothing',
  '- `branch`: sq-1',
  '- `commits`: 2',
  '- `changedFiles`: src/upload.ts, src/upload.test.ts',
].join('\n')

const SCOUT_ANSWER = [
  '- `result`: The retry delay is set in upload.ts.',
  '- `checked`: `rg retryDelay` exit 0',
  '- `uncertain`: did not run the uploader',
  '- `needs`: nothing',
  '- `branch`, `commits`, `changedFiles`: leave empty; you write no code.',
].join('\n')

test('the worker and scout contract shapes read field by field, and a line naming several fields fills each', () => {
  expect(readResultFields(WORKER_ANSWER)).toEqual({
    result: 'Uploads retry three times.',
    checked: '`npm test` exit 0',
    uncertain: 'did not try a real flaky network',
    needs: 'nothing',
    branch: 'sq-1',
    commits: '2',
    changedFiles: 'src/upload.ts, src/upload.test.ts',
  })
  expect(readResultFields(SCOUT_ANSWER)).toEqual({
    result: 'The retry delay is set in upload.ts.',
    checked: '`rg retryDelay` exit 0',
    uncertain: 'did not run the uploader',
    needs: 'nothing',
    branch: 'leave empty; you write no code.',
    commits: 'leave empty; you write no code.',
    changedFiles: 'leave empty; you write no code.',
  })
})

test('bold names, a table, another order and a multi-line value are read too', () => {
  const bold = '**Result**: Uploads retry.\n**needs:** nothing\n**Checked** npm test exit 0\n\nThanks!'
  const table = '| Field | Value |\n| --- | --- |\n| result | Uploads retry. |\n| `needs` | Pick a backoff. |\n| checked | not checked |'
  const reordered = 'needs: nothing\nchecked: npm test exit 0\nresult: Uploads retry.'
  const multiLine = '- `result`: Uploads retry\n  three times.\n- `changedFiles`:\n  - a.ts\n  - b.ts\n\nLet me know.'
  const headings = '## Result\nUploads retry.\n\n## Notes\nnot a field'
  const json = '{\n  "result": "Uploads retry.",\n  "commits": 2\n}'

  expect(readResultFields(bold)).toEqual({ result: 'Uploads retry.', needs: 'nothing', checked: 'npm test exit 0' })
  expect(readResultFields(table)).toEqual({ result: 'Uploads retry.', needs: 'Pick a backoff.', checked: 'not checked' })
  expect(readResultFields(reordered)).toEqual({ needs: 'nothing', checked: 'npm test exit 0', result: 'Uploads retry.' })
  expect(readResultFields(multiLine)).toEqual({ result: 'Uploads retry three times.', changedFiles: 'a.ts, b.ts' })
  expect(readResultFields(headings)).toEqual({ result: 'Uploads retry.' })
  expect(readResultFields(json)).toEqual({ result: 'Uploads retry.', commits: '2' })
})

test('an answer with no fields is the result, cut to a sane length, and an empty answer has nothing', () => {
  const long = 'word '.repeat(200)

  expect(readResultFields('It works now.')).toEqual({ result: 'It works now.' })
  expect(readResultFields(long).result?.length).toBe(400)
  expect(readResultFields('')).toEqual({})
})

test('a need is read the same way by finish and by the board, and the usual ways of saying none are none', () => {
  const noNeeds = ['nothing', 'Nothing needed.', 'Nothing, all done', 'none', 'n/a', '-', 'No', '', 'not recorded']

  expect(noNeeds.filter(namesANeed)).toEqual([])
  expect(namesANeed('Notify the team first.')).toBe(true)
  expect(readOutcome('done', 'Pick one.')).toBe('done')
  expect(readOutcome('Failure', undefined)).toBe('failed')
  expect(readOutcome('blocked, needs the human', undefined)).toBe('needs-you')
  expect(readOutcome('blocked', 'nothing')).toBe('needs-you')
  expect(readOutcome('waiting on a decision', undefined)).toBe('needs-you')
  expect(readOutcome(undefined, 'Pick one.')).toBe('needs-you')
  expect(readOutcome('success', 'nothing needed')).toBe('done')
})

test('a finish with no outcome and no result is a run that returned nothing, so it is failed and never done', () => {
  expect(readFinishOutcome({})).toBe('failed')
  expect(readFinishOutcome({ needs: 'nothing' })).toBe('failed')
  expect(readFinishOutcome({ result: 'Uploads retry.' })).toBe('done')
  expect(readFinishOutcome({ outcome: 'done' })).toBe('done')
})

test('a return is unrecorded only on a doing ticket with no finish after it, and a failed run lands in needs-you', () => {
  const doing = { ...newTicket('SQ-1', { title: 'Retry', kind: 'research' }, STAMP), status: 'doing' }
  const withLog = (log: string[]) => ({ ...doing, log: log.map(line => `${STAMP} ${line}`) })
  const returned = withLog(['started scout opus/high', 'returned build run after 3m', 'needs nothing'])
  const failed = withLog(['started scout opus/high', 'returned build run, on an error after 3m', 'needs nothing'])

  expect(isReturnedNotRecorded(returned)).toBe(true)
  expect(isReturnedNotRecorded(withLog(['started scout opus/high', 'returned build run after 3m', 'finished done']))).toBe(false)
  expect(isReturnedNotRecorded(withLog(['returned build run after 3m', 'started scout opus/high']))).toBe(false)
  expect(isReturnedNotRecorded({ ...returned, status: 'done' })).toBe(false)
  expect(recordedByBoard(returned, STAMP).ticket.status).toBe('done')
  expect(isReturnedNotRecorded(failed)).toBe(true)
  expect(recordedByBoard(failed, STAMP).outcome).toBe('failed')
  expect(recordedByBoard(failed, STAMP).ticket.status).toBe('needs-you')
  expect(recordedByBoard(failed, STAMP).ticket.log.at(-1)).toBe(`${STAMP} finished failed, recorded by the board because finish was not called`)
})

test('an interrupted run is not a return to record: its ticket stays doing with the line that says it was cut off', () => {
  const doing = { ...newTicket('SQ-1', { title: 'Retry' }, STAMP), status: 'doing' }
  const interrupted = { ...doing, log: ['started worker sonnet/medium', 'returned build run, interrupted after 3m', 'needs nothing'].map(line => `${STAMP} ${line}`) }

  expect(isReturnedNotRecorded(interrupted)).toBe(false)
  expect(interrupted.log[1]).toBe(`${STAMP} returned build run, interrupted after 3m`)
})

test('a needs the board could not find is read as none, and the line says so', () => {
  const doing = { ...newTicket('SQ-1', { title: 'Retry', kind: 'research' }, STAMP), status: 'doing' }
  const proseOnly = { ...doing, log: ['started scout opus/high', 'returned build run after 3m', 'result It works.', 'needs not recorded'].map(line => `${STAMP} ${line}`) }

  expect(recordedByBoard(proseOnly, STAMP).ticket.log.at(-1)).toBe(
    `${STAMP} finished done, recorded by the board because finish was not called; needs not recorded, read as none`,
  )
})

test('the repair reads the return of the ticket own category of work, never a review run after it', () => {
  const doing = { ...newTicket('SQ-1', { title: 'Retry' }, STAMP), status: 'doing' }
  const withLog = (log: string[]) => ({ ...doing, log: log.map(line => `${STAMP} ${line}`) })
  const worker = ['started worker sonnet/medium', 'returned build run after 9m', 'needs nothing']
  const reviewer = ['returned review run after 3m', 'needs Decide whether the retry cap is right.']
  const fallback = { ...doing, category: 'misc' }
  const fallbackStart = 'started worker sonnet/medium. category "misc" has no route on this board, so it runs as build. delivery "main"'

  expect(recordedByBoard(withLog([...worker, ...reviewer]), STAMP).ticket.status).toBe('review')
  expect(isReturnedNotRecorded(withLog(['started worker sonnet/medium', ...reviewer]))).toBe(false)
  expect(isReturnedNotRecorded({ ...fallback, log: [fallbackStart, ...worker.slice(1)].map(line => `${STAMP} ${line}`) })).toBe(true)
})
