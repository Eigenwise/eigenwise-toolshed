'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const { observeGatewayChildClose, processIsRunning, requireFixtureShutdown,
  gatewayTestEnvironment, spawnGatewayProcess, removeOwnedGatewayTestHome,
  waitForGatewayChildClose, stopGatewayChild, readRecordedGatewayPid } = require('./support.js');
const { createControllerIpcHandlers } = require('./fixtures/owned-teardown-tree.js');

function permissionDenied() {
  throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
}

function processMissing() {
  throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
}

test('fixture shutdown trusts observed close without probing a reused pid', () => {
  const child = Object.assign(new EventEmitter(), { pid: 1234 });
  observeGatewayChildClose(child);
  child.emit('close');
  let probes = 0;
  const isRunning = (pid) => {
    probes += 1;
    return processIsRunning(pid, { kill: permissionDenied, platform: 'linux' });
  };
  assert.doesNotThrow(() => requireFixtureShutdown('fixture-home', {
    children: [child], pids: [child.pid], closed: true,
  }, isRunning));
  assert.equal(probes, 0, 'an observed close must prevent even an EPERM probe');
});

test('fixture shutdown accepts ESRCH for a pid without observed close', () => {
  const isRunning = (pid) => processIsRunning(pid, { kill: processMissing });
  assert.doesNotThrow(() => requireFixtureShutdown('fixture-home', {
    children: [], pids: [1234], closed: true,
  }, isRunning));
});

test('fixture shutdown rejects a running pid without observed close', () => {
  const child = Object.assign(new EventEmitter(), { pid: 1234 });
  observeGatewayChildClose(child);
  const probes = [];
  const isRunning = (pid) => processIsRunning(pid, {
    kill: (probedPid, signal) => probes.push([probedPid, signal]),
  });
  assert.throws(() => requireFixtureShutdown('fixture-home', {
    children: [child], pids: [child.pid], closed: true,
  }, isRunning), { code: 'ERR_GATEWAY_FIXTURE_PROCESS_ALIVE' });
  assert.deepEqual(probes, [[child.pid, 0]]);
});

test('fixture process probe treats Windows EPERM as a foreign pid', () => {
  assert.equal(processIsRunning(1234, { kill: permissionDenied, platform: 'win32' }), false);
});

test('fixture process probe preserves non-Windows EPERM liveness', () => {
  assert.equal(processIsRunning(1234, { kill: permissionDenied, platform: 'linux' }), true);
});

test('fixture process probe treats ESRCH as exited on every platform', () => {
  assert.equal(processIsRunning(1234, { kill: processMissing, platform: 'win32' }), false);
  assert.equal(processIsRunning(1234, { kill: processMissing, platform: 'linux' }), false);
});

test('fixture process probe preserves unexpected errors as possibly running', () => {
  const kill = () => { throw Object.assign(new Error('unexpected'), { code: 'EIO' }); };
  assert.equal(processIsRunning(1234, { kill, platform: 'win32' }), true);
});

test('fixture process probe ignores missing pids', () => {
  assert.equal(processIsRunning(null, { kill: assert.fail }), false);
});

test('fixture live-pid failure remembers only the first true candidate without probing closed or later pids', () => {
  const closed = Object.assign(new EventEmitter(), { pid: 101 });
  observeGatewayChildClose(closed);
  closed.emit('close');
  const probes = [];
  assert.throws(() => requireFixtureShutdown('synthetic-owned-root', {
    children: [closed], pids: [closed.pid, 202, 303, 404], closed: true,
  }, (pid) => { probes.push(pid); return pid === 303; }), (error) => {
    assert.equal(error.code, 'ERR_GATEWAY_FIXTURE_PROCESS_ALIVE');
    assert.equal(error.fixturePid, 303);
    return true;
  });
  assert.deepEqual(probes, [202, 303]);
});

async function removalDiagnostic(home, failedPath, shutdown = { children: [], pids: [], closed: true }, diagnosticProbe = assert.fail) {
  let clock = 0;
  const cause = Object.assign(new Error('synthetic owned-root removal fault'), {
    code: 'EBUSY', path: failedPath, syscall: 'rmdir',
  });
  try {
    await removeOwnedGatewayTestHome(home, { timeout: 10, now: () => clock,
      pause: async (milliseconds) => { clock += milliseconds; },
      remove: async () => { throw cause; }, shutdown, diagnosticProbe });
    assert.fail('injected removal must fail');
  } catch (error) {
    assert.equal(error.cause, cause);
    return error;
  }
}

for (const scenario of [
  { name: 'root', failedPath: (home) => home, relative: '.', inside: true },
  { name: 'descendant', failedPath: (home) => path.join(home, 'leaf.work'), relative: 'leaf.work', inside: true },
  { name: 'outside', failedPath: (home) => path.join(home, '..', 'not-this-owned-root'), relative: null, inside: false },
  { name: 'unavailable', failedPath: () => undefined, relative: null, inside: null },
]) {
  test(`owned-root teardown diagnostics type the ${scenario.name} failure path without extra process probes`, async () => {
    const environment = gatewayTestEnvironment(null);
    try {
      const error = await removalDiagnostic(environment.HOME, scenario.failedPath(environment.HOME));
      assert.equal(error.details.code, 'EBUSY');
      assert.equal(error.details.syscall, 'rmdir');
      assert.equal(error.details.relativePath, scenario.relative);
      assert.equal(error.details.pathInsideOwnedRoot, scenario.inside);
      assert.deepEqual(error.details.processes, []);
      assert.equal(error.details.attempts, 1);
      assert.equal(error.details.elapsedMs, 10);
    } finally { await removeOwnedGatewayTestHome(environment.HOME); }
  });
}

for (const scenario of [
  { name: 'unverified live child', exitCode: null, close: false, liveness: 'not-probed' },
  { name: 'observed exit without close', exitCode: 0, close: false, liveness: 'exit-observed' },
  { name: 'observed close', exitCode: 0, close: true, liveness: 'close-observed' },
]) {
  test(`failure diagnostics never probe a reused or ${scenario.name} numeric pid`, async () => {
    const environment = gatewayTestEnvironment(null);
    const child = Object.assign(new EventEmitter(), { pid: 1234, exitCode: scenario.exitCode, signalCode: null });
    observeGatewayChildClose(child);
    if (scenario.close) child.emit('close');
    try {
      const shutdown = { children: [child], pids: [], closed: true,
        stopResults: [{ pid: child.pid, source: 'recorded', result: false }] };
      const error = await removalDiagnostic(environment.HOME, environment.HOME, shutdown);
      const diagnostic = error.details.children[0];
      assert.equal(diagnostic.identityState, 'unverified-child-handle');
      assert.equal(diagnostic.liveness.state, scenario.liveness);
      assert.equal(diagnostic.liveness.errorCode, null);
      assert.equal(diagnostic.resourceReleased, null);
      assert.equal(diagnostic.stopResult, false);
      assert.equal(diagnostic.closeObserved, scenario.close);
    } finally { await removeOwnedGatewayTestHome(environment.HOME); }
  });
}

function appendTreeObservation(state, message) {
  state.messages.push({ ...message, receivedAtNs: process.hrtime.bigint().toString() });
  state.changed.emit('change');
}

function receiveTreeMessage(state, message) {
  if (message.nonce !== state.nonce) {
    state.failure = new Error('owned tree sent a mismatched birth nonce');
    state.changed.emit('change');
    return;
  }
  if (message.type === 'released' && message.role === 'parent') state.child.fixtureResourcesReleased = true;
  appendTreeObservation(state, message);
}

function startOwnedTree(environment) {
  const state = { nonce: randomUUID(), messages: [], changed: new EventEmitter(), failure: null, child: null };
  const configuration = { home: environment.HOME, nonce: state.nonce, role: 'parent' };
  state.child = spawnGatewayProcess(null, process.execPath,
    [path.join(__dirname, 'fixtures', 'owned-teardown-tree.js'), JSON.stringify(configuration)], {
      env: environment, cwd: environment.HOME, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
  state.child.fixtureResourcesReleased = false;
  state.child.on('message', (message) => receiveTreeMessage(state, message));
  state.child.once('error', (error) => { state.failure = error; state.changed.emit('change'); });
  state.child.once('close', (code, signal) => appendTreeObservation(state, {
    type: 'controller-close', role: 'parent', nonce: state.nonce, pid: state.child.pid,
    exitCode: code, signalCode: signal,
  }));
  return state;
}

function waitForTree(state, predicate) {
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      state.changed.off('change', check);
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (state.failure) return finish(state.failure);
      if (predicate()) finish();
    };
    const timer = setTimeout(() => finish(new Error('owned tree did not complete its bounded phase')), 5000);
    state.changed.on('change', check);
    check();
  });
}

test('owned tree phase waits reject a mismatched birth nonce and a real bounded deadline', async (t) => {
  const mismatched = { nonce: 'expected', messages: [], changed: new EventEmitter(), failure: null };
  const rejectedNonce = assert.rejects(waitForTree(mismatched, () => false), /mismatched birth nonce/);
  receiveTreeMessage(mismatched, { nonce: 'different' });
  await rejectedNonce;
  assert.equal(mismatched.changed.listenerCount('change'), 0);
  const stalled = { messages: [], changed: new EventEmitter(), failure: null };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rejectedDeadline = assert.rejects(waitForTree(stalled, () => false), /bounded phase/);
  t.mock.timers.tick(5000);
  await rejectedDeadline;
  t.mock.timers.reset();
  assert.equal(stalled.changed.listenerCount('change'), 0);
});

function readyTree(state) {
  return state.messages.filter((message) => message.type === 'ready');
}

function requestTreeRelease(state) {
  if (state.child.connected) state.child.send({ type: 'release', nonce: state.nonce }, () => {});
}

function controllerDisconnectAckMatches(message, births) {
  return message?.type === 'disconnect-controller-ack' && message.role === 'parent'
    && message.pid === births.parent.pid && message.nonce === births.parent.nonce;
}

function requestPeerInitiatedControllerDisconnect(state, births) {
  const child = state.child;
  return new Promise((resolve, reject) => {
    let acknowledgement = null;
    let disconnected = false;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('disconnect', onDisconnect);
      child.off('error', onError);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(acknowledgement);
    };
    const onMessage = (message) => {
      if (message?.type !== 'disconnect-controller-ack') return;
      if (!controllerDisconnectAckMatches(message, births)) {
        finish(new Error('controller disconnect ACK does not match READY root birth'));
        return;
      }
      if (acknowledgement) {
        finish(new Error('controller disconnect ACK was duplicated'));
        return;
      }
      acknowledgement = message;
      if (disconnected) finish();
    };
    const onDisconnect = () => {
      disconnected = true;
      if (child.connected !== false) {
        finish(new Error('controller IPC disconnect did not clear connected state'));
        return;
      }
      if (acknowledgement) finish();
    };
    const onError = (error) => finish(error);
    const timer = setTimeout(() => finish(new Error('peer-initiated controller channel closure did not complete')), 5000);

    // Both observers are installed before the nonce-bound request is sent.
    child.on('message', onMessage);
    child.once('disconnect', onDisconnect);
    child.once('error', onError);
    if (!child.connected) {
      finish(new Error('controller IPC channel was already disconnected before the request'));
      return;
    }
    try {
      child.send({ type: 'disconnect-controller', nonce: state.nonce }, (error) => {
        if (error) finish(error);
      });
    } catch (error) { finish(error); }
  });
}

async function closeOwnedTree(state) {
  requestTreeRelease(state); // FIRST action, including on assertion/READY failure.
  assert.equal(await waitForGatewayChildClose(state.child, 5000), true, 'owned parent must actually close');
  assert.equal(state.child.exitCode, 0);
  assert.equal(state.child.signalCode, null);
}

function assertTreeBirths(state) {
  const ready = readyTree(state);
  assert.equal(ready.length, 3);
  const byRole = Object.fromEntries(ready.map((message) => [message.role, message]));
  assert.deepEqual(Object.keys(byRole).sort(), ['child', 'grandchild', 'parent']);
  assert.equal(new Set(ready.map((message) => message.pid)).size, 3);
  assert.equal(byRole.parent.pid, state.child.pid);
  assert.equal(byRole.parent.parentPid, process.pid);
  assert.equal(byRole.child.parentPid, byRole.parent.pid);
  assert.equal(byRole.grandchild.parentPid, byRole.child.pid);
  for (const message of ready) {
    assert.equal(message.nonce, state.nonce);
    assert.equal(message.cwdIsOwnedRoot, true);
    assert.equal(message.resourceReleased, false);
    assert.match(message.observedAtNs, /^\d+$/);
  }
  return byRole;
}

async function parentOnlyCompletionCannotRemove(environment, state, births) {
  let removals = 0;
  // The ONLY liveness candidate is the nonce-proven LIVE grandchild. The real
  // parent is deliberately absent from shutdown evidence and retains IPC only
  // for cleanup; its continued existence cannot make this negative pass.
  await assert.rejects(removeOwnedGatewayTestHome(environment.HOME, {
    shutdown: { children: [], closed: true, pids: [births.grandchild.pid],
      stopResults: [{ pid: births.grandchild.pid, source: 'recorded', result: false }] },
    remove: async () => { removals++; assert.fail('parent-only completion must not authorize rm'); },
    diagnosticProbe: assert.fail,
  }), (error) => {
    assert.equal(error.cause.code, 'ERR_GATEWAY_FIXTURE_PROCESS_ALIVE');
    assert.equal(error.cause.fixturePid, births.grandchild.pid);
    assert.equal(error.details.failingPid, births.grandchild.pid);
    assert.deepEqual(error.details.knownPids, [births.grandchild.pid]);
    assert.equal(error.details.processes[0].ownership, 'recorded-only');
    assert.equal(error.details.processes[0].identityState, 'unverified-recorded-pid');
    assert.equal(error.details.processes[0].liveness.state, 'not-probed');
    assert.equal(error.details.processes[0].stopResult, false);
    return true;
  });
  assert.equal(removals, 0);
  assert.equal(state.child.connected, true, 'negative control must preserve its owned stop channel');
  assert.equal(fs.existsSync(environment.HOME), true);
}

async function liveParentDiagnostic(environment, state, diagnosticCode) {
  const probes = [];
  const error = await removalDiagnostic(environment.HOME, environment.HOME, {
    children: [state.child], pids: [], closed: true,
  }, (pid, signal) => {
    probes.push([pid, signal]);
    if (diagnosticCode) throw Object.assign(new Error('synthetic diagnostic probe'), { code: diagnosticCode });
  });
  const diagnostic = error.details.children[0];
  assert.equal(diagnostic.ownership, 'direct-child');
  assert.equal(diagnostic.identityState, 'tracked-child-handle');
  assert.equal(diagnostic.resourceReleased, false);
  assert.equal(diagnostic.closeObserved, false);
  assert.equal(diagnostic.liveness.errorCode, diagnosticCode);
  const expected = { EPERM: 'unknown', ESRCH: 'absent', null: 'probe-succeeded' }[diagnosticCode];
  assert.equal(diagnostic.liveness.state, expected);
  assert.deepEqual(probes, [[state.child.pid, 0]], 'only the registered live ChildProcess may be diagnosed');
}

function assertTreeCloseEvent(event, births) {
  assert.equal(event.exitCode, 0);
  assert.equal(event.signalCode, null);
  assert.equal(event.subjectPid, births[event.subjectRole].pid);
  assert.equal(event.role, { child: 'parent', grandchild: 'child' }[event.subjectRole]);
  assert.equal(event.pid, births[event.role].pid);
  assert.match(event.observedAtNs, /^\d+$/);
}

function assertTreeReleaseEvent(event, births) {
  assert.equal(event.pid, births[event.role].pid);
  assert.equal(event.nonce, births[event.role].nonce);
  assert.equal(event.resourceReleased, true);
  assert.equal(event.cwdReleased, true);
  assert.match(event.observedAtNs, /^\d+$/);
}

function assertTreeReleaseOrder(events) {
  let previous = -1;
  for (const [type, role] of [['released', 'grandchild'], ['closed', 'grandchild'],
    ['released', 'child'], ['closed', 'child'], ['released', 'parent']]) {
    const position = events.findIndex((event) => event.type === type && (event.subjectRole || event.role) === role);
    assert.ok(position > previous, `${role} ${type} must follow the descendant's actual close`);
    previous = position;
  }
}

test('teardown ordering and peer ACK controls reject missing or forged lifecycle evidence', () => {
  const ordered = [
    { type: 'released', role: 'grandchild' }, { type: 'closed', subjectRole: 'grandchild' },
    { type: 'released', role: 'child' }, { type: 'closed', subjectRole: 'child' },
    { type: 'released', role: 'parent' },
  ];
  assert.doesNotThrow(() => assertTreeReleaseOrder(ordered));
  assert.throws(() => assertTreeReleaseOrder(ordered.filter((event) => event !== ordered[1])), assert.AssertionError);
  assert.throws(() => assertTreeReleaseOrder([ordered[0], ordered[2], ordered[1], ordered[3], ordered[4]]), assert.AssertionError);

  const births = { parent: { pid: 101, nonce: 'root-birth' } };
  const acknowledgement = { type: 'disconnect-controller-ack', role: 'parent', pid: 101, nonce: 'root-birth' };
  const journal = [acknowledgement,
    { type: 'channel-disconnected', role: 'parent', pid: 101, nonce: 'root-birth' },
    { type: 'released', role: 'grandchild', pid: 303, nonce: 'root-birth' }];
  assert.equal(controllerDisconnectAckMatches(acknowledgement, births), true);
  assert.doesNotThrow(() => assertPeerDisconnectJournal(journal, births, acknowledgement));

  const rejectedAtAckLookup = (events, readyBirths, controllerAck) => assert.throws(
    () => assertPeerDisconnectJournal(events, readyBirths, controllerAck),
    (error) => {
      assert.equal(error.code, 'ERR_ASSERTION');
      assert.match(error.message, /READY-bound ACK journal entry must exist before order comparison/);
      return true;
    });
  const missingAck = journal.filter((event) => event !== acknowledgement);
  rejectedAtAckLookup(missingAck, births, acknowledgement);

  const wrongPid = { ...acknowledgement, pid: 102 };
  assert.equal(controllerDisconnectAckMatches(wrongPid, births), false);
  rejectedAtAckLookup(journal.map((event) => event === acknowledgement ? wrongPid : event), births, acknowledgement);

  const wrongNonce = { ...acknowledgement, nonce: 'forged-birth' };
  assert.equal(controllerDisconnectAckMatches(wrongNonce, births), false);
  rejectedAtAckLookup(journal.map((event) => event === acknowledgement ? wrongNonce : event), births, acknowledgement);
  const forgedReadyBirths = { parent: { ...births.parent, nonce: 'forged-ready-birth' } };
  rejectedAtAckLookup(journal, forgedReadyBirths, acknowledgement);

  assert.throws(() => assertPeerDisconnectJournal(journal, births, wrongPid), (error) => {
    assert.equal(error.code, 'ERR_ASSERTION');
    assert.match(error.message, /controller ACK must match the READY root birth/);
    return true;
  });
  assert.throws(() => assertPeerDisconnectJournal(journal, births, wrongNonce), (error) => {
    assert.equal(error.code, 'ERR_ASSERTION');
    assert.match(error.message, /controller ACK must match the READY root birth/);
    return true;
  });
});

function assertTreeChannelDisconnectEvent(event, births) {
  const birth = births[event.role];
  assert.ok(birth, `unexpected disconnected fixture role ${event.role}`);
  assert.equal(event.pid, birth.pid);
  assert.equal(event.nonce, birth.nonce);
  assert.equal(event.connected, false);
  assert.match(event.observedAtNs, /^\d+$/);
}

function assertPeerDisconnectJournal(events, births, controllerAck) {
  const acknowledgementIndex = events.findIndex((event) => controllerDisconnectAckMatches(event, births));
  assert.ok(acknowledgementIndex >= 0, 'READY-bound ACK journal entry must exist before order comparison');
  const acknowledgements = events.filter((event) => event.type === 'disconnect-controller-ack');
  assert.equal(acknowledgements.length, 1, 'peer-initiated closure requires exactly one journalled ACK');
  const acknowledgement = acknowledgements[0];
  assert.ok(controllerDisconnectAckMatches(controllerAck, births), 'controller ACK must match the READY root birth');
  assert.ok(controllerDisconnectAckMatches(acknowledgement, births), 'journal ACK must match the READY root birth');
  assert.deepEqual(controllerAck, acknowledgement);
  const parentDisconnectIndex = events.findIndex((event) => event.type === 'channel-disconnected' && event.role === 'parent');
  assert.ok(parentDisconnectIndex >= 0);
  const leafReleasedIndex = events.findIndex((event) => event.type === 'released' && event.role === 'grandchild');
  assert.ok(acknowledgementIndex < parentDisconnectIndex);
  assert.ok(parentDisconnectIndex < leafReleasedIndex,
    'the root must journal its actual IPC disconnect before releasing descendants');
}

function readClosedTree(environment, state, births) {
  const events = fs.readFileSync(path.join(environment.HOME, 'tree-events.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  events.forEach((event) => assert.equal(event.nonce, state.nonce));
  assertTreeReleaseOrder(events);
  const closed = events.filter((event) => event.type === 'closed');
  assert.equal(closed.length, 2);
  closed.forEach((event) => assertTreeCloseEvent(event, births));
  const released = events.filter((event) => event.type === 'released');
  assert.equal(released.length, 3);
  released.forEach((event) => assertTreeReleaseEvent(event, births));
  const disconnected = events.filter((event) => event.type === 'channel-disconnected');
  assert.equal(disconnected.length, 3);
  disconnected.forEach((event) => assertTreeChannelDisconnectEvent(event, births));
  const parentDisconnectIndex = events.findIndex((event) => event.type === 'channel-disconnected' && event.role === 'parent');
  assert.ok(parentDisconnectIndex >= 0);
  const acknowledgements = events.filter((event) => event.type === 'disconnect-controller-ack');
  if (state.controllerChannelMode === 'peer-initiated-controller-channel-closure') {
    assert.equal(state.child.connected, false);
    assertPeerDisconnectJournal(events, births, state.controllerDisconnectAck);
  } else {
    assert.equal(acknowledgements.length, 0);
    const parentReleasedIndex = events.findIndex((event) => event.type === 'released' && event.role === 'parent');
    assert.ok(parentReleasedIndex < parentDisconnectIndex);
  }
  const parentClose = state.messages.find((event) => event.type === 'controller-close');
  assert.equal(parentClose.pid, births.parent.pid);
  assert.equal(parentClose.exitCode, 0);
  assert.equal(parentClose.signalCode, null);
  assert.match(parentClose.receivedAtNs, /^\d+$/);
  state.child.fixtureResourcesReleased = true;
}

function closedTreeShutdown(state, stopped) {
  // The only guard PID has a real observed ChildProcess close. Descendant
  // closure is independently checked in the nonce/PID-bound journal above;
  // never probe their exited numeric PIDs again (they may have been reused).
  return { children: [state.child], pids: [state.child.pid],
    closed: true, stopResults: [{ pid: state.child.pid, source: 'direct', result: stopped }] };
}

test('closed-tree cleanup evidence includes only the parent with an observed close, never retired descendant pids', () => {
  const parent = Object.assign(new EventEmitter(), { pid: 101 });
  observeGatewayChildClose(parent);
  parent.emit('close');
  const shutdown = closedTreeShutdown({ child: parent }, true);
  assert.deepEqual(shutdown.pids, [parent.pid]);
  assert.doesNotThrow(() => requireFixtureShutdown('synthetic-owned-root', shutdown,
    () => assert.fail('no exited or reused numeric pid may be probed')));
});

test('closed-tree journal rejects a forged resource-release pid despite valid nonce and ordering', async () => {
  const environment = gatewayTestEnvironment(null);
  const nonce = 'synthetic-release-birth';
  const births = { parent: { pid: 101, nonce }, child: { pid: 202, nonce }, grandchild: { pid: 303, nonce } };
  const released = (role) => ({ type: 'released', role, nonce, pid: births[role].pid,
    resourceReleased: true, cwdReleased: true, observedAtNs: '1' });
  const closed = (role, subjectRole) => ({ type: 'closed', role, nonce, pid: births[role].pid,
    subjectRole, subjectPid: births[subjectRole].pid, exitCode: 0, signalCode: null, observedAtNs: '1' });
  const disconnected = (role) => ({ type: 'channel-disconnected', role, nonce, pid: births[role].pid,
    connected: false, observedAtNs: '1' });
  const ordered = [released('grandchild'), disconnected('grandchild'), closed('child', 'grandchild'),
    released('child'), disconnected('child'), closed('parent', 'child'), released('parent'), disconnected('parent')];
  const journal = path.join(environment.HOME, 'tree-events.jsonl');
  const writeJournal = (events) => fs.writeFileSync(journal, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  const state = { nonce, child: {}, messages: [{ type: 'controller-close', pid: births.parent.pid,
    exitCode: 0, signalCode: null, receivedAtNs: '2' }] };
  try {
    writeJournal(ordered);
    assert.doesNotThrow(() => readClosedTree(environment, state, births));
    writeJournal(ordered.map((event, index) => index === 0 ? { ...event, pid: 404 } : event));
    assert.throws(() => readClosedTree(environment, state, births), (error) => {
      assert.equal(error.code, 'ERR_ASSERTION');
      assert.equal(error.actual, 404);
      assert.equal(error.expected, births.grandchild.pid);
      return true;
    });
    assert.throws(() => assertTreeReleaseEvent({ ...ordered[0], nonce: 'wrong-birth' }, births), (error) => {
      assert.equal(error.code, 'ERR_ASSERTION');
      assert.equal(error.actual, 'wrong-birth');
      assert.equal(error.expected, nonce);
      return true;
    });
  } finally { await removeOwnedGatewayTestHome(environment.HOME); }
});

async function closeAndRemoveOwnedTree(environment, state) {
  await closeOwnedTree(state); // Release is unconditionally first, including RED.
  const births = assertTreeBirths(state);
  readClosedTree(environment, state, births);
  const stopped = await stopGatewayChild(state.child);
  assert.equal(stopped, true);
  await removeOwnedGatewayTestHome(environment.HOME, { shutdown: closedTreeShutdown(state, stopped) });
  assert.equal(fs.existsSync(environment.HOME), false);
}

async function exerciseOwnedTree(diagnosticCode, controllerChannelMode) {
  const environment = gatewayTestEnvironment(null);
  const state = startOwnedTree(environment);
  try {
    await waitForTree(state, () => readyTree(state).length === 3);
    const births = assertTreeBirths(state);
    state.child.send(null, () => {});
    state.child.send({ type: 'release', nonce: 'wrong-fixture-nonce' }, () => {});
    state.child.send({ type: 'observe', nonce: state.nonce }, () => {});
    await parentOnlyCompletionCannotRemove(environment, state, births);
    await liveParentDiagnostic(environment, state, diagnosticCode);
    if (controllerChannelMode === 'peer-initiated-controller-channel-closure') {
      state.controllerChannelMode = controllerChannelMode;
      state.controllerDisconnectAck = await requestPeerInitiatedControllerDisconnect(state, births);
      assert.equal(state.controllerDisconnectAck.pid, births.parent.pid);
      assert.equal(state.controllerDisconnectAck.nonce, births.parent.nonce);
      assert.equal(state.child.connected, false);
    } else {
      requestTreeRelease(state);
      requestTreeRelease(state);
    }
    await closeOwnedTree(state);
    readClosedTree(environment, state, births);
    const stopped = await stopGatewayChild(state.child);
    assert.equal(stopped, true);
    const shutdown = closedTreeShutdown(state, stopped);
    const error = await removalDiagnostic(environment.HOME, path.join(environment.HOME, 'parent.work'), shutdown);
    assert.equal(error.details.children[0].liveness.state, 'close-observed');
    assert.equal(error.details.children[0].resourceReleased, true);
    assert.equal(error.details.children[0].stopResult, true);
    assert.equal(error.details.children[0].closeObserved, true);
  } finally {
    await closeAndRemoveOwnedTree(environment, state);
  }
}

test('owned teardown releases cwd and file work across three fresh roots; third uses peer-initiated controller-channel closure', async () => {
  await exerciseOwnedTree(null, 'release-request');
  await exerciseOwnedTree('EPERM', 'release-request');
  // This is PEER-INITIATED controller-channel closure, not an unplanned local ChildProcess.disconnect().
  await exerciseOwnedTree('ESRCH', 'peer-initiated-controller-channel-closure');
});

function createFixtureIpcHarness({ role = 'parent', connected = true, send, disconnect } = {}) {
  const sent = [];
  const journal = [];
  const releases = [];
  const processHandle = {
    connected,
    disconnectCalls: 0,
    send(message, sendHandle, callback) {
      sent.push({ message, sendHandle, callback });
      if (send) return send.call(processHandle, message, sendHandle, callback);
    },
    disconnect() {
      processHandle.disconnectCalls += 1;
      if (disconnect) return disconnect.call(processHandle);
      processHandle.connected = false;
    },
  };
  const handlers = createControllerIpcHandlers({
    processHandle,
    nonce: 'fixture-birth',
    role,
    journalEvent(type, fields = {}) {
      const entry = { type, ...fields };
      journal.push(entry);
      return entry;
    },
    releaseTree() { releases.push('released'); },
  });
  return { handlers, journal, processHandle, releases, sent };
}

test('fixture IPC acknowledgement rejects a disconnected channel and settles send callbacks once', () => {
  const disconnected = createFixtureIpcHarness({ connected: false });
  const disconnectedErrors = [];
  disconnected.handlers.sendAcknowledgementAndWaitForFlush({ type: 'ack' }, (error) => disconnectedErrors.push(error));
  assert.equal(disconnected.sent.length, 0);
  assert.equal(disconnectedErrors.length, 1);
  assert.match(disconnectedErrors[0].message, /already disconnected/);

  const transportFailure = new Error('synthetic IPC callback failure');
  const connected = createFixtureIpcHarness();
  const callbackResults = [];
  connected.handlers.sendAcknowledgementAndWaitForFlush({ type: 'ack' }, (error) => callbackResults.push(error));
  assert.equal(connected.sent.length, 1);
  assert.equal(connected.sent[0].sendHandle, undefined);
  assert.equal(typeof connected.sent[0].callback, 'function');
  connected.sent[0].callback(transportFailure);
  connected.sent[0].callback(null);
  assert.deepEqual(callbackResults, [transportFailure]);
});

test('fixture IPC acknowledgement catches synchronous send throws without settling twice', () => {
  const transportFailure = new Error('synthetic synchronous IPC send failure');
  const harness = createFixtureIpcHarness({ send() { throw transportFailure; } });
  const callbackResults = [];
  harness.handlers.sendAcknowledgementAndWaitForFlush({ type: 'ack' }, (error) => callbackResults.push(error));
  assert.equal(callbackResults.length, 1);
  assert.equal(callbackResults[0], transportFailure);
  harness.sent[0].callback(null);
  assert.deepEqual(callbackResults, [transportFailure]);
});

test('fixture control messages ignore wrong births and unrelated or non-parent requests', () => {
  const parent = createFixtureIpcHarness();
  parent.handlers.receiveControl(null);
  parent.handlers.receiveControl({ type: 'release', nonce: 'forged-birth' });
  parent.handlers.receiveControl({ type: 'unrelated', nonce: 'fixture-birth' });
  assert.deepEqual(parent.sent, []);
  assert.deepEqual(parent.journal, []);
  assert.deepEqual(parent.releases, []);

  parent.handlers.receiveControl({ type: 'release', nonce: 'fixture-birth' });
  assert.deepEqual(parent.releases, ['released']);

  const child = createFixtureIpcHarness({ role: 'child' });
  child.handlers.receiveControl({ type: 'disconnect-controller', nonce: 'fixture-birth' });
  assert.deepEqual(child.sent, []);
  assert.deepEqual(child.journal, []);
  assert.deepEqual(child.releases, []);
});

test('fixture journals the controller ACK before disconnecting and suppresses duplicate requests', () => {
  const harness = createFixtureIpcHarness();
  const request = { type: 'disconnect-controller', nonce: 'fixture-birth' };
  harness.handlers.receiveControl(request);
  assert.equal(harness.journal.length, 1);
  assert.equal(harness.journal[0].type, 'disconnect-controller-ack');
  assert.equal(harness.sent[0].message, harness.journal[0]);
  assert.equal(harness.processHandle.connected, true);
  assert.equal(harness.processHandle.disconnectCalls, 0);

  harness.sent[0].callback(null);
  assert.equal(harness.processHandle.connected, false);
  assert.equal(harness.processHandle.disconnectCalls, 1);
  assert.deepEqual(harness.releases, []);
  harness.handlers.receiveControl(request);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.journal.length, 1);
});

test('fixture releases safely after ACK send errors or a channel lost before flush', () => {
  const transportFailure = new Error('synthetic ACK send callback failure');
  const failedSend = createFixtureIpcHarness();
  failedSend.handlers.receiveControl({ type: 'disconnect-controller', nonce: 'fixture-birth' });
  failedSend.sent[0].callback(transportFailure);
  assert.deepEqual(failedSend.releases, ['released']);
  assert.equal(failedSend.processHandle.connected, true);

  const disconnectedBeforeFlush = createFixtureIpcHarness();
  disconnectedBeforeFlush.handlers.receiveControl({ type: 'disconnect-controller', nonce: 'fixture-birth' });
  disconnectedBeforeFlush.processHandle.connected = false;
  disconnectedBeforeFlush.sent[0].callback(null);
  assert.deepEqual(disconnectedBeforeFlush.releases, ['released']);
});

test('fixture releases safely after a synchronous ACK send or disconnect failure', () => {
  const sendFailure = createFixtureIpcHarness({ send() { throw new Error('synthetic ACK send throw'); } });
  assert.doesNotThrow(() => sendFailure.handlers.receiveControl({ type: 'disconnect-controller', nonce: 'fixture-birth' }));
  assert.deepEqual(sendFailure.releases, ['released']);

  const disconnectFailure = createFixtureIpcHarness({ disconnect() { throw new Error('synthetic disconnect failure'); } });
  disconnectFailure.handlers.receiveControl({ type: 'disconnect-controller', nonce: 'fixture-birth' });
  disconnectFailure.sent[0].callback(null);
  assert.deepEqual(disconnectFailure.releases, ['released']);
});

function createControllerChild({ connected = true, send } = {}) {
  const child = new EventEmitter();
  child.connected = connected;
  child.sent = [];
  child.send = function (message, callback) {
    child.sent.push(message);
    if (send) return send(message, callback);
  };
  return child;
}

function controllerDisconnectScenario(child) {
  const nonce = 'controller-root-birth';
  return {
    state: { child, nonce },
    births: { parent: { pid: 101, nonce } },
    acknowledgement: { type: 'disconnect-controller-ack', role: 'parent', pid: 101, nonce },
  };
}

function assertControllerDisconnectObserversRemoved(child) {
  assert.equal(child.listenerCount('message'), 0);
  assert.equal(child.listenerCount('disconnect'), 0);
  assert.equal(child.listenerCount('error'), 0);
}

test('controller disconnect wait rejects an already-disconnected child without sending', async () => {
  const child = createControllerChild({ connected: false });
  const { state, births } = controllerDisconnectScenario(child);
  await assert.rejects(requestPeerInitiatedControllerDisconnect(state, births), /already disconnected before the request/);
  assert.deepEqual(child.sent, []);
  assertControllerDisconnectObserversRemoved(child);
});

test('controller disconnect wait ignores unrelated messages and accepts EOF before its READY-bound ACK', async () => {
  let sendCallback;
  const child = createControllerChild({ send(_message, callback) { sendCallback = callback; } });
  const { state, births, acknowledgement } = controllerDisconnectScenario(child);
  const pending = requestPeerInitiatedControllerDisconnect(state, births);
  assert.equal(child.sent.length, 1);
  sendCallback(null);
  child.emit('message', { type: 'unrelated', role: 'parent', pid: 101, nonce: state.nonce });
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  child.connected = false;
  child.emit('disconnect');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'EOF without an ACK is not proof of the request');
  child.emit('message', acknowledgement);
  assert.deepEqual(await pending, acknowledgement);
  assertControllerDisconnectObserversRemoved(child);
});

test('controller disconnect wait rejects forged and duplicate ACKs', async () => {
  for (const forgedFields of [{ pid: 202 }, { nonce: 'forged-root-birth' }]) {
    const forgedChild = createControllerChild();
    const forged = controllerDisconnectScenario(forgedChild);
    const forgedRejection = assert.rejects(
      requestPeerInitiatedControllerDisconnect(forged.state, forged.births),
      /does not match READY root birth/);
    forgedChild.emit('message', { ...forged.acknowledgement, ...forgedFields });
    await forgedRejection;
    assertControllerDisconnectObserversRemoved(forgedChild);
  }

  const duplicateChild = createControllerChild();
  const duplicate = controllerDisconnectScenario(duplicateChild);
  const duplicateRejection = assert.rejects(
    requestPeerInitiatedControllerDisconnect(duplicate.state, duplicate.births),
    /was duplicated/);
  duplicateChild.emit('message', duplicate.acknowledgement);
  duplicateChild.emit('message', duplicate.acknowledgement);
  await duplicateRejection;
  assertControllerDisconnectObserversRemoved(duplicateChild);
});

test('controller disconnect wait rejects ChildProcess errors and a disconnect event that leaves IPC connected', async () => {
  const errorChild = createControllerChild();
  const errorScenario = controllerDisconnectScenario(errorChild);
  const childFailure = new Error('synthetic child process error');
  const errorRejection = assert.rejects(
    requestPeerInitiatedControllerDisconnect(errorScenario.state, errorScenario.births),
    (error) => error === childFailure);
  errorChild.emit('error', childFailure);
  await errorRejection;
  assertControllerDisconnectObserversRemoved(errorChild);

  const child = createControllerChild();
  const { state, births } = controllerDisconnectScenario(child);
  const rejection = assert.rejects(
    requestPeerInitiatedControllerDisconnect(state, births),
    /did not clear connected state/);
  child.emit('disconnect');
  await rejection;
  assertControllerDisconnectObserversRemoved(child);
});

test('controller disconnect wait preserves send callback errors and synchronous send throws', async () => {
  let sendCallback;
  const callbackChild = createControllerChild({ send(_message, callback) { sendCallback = callback; } });
  const callbackScenario = controllerDisconnectScenario(callbackChild);
  const callbackFailure = new Error('synthetic controller send callback failure');
  const callbackRejection = assert.rejects(
    requestPeerInitiatedControllerDisconnect(callbackScenario.state, callbackScenario.births),
    (error) => error === callbackFailure);
  sendCallback(callbackFailure);
  sendCallback(new Error('later callback must not replace the first failure'));
  await callbackRejection;
  assertControllerDisconnectObserversRemoved(callbackChild);

  const syncChild = createControllerChild({ send() { throw new Error('synthetic controller send throw'); } });
  const syncScenario = controllerDisconnectScenario(syncChild);
  await assert.rejects(
    requestPeerInitiatedControllerDisconnect(syncScenario.state, syncScenario.births),
    /synthetic controller send throw/);
  assertControllerDisconnectObserversRemoved(syncChild);
});

test('recorded PID parser preserves Number(trim()) || null semantics with only a stub filesystem', () => {
  const home = '/synthetic-owned-home';
  const name = 'shim';
  const file = path.join(home, '.claude', 'model-gateway', `${name}.pid`);
  const cases = [
    { name: 'valid decimal', contents: '314', expected: 314 },
    { name: 'surrounding whitespace', contents: ' \t+42 \n', expected: 42 },
    { name: 'zero', contents: '0', expected: null },
    { name: 'empty', contents: '', expected: null },
    { name: 'NaN', contents: 'not-a-pid', expected: null },
    { name: 'exponent notation', contents: '1e3', expected: 1000 },
  ];
  for (const scenario of cases) {
    const reads = [];
    const fsImpl = { readFileSync(readPath, encoding) {
      reads.push([readPath, encoding]);
      return scenario.contents;
    } };
    assert.equal(readRecordedGatewayPid(home, name, fsImpl), scenario.expected, scenario.name);
    assert.deepEqual(reads, [[file, 'utf8']], `${scenario.name} reads only the requested PID file`);
  }

  const failure = Object.assign(new Error('synthetic PID-file read failure'), { code: 'EIO' });
  const reads = [];
  const failingFs = { readFileSync(readPath, encoding) {
    reads.push([readPath, encoding]);
    throw failure;
  } };
  assert.equal(readRecordedGatewayPid(home, name, failingFs), null);
  assert.deepEqual(reads, [[file, 'utf8']], 'read errors use the same exact path and utf8 encoding');
});
