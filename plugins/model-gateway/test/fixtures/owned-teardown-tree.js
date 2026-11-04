'use strict';

// Synthetic teardown proof, not a reproduction or a fix of any particular EBUSY.
// Every process and every file belongs to one nonce-bound disposable fixture.
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');

function createControllerIpcHandlers({ processHandle, nonce, role, journalEvent, releaseTree }) {
  let controllerDisconnectRequested = false;

  function sendAcknowledgementAndWaitForFlush(message, callback) {
    if (!processHandle.connected) {
      callback(new Error('fixture IPC channel is already disconnected'));
      return;
    }
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      callback(error);
    };
    try { processHandle.send(message, undefined, finish); } catch (error) { finish(error); }
  }

  function handleAcknowledgementFlush(error) {
    if (error) {
      releaseTree();
      return;
    }
    if (!processHandle.connected) {
      releaseTree();
      return;
    }
    try { processHandle.disconnect(); } catch { releaseTree(); }
  }

  function acknowledgeThenDisconnectController() {
    const acknowledgement = journalEvent('disconnect-controller-ack');
    sendAcknowledgementAndWaitForFlush(acknowledgement, handleAcknowledgementFlush);
  }

  function isParentDisconnectControllerRequest(message) {
    return role === 'parent' && message.type === 'disconnect-controller';
  }

  function receiveControl(message) {
    if (message?.nonce !== nonce) return;
    if (message.type === 'release') {
      releaseTree();
      return;
    }
    if (!isParentDisconnectControllerRequest(message) || controllerDisconnectRequested) return;
    controllerDisconnectRequested = true;
    acknowledgeThenDisconnectController();
  }

  return { receiveControl, sendAcknowledgementAndWaitForFlush };
}

function runFixture() {
  const configuration = JSON.parse(process.argv[2]);
  const { home, nonce, role } = configuration;
  const roles = ['parent', 'child', 'grandchild'];
  const nextRole = roles[roles.indexOf(role) + 1];
  const journal = path.join(home, 'tree-events.jsonl');
  const work = fs.openSync(path.join(home, `${role}.work`), 'a');
  fs.writeSync(work, `${role}\n`);
  const workTimer = setInterval(() => fs.writeSync(work, '.'), 20);
  let descendant = null;
  let descendantClosed = !nextRole;
  let releaseRequested = false;
  let released = false;

  function sendToParent(message) {
    if (process.connected) process.send(message, () => {});
  }

  function journalEvent(type, fields = {}) {
    const message = { type, role, nonce, pid: process.pid, parentPid: process.ppid,
      observedAtNs: process.hrtime.bigint().toString(), ...fields };
    fs.appendFileSync(journal, JSON.stringify(message) + '\n');
    return message;
  }

  function record(type, fields = {}) {
    const message = journalEvent(type, fields);
    sendToParent(message);
    return message;
  }

  function finishWhenDescendantClosed() {
    if (!releaseRequested || !descendantClosed || released) return;
    released = true;
    clearInterval(workTimer);
    fs.closeSync(work);
    process.chdir(path.dirname(home));
    record('released', { resourceReleased: true, cwdReleased: true });
    if (process.connected) process.disconnect();
  }

  function releaseTree() {
    releaseRequested = true;
    if (descendant?.connected) descendant.send({ type: 'release', nonce }, () => {});
    finishWhenDescendantClosed();
  }

  const controllerIpcHandlers = createControllerIpcHandlers({
    processHandle: process,
    nonce,
    role,
    journalEvent,
    releaseTree,
  });

  function observeDescendantClose(code, signal) {
    descendantClosed = true;
    record('closed', { subjectRole: nextRole, subjectPid: descendant.pid,
      exitCode: code, signalCode: signal });
    finishWhenDescendantClosed();
  }

  function startDescendant() {
    const log = fs.openSync(path.join(home, 'tree.log'), 'a');
    try {
      descendant = fork(__filename, [JSON.stringify({ home, nonce, role: nextRole })], {
        cwd: home, env: process.env, stdio: ['ignore', log, log, 'ipc'],
      });
    } finally { fs.closeSync(log); }
    descendant.on('message', sendToParent);
    descendant.once('close', observeDescendantClose);
    descendant.once('error', releaseTree);
  }

  function handleChannelDisconnected() {
    record('channel-disconnected', { connected: process.connected });
    releaseTree();
  }

  process.on('message', controllerIpcHandlers.receiveControl);
  process.once('disconnect', handleChannelDisconnected);
  if (nextRole) startDescendant();
  record('ready', { cwdIsOwnedRoot: fs.realpathSync.native(process.cwd()) === fs.realpathSync.native(home), resourceReleased: false });
  finishWhenDescendantClosed();
}

if (require.main === module) runFixture();

module.exports = { createControllerIpcHandlers };
