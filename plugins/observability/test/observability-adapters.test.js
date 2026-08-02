'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { normalizeObservation } = require('../lib/observability/ingest.js');
const {
  captureSidequestChanges,
  ticketObservation,
} = require('../lib/observability/adapters/sidequest.js');
const {
  captureCodexRouteLog,
  routeObservation,
  temporalRouteLink,
} = require('../lib/observability/adapters/codex-gateway.js');

const PROJECT_ID = 'a'.repeat(64);

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-adapters-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function route(overrides = {}) {
  return {
    at: '2026-07-19T01:02:03.000Z',
    backend: 'codex',
    model: 'gpt-5.6-sol',
    path: '/v1/messages?private=query',
    via: 'dispatch-cached',
    effort: 'medium',
    sessionId: 'session-1',
    prompt: 'never capture this',
    headers: { authorization: 'Bearer secret' },
    ...overrides,
  };
}

test('Sidequest changes emit only allowlisted lifecycle metadata and persist serverTime', async (t) => {
  const directory = temporaryDirectory(t);
  const cursorPath = path.join(directory, 'sidequest.cursor.json');
  const observations = [];
  const sinceValues = [];
  const responses = [
    {
      serverTime: '2026-07-19T01:00:01.000Z',
      tickets: [{
        ref: 'SQ-478',
        title: 'private task title',
        description: 'private description',
        comments: ['private comment'],
        prompt: 'private prompt',
        attachments: ['secret.png'],
        dispatchToken: 'dispatch-secret',
        story: 'US-12',
        categoryId: 'coding.normal',
        configuredModel: 'codex-gpt-5-6-sol',
        configuredEffort: 'medium',
        configuredBackend: 'codex',
        resolvedModel: 'codex-gpt-5-6-sol',
        resolvedEffort: 'medium',
        resolvedBackend: 'codex',
        resolvedExecutor: 'sidequest-exec-dispatch-medium',
        dispatchId: 'dispatch-478',
        taskId: 'task-478',
        claim: { by: 'worker-478', sessionId: 'session-478', token: 'claim-secret' },
        status: 'doing',
        updatedAt: '2026-07-19T01:00:00.000Z',
      }],
    },
    { serverTime: '2026-07-19T01:00:02.000Z', tickets: [] },
  ];
  const runChanges = ({ since }) => {
    sinceValues.push(since);
    return responses.shift();
  };

  const first = await captureSidequestChanges({
    cursorPath,
    initialSince: '2026-07-19T00:00:00.000Z',
    projectId: PROJECT_ID,
    runChanges,
    ingest: (observation) => observations.push(observation),
  });
  await captureSidequestChanges({
    cursorPath,
    initialSince: '2020-01-01T00:00:00.000Z',
    projectId: PROJECT_ID,
    runChanges,
    ingest: (observation) => observations.push(observation),
  });

  assert.deepEqual(first, { accepted: 1, skipped: 0, serverTime: '2026-07-19T01:00:01.000Z' });
  assert.deepEqual(sinceValues, ['2026-07-19T00:00:00.000Z', '2026-07-19T01:00:01.000Z']);
  assert.equal(observations.length, 1);
  const observation = observations[0];
  assert.equal(normalizeObservation(observation).accepted, true);
  assert.equal(observation.ticket_ref, 'SQ-478');
  assert.equal(observation.task_id, 'task-478');
  assert.equal(observation.route_id, 'dispatch-478');
  assert.deepEqual(observation.attributes, {
    category: 'coding.normal',
    configured_model: 'codex-gpt-5-6-sol',
    configured_effort: 'medium',
    configured_backend: 'codex',
    resolved_model: 'codex-gpt-5-6-sol',
    resolved_effort: 'medium',
    resolved_backend: 'codex',
    executor: 'sidequest-exec-dispatch-medium',
    dispatch_id: 'dispatch-478',
    claim_worker_id: 'worker-478',
    claim_session_id: 'session-478',
    task_status: 'doing',
  });
  assert.deepEqual(observation.links, [{
    relation: 'belongs_to',
    to_kind: 'ticket',
    to_id: 'US-12',
    method: 'application_supplied',
    quality: 'exact',
  }]);
  assert.doesNotMatch(JSON.stringify(observation), /private|secret|dispatchToken|attachments|title|description|comments|prompt/);
});

test('Sidequest cursor advances only after every observation is accepted by the sink', async (t) => {
  const directory = temporaryDirectory(t);
  const cursorPath = path.join(directory, 'sidequest.cursor.json');
  const response = {
    serverTime: '2026-07-19T02:00:00.000Z',
    tickets: [{ ref: 'SQ-1', status: 'todo', updatedAt: '2026-07-19T01:59:00.000Z' }],
  };

  await assert.rejects(captureSidequestChanges({
    cursorPath,
    initialSince: '2026-07-19T01:00:00.000Z',
    runChanges: () => response,
    ingest: () => { throw new Error('observer unavailable'); },
  }), /observer unavailable/);
  assert.equal(fs.existsSync(cursorPath), false);
});

test('Sidequest maps current compact change records without copying their title', () => {
  const observation = ticketObservation({
    ref: 'SQ-2',
    title: 'sensitive title',
    status: 'done',
    updatedAt: '2026-07-19T02:01:00.000Z',
  }, {});
  assert.equal(normalizeObservation(observation).accepted, true);
  assert.deepEqual(observation.attributes, { task_status: 'done' });
  assert.doesNotMatch(JSON.stringify(observation), /sensitive title/);
});

test('gateway route observations are route evidence with inferred-only joins and no usage', () => {
  const observation = routeObservation(route(), { projectId: PROJECT_ID });
  observation.links = [temporalRouteLink('request-nearest')];

  assert.equal(normalizeObservation(observation).accepted, true);
  assert.equal(observation.event_name, 'codex_gateway.route');
  assert.equal(observation.session_id, 'session-1');
  assert.deepEqual(observation.attributes, {
    backend: 'codex',
    effective_model: 'gpt-5.6-sol',
    path_class: 'messages',
    via: 'dispatch-cached',
    effort: 'medium',
  });
  assert.deepEqual(observation.links, [{
    relation: 'correlates_with',
    to_kind: 'request',
    to_id: 'request-nearest',
    method: 'temporal_inference',
    quality: 'inferred',
  }]);
  assert.equal(observation.measurements, undefined);
  assert.equal(observation.request_id, undefined);
  assert.doesNotMatch(JSON.stringify(observation), /private|secret|authorization|prompt|headers|\/v1\/messages/);
});

test('gateway file cursor tolerates duplicate, malformed, and partial lines', async (t) => {
  const directory = temporaryDirectory(t);
  const logPath = path.join(directory, 'routes.jsonl');
  const cursorPath = path.join(directory, 'routes.cursor.json');
  const observations = [];
  const complete = JSON.stringify(route());
  const partial = JSON.stringify(route({ at: '2026-07-19T01:02:04.000Z', model: 'gpt-5.6-terra' }));
  fs.writeFileSync(logPath, `${complete}\n${complete}\n{malformed}\n${partial}`);

  const first = await captureCodexRouteLog({
    logPath,
    cursorPath,
    projectId: PROJECT_ID,
    nearestRequest: () => 'request-nearest',
    ingest: (observation) => observations.push(observation),
  });
  assert.equal(first.accepted, 1);
  assert.equal(first.duplicates, 1);
  assert.equal(first.malformed, 1);
  assert.equal(observations.length, 1);

  fs.appendFileSync(logPath, '\n');
  const second = await captureCodexRouteLog({
    logPath,
    cursorPath,
    projectId: PROJECT_ID,
    ingest: (observation) => observations.push(observation),
  });
  assert.equal(second.accepted, 1);
  assert.equal(second.malformed, 0);
  assert.equal(observations[1].attributes.effective_model, 'gpt-5.6-terra');
});

test('gateway file cursor restarts after truncation and rotation', async (t) => {
  const directory = temporaryDirectory(t);
  const logPath = path.join(directory, 'routes.jsonl');
  const cursorPath = path.join(directory, 'routes.cursor.json');
  const observedModels = [];
  const capture = () => captureCodexRouteLog({
    logPath,
    cursorPath,
    ingest: (observation) => observedModels.push(observation.attributes.effective_model),
  });

  fs.writeFileSync(logPath, `${JSON.stringify(route({ model: 'gpt-5.6-sol' }))}\n`);
  await capture();
  fs.writeFileSync(logPath, `${JSON.stringify(route({ model: 'gpt-5.6-fable', path: '/v1/models' }))}\n`);
  await capture();

  fs.renameSync(logPath, `${logPath}.1`);
  fs.writeFileSync(logPath, `${JSON.stringify(route({ model: 'gpt-5.6-terra', path: '/internal' }))}\n`);
  await capture();

  assert.deepEqual(observedModels, ['gpt-5.6-sol', 'gpt-5.6-fable', 'gpt-5.6-terra']);
});
