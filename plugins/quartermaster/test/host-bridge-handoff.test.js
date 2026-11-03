'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handoffReceipt, normalizeAdapter } = require('../lib/agent-handoff.js');

function job(extra = {}) {
  return {
    project: '/synthetic/project', requestId: 'request-id', conversationId: 'conversation-id', id: 'turn-id', claudeSessionId: 'receiver-session-id',
    createdAt: '2026-01-01T00:00:00.000Z', startedAt: '2026-01-01T00:00:01.000Z', updatedAt: '2026-01-01T00:00:02.000Z', finishedAt: '2026-01-01T00:00:02.000Z',
    state: 'succeeded', hostStarted: true, exitCode: 0, ...extra,
  };
}

test('v1 compact receipt whitelists identity/lifecycle metadata and never imports task content', () => {
  const source = job({ prompt: 'PRIVATE PROMPT', result: { text: 'PRIVATE ANSWER' }, host: { tools: ['PRIVATE TOOLS'] }, toolUse: { input: 'PRIVATE INPUT' }, taskOutcome: 'delivered' });
  const before = JSON.stringify(source);
  const receipt = handoffReceipt(source, { terminal: true });
  assert.equal(receipt.contract, 'eigenwise.agent-handoff'); assert.equal(receipt.version, 1);
  assert.equal(receipt.adapter, 'claude-code');
  assert.equal(receipt.requestId, source.requestId); assert.equal(receipt.conversationId, source.conversationId); assert.equal(receipt.turnId, source.id);
  assert.deepEqual(receipt.receiver, { ownership: 'bridge-owned', sessionId: source.claudeSessionId, observed: true });
  assert.equal(receipt.acceptedAt, source.createdAt); assert.equal(receipt.startedAt, source.startedAt); assert.equal(receipt.finishedAt, source.finishedAt);
  assert.equal(receipt.workOutcome, 'unverified');
  assert.equal(receipt.hostStopped, true); assert.equal(receipt.safeToResume, true);
  assert.ok(!JSON.stringify(receipt).includes('PRIVATE'));
  assert.equal(JSON.stringify(source), before, 'normalization does not mutate stored/native state');
});

test('terminal states and confirmed receiver closure remain separate in the common contract', () => {
  const cases = [
    { name: 'queued before a host session was observed', fields: { state: 'queued', hostStarted: false, exitCode: undefined, startedAt: null, finishedAt: null }, terminal: false, stopped: null, safe: false },
    { name: 'running native host', fields: { state: 'running', exitCode: undefined, finishedAt: null }, terminal: false, stopped: false, safe: false },
    { name: 'normal terminal host success', fields: {}, terminal: true, stopped: true, safe: true },
    { name: 'permission-blocked host that actually closed', fields: { state: 'blocked_permissions' }, terminal: true, stopped: true, safe: true },
    { name: 'failed termination guard with a live/unknown host', fields: { state: 'failed', terminationPending: true }, terminal: true, stopped: null, safe: false, blocked: true },
    { name: 'lost owner without closure proof', fields: { state: 'interrupted', error: { code: 'owner_stopped' } }, terminal: true, stopped: null, safe: false, blocked: true },
    { name: 'unsafe recovered conversation', fields: { state: 'interrupted', terminationUnconfirmed: true, resumeBlocked: true }, terminal: true, stopped: null, safe: false, blocked: true },
    { name: 'root closed after a failed process-tree termination', fields: { state: 'cancelled', termination: { treeError: 'EPERM', fallbackRequested: true } }, terminal: true, stopped: true, safe: false, blocked: true },
    { name: 'unknown old terminal record', fields: { state: 'failed', exitCode: undefined, signal: undefined }, terminal: true, stopped: null, safe: false, blocked: true },
    { name: 'cancelled before any receiver session existed', fields: { state: 'cancelled', hostStarted: false, exitCode: undefined, startedAt: null }, terminal: true, stopped: true, safe: false },
    { name: 'a crossed receiver session is never safe', fields: { state: 'failed', error: { code: 'session_mismatch' } }, terminal: true, stopped: true, safe: false, blocked: true },
  ];
  for (const scenario of cases) {
    const source = job(scenario.fields);
    for (const key of ['exitCode', 'signal']) if (source[key] === undefined) delete source[key];
    const receipt = handoffReceipt(source, { terminal: scenario.terminal });
    assert.equal(receipt.terminal, scenario.terminal, scenario.name);
    assert.equal(receipt.hostStopped, scenario.stopped, scenario.name);
    assert.equal(receipt.safeToResume, scenario.safe, scenario.name);
    if (scenario.blocked) assert.equal(receipt.resumeBlocked, true, scenario.name);
    assert.equal(receipt.workOutcome, 'unverified', scenario.name);
  }
});

test('adapter selection supports only the proven adapter and never falls back', () => {
  assert.equal(normalizeAdapter(undefined), 'claude-code');
  assert.equal(normalizeAdapter('claude-code'), 'claude-code');
  for (const unsupported of ['codex', 'pi', '', null, { name: 'claude-code' }]) assert.throws(() => normalizeAdapter(unsupported), /Unsupported agent adapter.*no fallback/);
});
