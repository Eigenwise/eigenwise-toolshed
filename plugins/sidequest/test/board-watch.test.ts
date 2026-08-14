import test from 'node:test';
import assert from 'node:assert/strict';

const { createBoardWatch } = require('../lib/store/pulse');
const { createProjectBoardWatch } = require('../lib/store/project-watch');

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

function watch(polls: unknown[], watchingAuthor = 'orchestrator', ciPolls: unknown[] = [], watchingSession = '', board = 'board-a') {
  const lines: string[] = [];
  const errors: string[] = [];
  const boardWatch = createBoardWatch({
    board,
    changesPayload: (requestedBoard: string) => {
      assert.equal(requestedBoard, board, 'a watch must read only its registered board identity');
      const next = polls.shift();
      if (next instanceof Error) throw next;
      return { project: board, ...(next as object) };
    },
    ciRunsProvider: ciPolls.length ? () => ciPolls.shift() : undefined,
    watchingAuthor,
    watchingSession,
    writeLine: (line: string) => lines.push(line),
    writeError: (line: string) => errors.push(line),
  });
  return { boardWatch, lines, errors };
}

test('project watch consumes only its board changes', () => {
  const firstPolls: unknown[] = [];
  const secondPolls: unknown[] = [];
  const first = createProjectBoardWatch({ slug: 'project-a', meta: { path: '/project-a' } }, {
    CLAUDE_CODE_SESSION_ID: 'session-a',
    SIDEQUEST_AGENT: 'orchestrator-a',
  }, {
    store: { changesPayload: (slug: string, since: string) => { firstPolls.push([slug, since]); return { serverTime: '2026-08-13T00:00:01.000Z', tickets: [] }; } },
    createBoardWatch,
    createGitHubCiRunsProvider: () => null,
  });
  const second = createProjectBoardWatch({ slug: 'project-b', meta: { path: '/project-b' } }, {
    CLAUDE_CODE_SESSION_ID: 'session-b',
    SIDEQUEST_AGENT: 'orchestrator-b',
  }, {
    store: { changesPayload: (slug: string, since: string) => { secondPolls.push([slug, since]); return { serverTime: '2026-08-13T00:00:01.000Z', tickets: [] }; } },
    createBoardWatch,
    createGitHubCiRunsProvider: () => null,
  });

  first.poll();
  second.poll();

  assert.deepEqual(firstPolls.map((entry: any) => entry[0]), ['project-a']);
  assert.deepEqual(secondPolls.map((entry: any) => entry[0]), ['project-b']);
});

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

test('watch emits an unchanged warning once after an unrelated ticket change', () => {
  const warning = 'Dispatch warning: US-54 decision log gained 1 entry (#14) since SQ-1970 was claimed; it is not in its briefing.';
  const { boardWatch, lines } = watch([
    { serverTime: '2026-08-13T00:00:01.000Z', tickets: [ticket({ warnings: [warning] })] },
    { serverTime: '2026-08-13T00:00:02.000Z', tickets: [ticket({ warnings: [warning], lastComment: { id: 'unrelated-comment', by: 'executor', body: 'Finished a separate task.' } })] },
  ]);

  boardWatch.poll();
  boardWatch.poll();

  assert.deepEqual(lines, [`SQ-1 doing warning - ${warning}`]);
});

test('watch re-emits a materially changed warning', () => {
  const originalWarning = 'Dispatch warning: US-54 decision log gained 1 entry (#14) since SQ-1970 was claimed; it is not in its briefing.';
  const changedWarning = 'Dispatch warning: US-54 decision log gained 2 entries (#14-#15) since SQ-1970 was claimed; they are not in its briefing.';
  const { boardWatch, lines } = watch([
    { serverTime: '2026-08-13T00:00:01.000Z', tickets: [ticket({ warnings: [originalWarning] })] },
    { serverTime: '2026-08-13T00:00:02.000Z', tickets: [ticket({ warnings: [changedWarning] })] },
  ]);

  boardWatch.poll();
  boardWatch.poll();

  assert.deepEqual(lines, [
    `SQ-1 doing warning - ${originalWarning}`,
    `SQ-1 doing warning - ${changedWarning}`,
  ]);
});

test('watch ignores marker comments', () => {
  const { boardWatch, lines } = watch([
    { serverTime: '2026-08-13T00:00:01.000Z', tickets: [ticket({ lastComment: { id: 'marker', by: 'executor', body: '[sidequest:verify-start] scope request' } })] },
  ]);

  boardWatch.poll();

  assert.deepEqual(lines, []);
});

test('watch ignores a benign same-session comment', () => {
  const ownComment = ticket({
    lastComment: {
      id: 'own-routine',
      by: 'orchestrator',
      body: 'Recorded the immutable review evidence.',
      sourceSession: 'session-1',
      actor: 'orchestrator',
      operation: 'comment',
    },
  });
  const { boardWatch, lines } = watch([
    { serverTime: '2026-08-13T00:00:01.000Z', tickets: [ownComment] },
  ], 'orchestrator', [], 'session-1');

  boardWatch.poll();

  assert.deepEqual(lines, []);
});

test('watch emits self-originated blocker comments and unknown origins', () => {
  const ownRoutine = ticket({ lastComment: { id: 'own', by: 'orchestrator', body: 'Blocked on a scope request.', sourceSession: 'session-1', actor: 'orchestrator', operation: 'comment' } });
  const unknownOrigin = ticket({ lastComment: { id: 'unknown', by: 'orchestrator', body: 'Blocked on a scope request.' } });
  const { boardWatch, lines } = watch([
    { serverTime: '2026-08-13T00:00:01.000Z', tickets: [ownRoutine] },
    { serverTime: '2026-08-13T00:00:02.000Z', tickets: [unknownOrigin] },
  ], 'orchestrator', [], 'session-1');

  boardWatch.poll();
  boardWatch.poll();

  assert.deepEqual(lines, [
    'SQ-1 doing comment orchestrator Blocked on a scope request.',
    'SQ-1 doing comment orchestrator Blocked on a scope request.',
  ]);
});

test('watch emits actionable self-originated blocker comments', () => {
  const ownBlocker = ticket({ lastComment: { id: 'blocker', by: 'orchestrator', body: 'Blocked on a scope request.', sourceSession: 'session-1', actor: 'orchestrator', operation: 'comment' } });
  const { boardWatch, lines } = watch([
    { serverTime: '2026-08-13T00:00:01.000Z', tickets: [ownBlocker] },
  ], 'orchestrator', [], 'session-1');

  boardWatch.poll();

  assert.deepEqual(lines, ['SQ-1 doing comment orchestrator Blocked on a scope request.']);
});

test('watch emits actionable self-originated release events', () => {
  const { boardWatch, lines } = watch([
    { serverTime: '2026-08-13T00:00:01.000Z', tickets: [ticket({ lastEventType: 'release', lastComment: { id: 'own', by: 'orchestrator', body: 'Released.', sourceSession: 'session-1', actor: 'orchestrator', operation: 'comment' } })] },
  ], 'orchestrator', [], 'session-1');

  boardWatch.poll();

  assert.deepEqual(lines, ['SQ-1 doing release - -']);
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

test('two board watches emit only their own actionable events', () => {
  const routine = ticket({ ref: 'SQ-A-routine', lastComment: { id: 'a-routine', by: 'executor', body: '[sidequest:verify-complete] passed: normal work.' } });
  const actionA = ticket({ ref: 'SQ-A-action', lastComment: { id: 'a-action', by: 'executor', body: 'Blocked on a scope request.' } });
  const actionB = ticket({ ref: 'SQ-B-action', status: 'awaiting-oracle' });
  const boardA = watch([{ serverTime: '2026-08-13T00:00:01.000Z', tickets: [routine, actionA] }], 'orchestrator', [], '', 'project-a-canonical');
  const boardB = watch([{ serverTime: '2026-08-13T00:00:01.000Z', tickets: [actionB] }], 'orchestrator', [], '', 'project-b-canonical');

  boardA.boardWatch.poll();
  boardB.boardWatch.poll();

  assert.deepEqual(boardA.lines, ['SQ-A-action doing comment executor Blocked on a scope request.']);
  assert.deepEqual(boardB.lines, ['SQ-B-action awaiting-oracle awaiting-oracle - -']);
});

test('watch rejects missing identity and cross-board payloads', () => {
  assert.throws(() => createBoardWatch({ changesPayload: () => ({ project: 'project-a', tickets: [] }) }), /explicit board identity/);
  const lines: string[] = [];
  const errors: string[] = [];
  const boardWatch = createBoardWatch({
    board: 'project-a',
    changesPayload: () => ({ project: 'project-b', serverTime: '2026-08-13T00:00:01.000Z', tickets: [ticket({ status: 'awaiting-oracle' })] }),
    writeLine: (line: string) => lines.push(line),
    writeError: (line: string) => errors.push(line),
  });

  boardWatch.poll();

  assert.deepEqual(lines, []);
  assert.deepEqual(errors, ['sidequest watch: watch received changes for a different board identity.']);
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
