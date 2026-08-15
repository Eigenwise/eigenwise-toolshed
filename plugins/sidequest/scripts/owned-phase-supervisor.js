'use strict';

const { spawn } = require('node:child_process');

const defaultTerminationGraceMilliseconds = 300;

// Spawned detached, so setsid() has already made this process the leader of a fresh group
// whose id is its own pid. Ordinary descendants of the trusted phase command inherit that
// group. A command that deliberately creates another session leaves the portable ownership
// boundary and is unsupported. Outliving the phase is the entire reason this owner exists:
// while any member remains, the group id cannot be reissued to an unrelated process.
const ownedGroupId = process.pid;

// The sweep below raises SIGTERM across the group, this process included. Dying there
// would unpin the group id halfway through cleanup, so these handlers exist only to
// survive it. They cannot swallow cleanup: the sweep ends in SIGKILL, which no handler
// can refuse, and this process is meant to die there.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => {});

// Nothing else keeps the loop alive between the phase exiting and the parent asking for
// cleanup, and an owner that quietly exits in that window is an owner that stopped owning.
const ownershipHold = setInterval(() => {}, 3_600_000);

let phase = null;
let phaseReported = false;
let cleanupStarted = false;

function report(message) {
  if (!process.connected) return false;
  try {
    process.send(message);
    return true;
  } catch {
    return false;
  }
}

function signalOwnedGroup(signal) {
  try {
    process.kill(-ownedGroupId, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') report({ type: 'signal-error', signal, code: error.code ?? null });
  }
}

function reportPhaseExit(status, signal) {
  if (phaseReported) return;
  phaseReported = true;
  report({ type: 'phase-exit', status, signal });
}

function reportPhaseError(error) {
  if (phaseReported) return;
  phaseReported = true;
  report({
    type: 'phase-error',
    message: error.message,
    code: error.code ?? null,
    errno: error.errno ?? null,
    syscall: error.syscall ?? null,
    path: error.path ?? null,
  });
}

function startPhase(request) {
  if (phase !== null || cleanupStarted) return;
  phase = spawn(request.command, request.args ?? [], {
    cwd: request.cwd ?? undefined,
    env: request.env ?? undefined,
    // The phase writes straight down the pipes the parent is already reading, so its
    // output arrives byte for byte and nothing it prints can be mistaken for a control
    // frame: those travel on the separate IPC channel.
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  if (typeof phase.pid === 'number') report({ type: 'phase-started', pid: phase.pid });
  phase.once('error', reportPhaseError);
  phase.once('exit', reportPhaseExit);
}

// Only the parent decides when the answer is safe to destroy, so a sweep can never race
// ahead of the phase result the gate is still waiting to read.
function startCleanup(terminationGraceMilliseconds) {
  if (cleanupStarted) return;
  cleanupStarted = true;
  clearInterval(ownershipHold);
  signalOwnedGroup('SIGTERM');
  setTimeout(() => signalOwnedGroup('SIGKILL'), terminationGraceMilliseconds);
}

process.on('message', (message) => {
  if (message?.type === 'start') startPhase(message);
  else if (message?.type === 'cleanup') startCleanup(message.terminationGraceMilliseconds ?? defaultTerminationGraceMilliseconds);
});

// A parent that died without asking still leaves a live tree nobody is reading.
process.on('disconnect', () => startCleanup(defaultTerminationGraceMilliseconds));
