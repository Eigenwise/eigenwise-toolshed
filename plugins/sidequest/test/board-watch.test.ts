import test from 'node:test';
import assert from 'node:assert/strict';

const { createBoardWatch } = require('../lib/store/pulse');

function ticket(overrides: Record<string, unknown> = {}) {
  return {
    ref: 'SQ-1',
    status: 'doing',
    liveness: 'unknown',
    lastEventType: 'comment',
    lastComment: null,
    ...overrides,
  };
}

function watch(polls: unknown[], watchingAuthor = 'orchestrator', ciPolls: unknown[] = []) {
  const lines: string[] = [];
  const errors: string[] = [];
  const boardWatch = createBoardWatch({
    changesPayload: () => {
      const next = polls.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    ciRunsProvider: ciPolls.length ? () => ciPolls.shift() : undefined,
    watchingAuthor,
    writeLine: (line: string) => lines.push(line),
    writeError: (line: string) => errors.push(line),
  });
  return { boardWatch, lines, errors };
}

test('watch emits an out-of-scope comment once across repeated polls', () => {
  const changed = ticket({ lastComment: { id: 'c_1', by: 'executor', body: 'I need to widen scope for the generated pair.' } });
  const { boardWatch, lines } = watch([
    { serverTime: '2026-08-13T00:00:01.000Z', tickets: [changed] },
    { serverTime: '2026-08-13T00:00:02.000Z', tickets: [changed] },
  ]);

  boardWatch.poll();
  boardWatch.poll();

  assert.deepEqual(lines, ['SQ-1 doing comment executor I need to widen scope for the generated pair.']);
});

test('watch ignores marker and orchestrator-authored comments', () => {
  const { boardWatch, lines } = watch([
    { serverTime: '2026-08-13T00:00:01.000Z', tickets: [ticket({ lastComment: { id: 'marker', by: 'executor', body: '[sidequest:verify-start] scope request' } })] },
    { serverTime: '2026-08-13T00:00:02.000Z', tickets: [ticket({ lastComment: { id: 'own', by: 'orchestrator', body: 'Blocked on a scope request.' } })] },
  ]);

  boardWatch.poll();
  boardWatch.poll();

  assert.deepEqual(lines, []);
});

test('watch emits an awaiting-oracle status flip', () => {
  const { boardWatch, lines } = watch([
    { serverTime: '2026-08-13T00:00:01.000Z', tickets: [ticket({ status: 'awaiting-oracle' })] },
  ]);

  boardWatch.poll();

  assert.deepEqual(lines, ['SQ-1 awaiting-oracle awaiting-oracle - -']);
});

test('watch emits a red GitHub run once across polls', () => {
  const ci = {
    headSha: 'abcdef',
    lastGreenHeadSha: '123456',
    hasCompletedGreenRun: false,
    runs: [{ id: 42, headSha: 'abcdef', status: 'completed', conclusion: 'failure', workflowName: 'test', failingJobCount: 2 }],
  };
  const { boardWatch, lines } = watch([{ serverTime: '2026-08-13T00:00:01.000Z', tickets: [] }, { serverTime: '2026-08-13T00:00:02.000Z', tickets: [] }], 'orchestrator', [ci, ci]);

  boardWatch.poll();
  boardWatch.poll();

  assert.deepEqual(lines, ['CI abcdef failed test 2', 'CI abcdef unchecked - -']);
});

test('watch ignores green GitHub runs and unavailable providers', () => {
  const green = { headSha: 'abcdef', lastGreenHeadSha: 'abcdef', hasCompletedGreenRun: true, runs: [{ id: 42, headSha: 'abcdef', status: 'completed', conclusion: 'success', workflowName: 'test', failingJobCount: 0 }] };
  const withCi = watch([{ serverTime: '2026-08-13T00:00:01.000Z', tickets: [] }], 'orchestrator', [green]);
  const withoutCi = watch([{ serverTime: '2026-08-13T00:00:01.000Z', tickets: [ticket({ status: 'awaiting-oracle' })] }]);

  withCi.boardWatch.poll();
  withoutCi.boardWatch.poll();

  assert.deepEqual(withCi.lines, []);
  assert.deepEqual(withoutCi.lines, ['SQ-1 awaiting-oracle awaiting-oracle - -']);
});

test('watch reports poll failures and keeps polling', () => {
  const { boardWatch, lines, errors } = watch([
    new Error('database busy'),
    { serverTime: '2026-08-13T00:00:02.000Z', tickets: [ticket({ liveness: 'dead', livenessEvidence: 'executor died' })] },
  ]);

  boardWatch.poll();
  boardWatch.poll();

  assert.deepEqual(errors, ['sidequest watch: database busy']);
  assert.deepEqual(lines, ['SQ-1 doing dead - executor died']);
});
