'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CACHE_MAX_AGE_MS,
  audit,
  createDebouncer,
  emitWarning,
  sourceFreshness,
} = require('../hooks/session-start-freshness.js');

const now = Date.parse('2026-07-17T12:00:00Z');

function fixture(overrides = {}) {
  return {
    now,
    registry: {
      plugins: {
        'sidequest@eigenwise-toolshed': [{ scope: 'project', projectPath: 'C:/work/one', version: '1.0.0' }],
        'plugin@other-marketplace': [{ scope: 'user', version: '1.0.0' }],
      },
    },
    marketplaces: {
      'eigenwise-toolshed': { autoUpdate: true, lastUpdated: new Date(now).toISOString() },
      'other-marketplace': { autoUpdate: true, lastUpdated: new Date(now).toISOString() },
    },
    manifestFor: (name) => ({
      plugins: name === 'eigenwise-toolshed'
        ? [{ name: 'sidequest', version: '1.0.0' }]
        : [{ name: 'plugin', version: '1.0.0' }],
    }),
    checkGateway: () => ({ available: true }),
    versions: { node: '22.5.0', claude: '2.1.0' },
    boards: [],
    ...overrides,
  };
}

test('enumerates every board and maps it to its Sidequest project install', () => {
  const result = audit(fixture({
    boards: [
      { name: 'One', path: 'C:/work/one' },
      { name: 'Two', path: 'C:/work/two' },
    ],
  }));

  assert.deepEqual(result.mappings, [
    { name: 'One', path: 'C:/work/one', status: 'installed' },
    { name: 'Two', path: 'C:/work/two', status: 'missing' },
  ]);
  assert.match(result.problems.join('\n'), /Sidequest board Two has no Sidequest install/);
});

test('finds stale versions and marks absent manifest entries as unknown', () => {
  const input = fixture({
    registry: {
      plugins: {
        'sidequest@eigenwise-toolshed': [{ scope: 'user', version: '1.0.0' }],
        'missing@other-marketplace': [{ scope: 'user', version: '1.0.0' }],
      },
    },
    manifestFor: (name) => ({
      plugins: name === 'eigenwise-toolshed'
        ? [{ name: 'sidequest', version: '1.1.0' }]
        : [{ name: 'different', version: '1.0.0' }],
    }),
  });

  const result = audit(input);
  assert.match(result.problems.join('\n'), /sidequest@eigenwise-toolshed 1.0.0 is behind cached 1.1.0/);
  assert.match(result.problems.join('\n'), /missing@other-marketplace freshness is unknown/);
  assert.doesNotMatch(result.problems.join('\n'), /absent from/);
});

test('honors the official marketplace default and third-party explicit settings', () => {
  const result = audit(fixture({
    registry: {
      plugins: {
        'official@claude-plugins-official': [{ scope: 'user', version: '1.0.0' }],
        'third-party@other-marketplace': [{ scope: 'user', version: '1.0.0' }],
      },
    },
    marketplaces: {
      'claude-plugins-official': { lastUpdated: new Date(now).toISOString() },
      'other-marketplace': { autoUpdate: false, lastUpdated: new Date(now).toISOString() },
    },
    manifestFor: (name) => ({ plugins: [{ name: name === 'claude-plugins-official' ? 'official' : 'third-party', version: '1.0.0' }] }),
  }));

  assert.doesNotMatch(result.problems.join('\n'), /claude-plugins-official auto-update is off/);
  assert.match(result.problems.join('\n'), /other-marketplace auto-update is off/);
});

test('compares rolling plugins against only their cached source path', () => {
  const calls = [];
  const freshness = sourceFreshness(
    { gitCommitSha: 'installed-sha' },
    { source: './plugins/rolling' },
    { installLocation: 'C:/cache/marketplace' },
    (args) => {
      calls.push(args);
      return { status: 0 };
    },
  );

  assert.equal(freshness, 'fresh');
  assert.deepEqual(calls, [
    ['-C', 'C:/cache/marketplace', 'merge-base', '--is-ancestor', 'installed-sha', 'HEAD'],
    ['-C', 'C:/cache/marketplace', 'diff', '--quiet', 'installed-sha..HEAD', '--', 'plugins/rolling'],
  ]);
});

test('does not call an unrelated cached git history stale', () => {
  const freshness = sourceFreshness(
    { gitCommitSha: 'unrelated-sha' },
    { source: './plugins/rolling' },
    { installLocation: 'C:/cache/marketplace' },
    () => ({ status: 1 }),
  );

  assert.equal(freshness, 'unknown');
});

test('does not flag rolling plugins that match their cached source', () => {
  const result = audit(fixture({
    registry: {
      plugins: {
        'rolling@other-marketplace': [{ scope: 'user', gitCommitSha: 'installed-sha' }],
      },
    },
    manifestFor: () => ({ plugins: [{ name: 'rolling', source: './plugins/rolling' }] }),
    gitFreshness: () => 'fresh',
  }));

  assert.deepEqual(result.problems, []);
});

test('reports rolling plugin freshness as unknown when local git cannot prove it', () => {
  const result = audit(fixture({
    registry: {
      plugins: {
        'rolling@other-marketplace': [{ scope: 'user', gitCommitSha: 'installed-sha' }],
      },
    },
    manifestFor: () => ({ plugins: [{ name: 'rolling', source: './plugins/rolling' }] }),
    gitFreshness: () => 'unknown',
  }));

  assert.match(result.problems.join('\n'), /rolling@other-marketplace freshness is unknown/);
});

test('reports stale marketplace caches without claiming remote freshness', () => {
  const result = audit(fixture({
    marketplaces: {
      'eigenwise-toolshed': { autoUpdate: true, lastUpdated: new Date(now - CACHE_MAX_AGE_MS - 1).toISOString() },
      'other-marketplace': { autoUpdate: true, lastUpdated: new Date(now).toISOString() },
    },
    manifestFor: (name) => ({ plugins: [{ name: name === 'eigenwise-toolshed' ? 'sidequest' : 'plugin', version: '9.0.0' }] }),
  }));

  assert.match(result.problems.join('\n'), /eigenwise-toolshed marketplace cache is stale, installed freshness is unknown/);
  assert.doesNotMatch(result.problems.join('\n'), /sidequest@eigenwise-toolshed.*behind/);
});

test('flags a codex proxy version below its bundled floor', () => {
  const result = audit(fixture({
    registry: {
      plugins: {
        'codex-gateway@eigenwise-toolshed': [{ scope: 'user', version: '1.0.0', installPath: 'C:/gateway' }],
      },
    },
    manifestFor: () => ({ plugins: [{ name: 'codex-gateway', version: '1.0.0' }] }),
    checkGateway: () => ({
      available: true,
      proxyVersion: '0.1.13',
      minProxyVersion: '0.1.14',
      auth: true,
      proxy: true,
      shim: true,
    }),
  }));

  assert.match(result.problems.join('\n'), /codex-gateway proxy 0.1.13 is below required 0.1.14/);
});

test('stays silent for a healthy fleet', () => {
  const result = audit(fixture());
  assert.deepEqual(result.problems, []);
  assert.equal(emitWarning(result.problems), '');
});

test('collapses multiple problems into one actionable warning', () => {
  const message = emitWarning([
    'one', 'two', 'three', 'four', 'five', 'six',
  ], createDebouncer(new Set()));

  assert.match(message, /^Toolshed local health: /);
  assert.match(message, /\+1 more/);
  assert.match(message, /Run \/update-toolshed/);
  assert.equal(message.split('\n').length, 1);
});

test('debounces the same state but reports a changed state', () => {
  const debouncer = createDebouncer(new Set());
  assert.match(emitWarning(['stale cache'], debouncer), /stale cache/);
  assert.equal(emitWarning(['stale cache'], debouncer), '');
  assert.match(emitWarning(['stale cache', 'proxy down'], debouncer), /proxy down/);
});
