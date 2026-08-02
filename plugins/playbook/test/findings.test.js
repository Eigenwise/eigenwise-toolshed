'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { AMEND_FIRST, audience, rank, ROUTES, routeFor } = require('../lib/findings.js');

const finding = (overrides) => ({ kind: 'repeated-command', occurrences: 3, sessions: 1, actors: [], evidence: [], ...overrides });

test('work several executors repeat routes to a script, not a skill', () => {
  const route = routeFor(finding({
    actors: [
      { label: 'subagent:sidequest-exec-dispatch-high', count: 4 },
      { label: 'subagent:sidequest-exec-dispatch-medium', count: 3 },
    ],
    arguments: [],
  }));
  assert.equal(route.route, 'script');
  assert.match(route.why, /would not reach them/);
});

test('a command whose arguments varied routes to a parameterized script', () => {
  const route = routeFor(finding({
    actors: [{ label: 'main-loop', count: 3 }],
    arguments: [{ position: 1, token: '<path>', distinct: 3, values: ['a', 'b', 'c'] }],
  }));
  assert.equal(route.route, 'script');
  assert.match(route.why, /CLI arguments/);
});

test('a repeated correction becomes a rule and is never routed to a skill', () => {
  const repeated = routeFor(finding({ kind: 'user-correction', occurrences: 3, actors: [{ label: 'user', count: 3 }] }));
  assert.equal(repeated.route, 'rule');
  assert.match(repeated.why, /Never a skill/);

  const once = routeFor(finding({ kind: 'user-correction', occurrences: 1, actors: [{ label: 'user', count: 1 }] }));
  assert.equal(once.route, 'memory');
});

test('no correction, however often it repeats, ever routes to a skill', () => {
  for (const occurrences of [1, 2, 5, 20]) {
    const route = routeFor(finding({ kind: 'user-correction', occurrences, actors: [{ label: 'user', count: occurrences }] }));
    assert.notEqual(route.route, 'skill');
  }
});

test('a rewritten script is salvaged rather than regenerated', () => {
  const proven = routeFor(finding({ kind: 'rewritten-script', proven: true }));
  assert.equal(proven.route, 'script');
  assert.match(proven.why, /salvage/i);

  const unproven = routeFor(finding({ kind: 'rewritten-script', proven: false }));
  assert.match(unproven.why, /test it before shipping/);
});

test('rediscovery by executors routes to the map, because it loads before they start reading', () => {
  const route = routeFor(finding({ kind: 'rediscovery-tax', actors: [{ label: 'subagent:Explore', count: 4 }] }));
  assert.equal(route.route, 'map');
  assert.match(route.why, /before they start reading/);
});

test('audience is decided by who did the work, not by how many did it', () => {
  assert.equal(audience({ actors: [{ label: 'user', count: 1 }] }).primary, 'user');
  assert.equal(audience({ actors: [{ label: 'main-loop', count: 9 }, { label: 'subagent:x', count: 1 }] }).primary, 'main-loop');
  assert.equal(audience({ actors: [{ label: 'subagent:x', count: 5 }, { label: 'main-loop', count: 1 }] }).primary, 'subagents');
});

test('elapsed time raises a slow repeated command above a cheaper frequent one', () => {
  const { findings } = rank([
    finding({ title: 'npm ci', occurrences: 193, totalDurationMs: 16.9 * 60 * 1000, complexity: 1 }),
    finding({ title: 'verify loop', occurrences: 3, totalDurationMs: 284.5 * 60 * 1000, complexity: 1 }),
  ]);
  assert.equal(findings[0].title, 'verify loop');
});

test('hazards outrank frequency, and one-offs are dropped rather than padded', () => {
  const { findings, dropped } = rank([
    { kind: 'repeated-command', title: 'ran a lot', occurrences: 40, sessions: 5, actors: [{ label: 'main-loop', count: 40 }], complexity: 30, evidence: [] },
    { kind: 'hazard-private-data', severity: 'critical', title: 'env file exposed', occurrences: 1, sessions: 1, actors: [], evidence: [] },
    { kind: 'permission-denial', title: 'one denial', occurrences: 1, sessions: 1, actors: [], evidence: [] },
  ]);

  assert.equal(findings[0].kind, 'hazard-private-data');
  assert.equal(findings[0].id, 'F01');
  assert.ok(dropped.some((item) => item.kind === 'permission-denial'), 'a single denial is not worth a fix');
});

test('every route that can write an artifact carries the amend-first check', () => {
  for (const route of ['script', 'skill', 'rule', 'map', 'memory']) {
    assert.ok(AMEND_FIRST[route], `${route} must ask whether one already exists`);
    assert.match(ROUTES[route], /new or amended|memory entry|codebase map/);
  }

  const { findings } = rank([
    finding({ title: 'same verify, forty times', occurrences: 40, sessions: 5, actors: [{ label: 'main-loop', count: 40 }], arguments: [{ position: 1, token: '<path>', distinct: 3, values: ['a', 'b', 'c'] }] }),
  ]);
  assert.match(findings[0].amendFirst, /already does this/);
});

test('a hazard carries no amend-first check, because the fix is an ignore entry either way', () => {
  const { findings } = rank([
    { kind: 'hazard-private-data', severity: 'critical', title: 'env file exposed', occurrences: 1, sessions: 1, actors: [], evidence: [] },
  ]);
  assert.equal(findings[0].amendFirst, null);
});

test('a hazard survives the floor no matter how low it scores', () => {
  const { findings } = rank(
    [{ kind: 'hazard-private-data', severity: 'critical', title: 'exposed', occurrences: 1, sessions: 1, actors: [], evidence: [] }],
    { floor: 100000 },
  );
  assert.equal(findings.length, 1);
});
