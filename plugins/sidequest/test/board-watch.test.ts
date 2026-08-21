import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const { createPulse, createBoardWatch, createGitHubCiRunsProvider } = require('../lib/store/pulse');
const { createProjectBoardWatch } = require('../lib/store/project-watch');
const store = require('../lib/store');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

function watch(polls: unknown[], watchingAuthor = 'orchestrator', ciPolls: unknown[] = [], watchingSession = '', board = 'board-a', includeAllTickets = false) {
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
    includeAllTickets,
    watchingAuthor,
    watchingSession,
    writeLine: (line: string) => lines.push(line),
    writeError: (line: string) => errors.push(line),
  });
  return { boardWatch, lines, errors };
}

function dispatchPreparedBy(sessionId: string, terminalAt: string | null = null) {
  return { preparedBy: { sessionId }, terminalAt };
}

function ciProvider(remoteHead: string, runs: Record<string, unknown>[]) {
  return createGitHubCiRunsProvider('/project', (_program: string, arguments_: string[]) => {
    const command = arguments_.join(' ');
    if (command === 'rev-parse --abbrev-ref --symbolic-full-name @{u}') return 'origin/main';
    if (command === 'remote get-url origin') return 'git@github.com:eigenwise/toolshed.git';
    if (command === 'auth status') return '';
    if (command === 'ls-remote origin refs/heads/main') return `${remoteHead}\trefs/heads/main`;
    if (command === 'run list --branch main --limit 100 --json databaseId,headSha,status,conclusion,name') return JSON.stringify(runs);
    throw new Error(`unexpected CI command: ${command}`);
  });
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

test('changes projects dispatch preparation ownership for watch filtering', () => {
  const updatedAt = '2026-08-13T00:00:01.000Z';
  const ownedTicket = {
    ref: 'SQ-owned',
    title: 'Owned ticket',
    status: 'doing',
    updatedAt,
    comments: [],
    dispatch: { preparedBy: { sessionId: 'orchestrator-session', surface: 'mcp' }, terminalAt: null },
  };
  const unownedTicket = {
    ref: 'SQ-unowned',
    title: 'Unowned ticket',
    status: 'todo',
    updatedAt,
    comments: [],
  };
  const pulse = createPulse({
    checkpointProjection: () => null,
    claimPulse: () => null,
    dispatchState: (sourceTicket: any) => sourceTicket.dispatch || null,
    listTickets: () => [ownedTicket, unownedTicket],
    oracleProjection: () => null,
    storyContractDriftWarnings: () => [],
    storyDecisionLogWarnings: () => [],
  });

  const changes = pulse.changesPayload('board-a', new Date(0).toISOString());

  assert.deepEqual(changes.tickets.find((changedTicket: any) => changedTicket.ref === 'SQ-owned').dispatch, {
    preparedBy: { sessionId: 'orchestrator-session' },
    terminalAt: null,
  });
  assert.equal(Object.hasOwn(changes.tickets.find((changedTicket: any) => changedTicket.ref === 'SQ-unowned'), 'dispatch'), false);
});

test('watch suppresses an actionable event owned by another active session', () => {
  const ownedElsewhere = ticket({
    status: 'awaiting-oracle',
    dispatch: dispatchPreparedBy('session-2'),
  });
  const { boardWatch, lines } = watch([
    { serverTime: '2026-08-13T00:00:01.000Z', tickets: [ownedElsewhere] },
  ], 'orchestrator', [], 'session-1');

  boardWatch.poll();

  assert.deepEqual(lines, []);
});

test('watch emits an actionable event owned by the watching session', () => {
  const ownedHere = ticket({
    status: 'awaiting-oracle',
    dispatch: dispatchPreparedBy('session-1'),
  });
  const { boardWatch, lines } = watch([
    { serverTime: '2026-08-13T00:00:01.000Z', tickets: [ownedHere] },
  ], 'orchestrator', [], 'session-1');

  boardWatch.poll();

  assert.deepEqual(lines, ['SQ-1 awaiting-oracle awaiting-oracle - -']);
});

test('watch emits tickets without a dispatch or attributed owner', () => {
  const noDispatch = ticket({ ref: 'SQ-no-dispatch', status: 'awaiting-oracle' });
  const noOwner = ticket({
    ref: 'SQ-no-owner',
    status: 'awaiting-oracle',
    dispatch: dispatchPreparedBy(''),
  });
  const { boardWatch, lines } = watch([
    { serverTime: '2026-08-13T00:00:01.000Z', tickets: [noDispatch, noOwner] },
  ], 'orchestrator', [], 'session-1');

  boardWatch.poll();

  assert.deepEqual(lines, [
    'SQ-no-dispatch awaiting-oracle awaiting-oracle - -',
    'SQ-no-owner awaiting-oracle awaiting-oracle - -',
  ]);
});

test('watch without a session emits events owned by every session', () => {
  const ownedElsewhere = ticket({
    status: 'awaiting-oracle',
    dispatch: dispatchPreparedBy('session-2'),
  });
  const { boardWatch, lines } = watch([
    { serverTime: '2026-08-13T00:00:01.000Z', tickets: [ownedElsewhere] },
  ]);

  boardWatch.poll();

  assert.deepEqual(lines, ['SQ-1 awaiting-oracle awaiting-oracle - -']);
});

test('watch all emits events owned by another active session', () => {
  const ownedElsewhere = ticket({
    status: 'awaiting-oracle',
    dispatch: dispatchPreparedBy('session-2'),
  });
  const { boardWatch, lines } = watch([
    { serverTime: '2026-08-13T00:00:01.000Z', tickets: [ownedElsewhere] },
  ], 'orchestrator', [], 'session-1', 'board-a', true);

  boardWatch.poll();

  assert.deepEqual(lines, ['SQ-1 awaiting-oracle awaiting-oracle - -']);
});

test('watch emits terminal events prepared by a previous session after restart', () => {
  const terminalDispatch = ticket({
    lastEventType: 'release',
    dispatch: dispatchPreparedBy('previous-session', '2026-08-13T00:00:00.000Z'),
  });
  const { boardWatch, lines } = watch([
    { serverTime: '2026-08-13T00:00:01.000Z', tickets: [terminalDispatch] },
  ], 'orchestrator', [], 'replacement-session');

  boardWatch.poll();

  assert.deepEqual(lines, ['SQ-1 doing release - -']);
});

test('watch emits shared CI failures while suppressing another session ticket', () => {
  const ownedElsewhere = ticket({
    status: 'awaiting-oracle',
    dispatch: dispatchPreparedBy('session-2'),
  });
  const ci = {
    headSha: 'shared-failure',
    lastGreenHeadSha: 'previous-green',
    hasCompletedGreenRun: false,
    runs: [{ id: 42, headSha: 'shared-failure', status: 'completed', conclusion: 'failure', workflowName: 'Test', failingJobCount: 1 }],
  };
  const { boardWatch, lines } = watch([
    { serverTime: '2026-08-13T00:00:01.000Z', tickets: [ownedElsewhere] },
  ], 'orchestrator', [ci], 'session-1');

  boardWatch.poll();

  assert.deepEqual(lines, [
    'CI shared-failure failed Test 1',
    'CI shared-failure unchecked - -',
  ]);
});

test('watch help names the project-wide all fallback', () => {
  const cli = path.join(__dirname, '..', 'bin', 'sidequest.js');
  for (const arguments_ of [['watch', '--help'], ['--help']]) {
    const result = spawnSync(process.execPath, [cli, ...arguments_], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--all/);
    assert.match(result.stdout, /every ticket|project-wide ticket/i);
  }

  const accepted = spawnSync(process.execPath, [cli, 'watch', '--all'], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(accepted.status, 0);
  assert.match(accepted.stderr, /watch: --project must name the board root or registered board identity/i);
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

test('watch ignores self-originated blocker comments and unknown origins', () => {
  const ownRoutine = ticket({ lastComment: { id: 'own', by: 'orchestrator-other', body: 'Blocked on a scope request.', sourceSession: 'session-1', actor: 'orchestrator-other', operation: 'comment' } });
  const unknownOrigin = ticket({ lastComment: { id: 'unknown', by: 'orchestrator', body: 'Blocked on a scope request.' } });
  const { boardWatch, lines } = watch([
    { serverTime: '2026-08-13T00:00:01.000Z', tickets: [ownRoutine] },
    { serverTime: '2026-08-13T00:00:02.000Z', tickets: [unknownOrigin] },
  ], 'orchestrator', [], 'session-1');

  boardWatch.poll();
  boardWatch.poll();

  assert.deepEqual(lines, [
    'SQ-1 doing comment orchestrator Blocked on a scope request.',
  ]);
});

test('watch emits blocker comments from another session', () => {
  const otherBlocker = ticket({ lastComment: { id: 'other', by: 'orchestrator-other', body: 'Blocked on a scope request.', sourceSession: 'session-2', actor: 'orchestrator-other', operation: 'comment' } });
  const { boardWatch, lines } = watch([
    { serverTime: '2026-08-13T00:00:01.000Z', tickets: [otherBlocker] },
  ], 'orchestrator', [], 'session-1');

  boardWatch.poll();

  assert.deepEqual(lines, ['SQ-1 doing comment orchestrator-other Blocked on a scope request.']);
});

test('project watch suppresses its own MCP comment regardless of actor identity', () => {
  const project = store.ensureProject(fs.mkdtempSync(path.join(os.tmpdir(), 'sq-board-watch-')));
  const createdTicket = store.createTicket(project.slug, { title: 'Watch attribution' });
  const lines: string[] = [];
  const changesPayload = (slug: string, since: string) => store.changesPayload(slug, since);
  const watchingBoard = createProjectBoardWatch(project, {
    CLAUDE_CODE_SESSION_ID: 'watch-session',
  }, {
    store: { changesPayload },
    createBoardWatch: (dependencies: any) => createBoardWatch({
      ...dependencies,
      writeLine: (line: string) => lines.push(line),
    }),
    createGitHubCiRunsProvider: () => null,
  });

  store.addComment(project.slug, createdTicket.ref, {
    by: 'orchestrator-remote-name',
    body: 'Blocked on a scope request.',
    kind: 'comment',
    source: 'mcp',
    sourceSession: 'watch-session',
    actor: 'orchestrator-remote-name',
    operation: 'comment',
  });
  watchingBoard.poll();
  assert.deepEqual(lines, []);

  store.addComment(project.slug, createdTicket.ref, {
    by: 'executor',
    body: 'Blocked on a scope request.',
    kind: 'comment',
    source: 'mcp',
    sourceSession: 'other-session',
    actor: 'executor',
    operation: 'comment',
  });
  watchingBoard.poll();

  assert.deepEqual(lines, [`${createdTicket.ref} ${createdTicket.status} comment executor Blocked on a scope request.`]);
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

test('provider keeps an origin main success green when a local release branch is ahead', () => {
  const headSha = '528ce317a5e587571047a14482952104a1d16169';
  const provider = ciProvider(headSha, [
    { databaseId: 1, headSha, status: 'completed', conclusion: 'success', name: 'Test' },
    { databaseId: 2, headSha, status: 'completed', conclusion: 'success', name: 'Release guard' },
    { databaseId: 3, headSha, status: 'completed', conclusion: 'success', name: 'Deploy docs' },
    { databaseId: 4, headSha, status: 'completed', conclusion: 'success', name: 'Daily GitHub Release' },
  ]);

  assert.ok(provider);
  const ci = provider();
  assert.equal(ci?.headSha, headSha);
  assert.equal(ci?.hasCompletedGreenRun, true);
  assert.equal(ci?.runs.length, 4);

  const { boardWatch, lines } = watch([
    { serverTime: '2026-08-13T00:00:01.000Z', tickets: [] },
    { serverTime: '2026-08-13T00:00:02.000Z', tickets: [] },
  ], 'orchestrator', [ci, ci]);
  boardWatch.poll();
  boardWatch.poll();

  assert.deepEqual(lines, []);
});

test('watch reports a genuinely unchecked new CI head', () => {
  const headSha = 'new-head';
  const ci = { headSha, lastGreenHeadSha: 'previous-green', hasCompletedGreenRun: false, runs: [] };
  const { boardWatch, lines } = watch([{ serverTime: '2026-08-13T00:00:01.000Z', tickets: [] }], 'orchestrator', [ci]);

  boardWatch.poll();

  assert.deepEqual(lines, ['CI new-head unchecked - -']);
});

test('watch reports a pending CI check as unchecked', () => {
  const ci = {
    headSha: 'pending-head',
    lastGreenHeadSha: 'previous-green',
    hasCompletedGreenRun: false,
    runs: [{ id: 8, headSha: 'pending-head', status: 'in_progress', conclusion: null, workflowName: 'Test', failingJobCount: 0 }],
  };
  const { boardWatch, lines } = watch([{ serverTime: '2026-08-13T00:00:01.000Z', tickets: [] }], 'orchestrator', [ci]);

  boardWatch.poll();

  assert.deepEqual(lines, ['CI pending-head unchecked - -']);
});

test('watch reports a cancelled CI check as unchecked', () => {
  const ci = {
    headSha: 'cancelled-head',
    lastGreenHeadSha: 'previous-green',
    hasCompletedGreenRun: false,
    runs: [{ id: 9, headSha: 'cancelled-head', status: 'completed', conclusion: 'cancelled', workflowName: 'Test', failingJobCount: 0 }],
  };
  const { boardWatch, lines } = watch([{ serverTime: '2026-08-13T00:00:01.000Z', tickets: [] }], 'orchestrator', [ci]);

  boardWatch.poll();

  assert.deepEqual(lines, ['CI cancelled-head failed Test 0', 'CI cancelled-head unchecked - -']);
});

test('watch quiets an already-reported failure once its head turns green', () => {
  const failed = {
    headSha: 'recovered-head',
    lastGreenHeadSha: 'previous-green',
    hasCompletedGreenRun: false,
    runs: [{ id: 10, headSha: 'recovered-head', status: 'completed', conclusion: 'failure', workflowName: 'Test', failingJobCount: 1 }],
  };
  const green = {
    headSha: 'recovered-head',
    lastGreenHeadSha: 'recovered-head',
    hasCompletedGreenRun: true,
    runs: [{ id: 11, headSha: 'recovered-head', status: 'completed', conclusion: 'success', workflowName: 'Test', failingJobCount: 0 }],
  };
  const { boardWatch, lines } = watch([
    { serverTime: '2026-08-13T00:00:01.000Z', tickets: [] },
    { serverTime: '2026-08-13T00:00:02.000Z', tickets: [] },
  ], 'orchestrator', [failed, green]);

  boardWatch.poll();
  boardWatch.poll();

  assert.deepEqual(lines, ['CI recovered-head failed Test 1', 'CI recovered-head unchecked - -']);
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
