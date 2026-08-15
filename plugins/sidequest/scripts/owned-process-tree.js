'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const platformUsesProcessGroups = process.platform !== 'win32';
const defaultSupervisorModulePath = path.join(__dirname, 'owned-phase-supervisor.js');
const defaultTerminationGraceMilliseconds = 300;
const defaultCleanupDrainMilliseconds = 500;
const defaultRetainedOutputBytes = 64 * 1024;

function readProcfsStateCharacter(processId) {
  let statLine;
  try {
    statLine = fs.readFileSync(`/proc/${processId}/stat`, 'utf8');
  } catch {
    return null;
  }
  // The command field is parenthesized and may itself contain spaces and parens, so the
  // state character is the first field after the LAST closing paren, never field three of
  // a naive split.
  const commandFieldEnd = statLine.lastIndexOf(') ');
  if (commandFieldEnd === -1) return null;
  return statLine.charAt(commandFieldEnd + 2) || null;
}

function readPsStateCharacter(processId) {
  const probe = spawnSync('ps', ['-o', 'state=', '-p', String(processId)], { encoding: 'utf8', windowsHide: true });
  if (probe.error || probe.status !== 0) return null;
  return probe.stdout.trim().charAt(0) || null;
}

/**
 * Answers what a process id currently is, for code deciding whether something leaked:
 * 'gone', 'zombie', or 'live'.
 *
 * `kill(pid, 0)` cannot answer this by itself. A terminated child keeps its pid probeable
 * until somebody reaps it, and a container whose PID 1 never reaps leaves it that way for
 * good. A zombie has already run its last instruction, so it cannot write a file, spawn
 * anything or take work: it is terminal. Anything whose state cannot be read stays 'live',
 * because hiding a genuinely runnable orphan is the worse failure.
 */
function classifyProcessState(processId) {
  try {
    process.kill(processId, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return 'gone';
    // EPERM proves the pid belongs to a process outside our privileges. It exists.
    if (error.code === 'EPERM') return 'live';
    throw error;
  }
  if (!platformUsesProcessGroups) return 'live';
  const stateCharacter = readProcfsStateCharacter(processId) ?? readPsStateCharacter(processId);
  return stateCharacter === 'Z' || stateCharacter === 'X' ? 'zombie' : 'live';
}

function isProcessTerminal(processId) {
  return classifyProcessState(processId) !== 'live';
}

function processGroupExists(groupId) {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

function classifyProcessGroupState(groupId) {
  if (!processGroupExists(groupId)) return 'gone';

  const probe = spawnSync('ps', ['-A', '-o', 'pgid=', '-o', 'state='], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 100,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (probe.error || probe.status !== 0) return 'live';

  let foundMember = false;
  for (const line of probe.stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+([A-Za-z])/);
    if (match === null || Number(match[1]) !== groupId) continue;
    foundMember = true;
    if (match[2] !== 'Z' && match[2] !== 'X') return 'live';
  }
  if (foundMember) return 'zombie';
  return processGroupExists(groupId) ? 'live' : 'gone';
}

function createBoundedOutputCollector(retainedOutputBytes, forward) {
  const retainedChunks = [];
  let retainedBytes = 0;
  let totalBytes = 0;
  return {
    append(chunk) {
      totalBytes += chunk.length;
      forward(chunk);
      retainedChunks.push(chunk);
      retainedBytes += chunk.length;
      while (retainedChunks.length > 1 && retainedBytes - retainedChunks[0].length >= retainedOutputBytes) {
        retainedBytes -= retainedChunks.shift().length;
      }
    },
    totalBytes: () => totalBytes,
    tail() {
      const retained = Buffer.concat(retainedChunks, retainedBytes);
      return retained.subarray(Math.max(0, retained.length - retainedOutputBytes)).toString('utf8');
    },
  };
}

function normalizeOptions(options) {
  return {
    command: options.command,
    args: options.args ?? [],
    cwd: options.cwd,
    env: options.env,
    timeoutMilliseconds: options.timeoutMilliseconds ?? null,
    retainedOutputBytes: options.retainedOutputBytes ?? defaultRetainedOutputBytes,
    terminationGraceMilliseconds: options.terminationGraceMilliseconds ?? defaultTerminationGraceMilliseconds,
    cleanupDrainMilliseconds: options.cleanupDrainMilliseconds ?? defaultCleanupDrainMilliseconds,
    supervisorModulePath: options.supervisorModulePath ?? defaultSupervisorModulePath,
    forwardStdout: options.forwardStdout ?? ((chunk) => process.stdout.write(chunk)),
    forwardStderr: options.forwardStderr ?? ((chunk) => process.stderr.write(chunk)),
    onPhaseStarted: options.onPhaseStarted ?? (() => {}),
  };
}

function restoreReportedError(message) {
  const error = new Error(message.message);
  if (message.code !== null) error.code = message.code;
  if (message.errno !== null) error.errno = message.errno;
  if (message.syscall !== null) error.syscall = message.syscall;
  if (message.path !== null) error.path = message.path;
  return error;
}

/**
 * POSIX has no portable kernel object binding an arbitrary subtree to its parent, so the
 * supported ownership boundary is the process group inherited by ordinary descendants of a
 * trusted test command. A command that deliberately creates a new session leaves that boundary.
 * The detached supervisor leads the owned group and stays alive through ordinary cleanup; if it
 * crashes, any remaining member still reserves the exact group id until the group is terminal.
 */
function runSupervisedPhase(options) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const stdout = createBoundedOutputCollector(options.retainedOutputBytes, options.forwardStdout);
    const stderr = createBoundedOutputCollector(options.retainedOutputBytes, options.forwardStderr);
    const supervisor = spawn(process.execPath, [options.supervisorModulePath], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
      detached: true,
    });
    const ownedGroupId = typeof supervisor.pid === 'number' ? supervisor.pid : null;

    let settled = false;
    let timedOut = false;
    let phasePid = null;
    let phaseStatus = null;
    let phaseSignal = null;
    let phaseError = null;
    let supervisorSpawnError = null;
    let supervisorExited = false;
    let cleanupRequestedAt = null;
    let cleanupError = null;
    let outputDrainTimedOut = false;
    let unexpectedSignalErrorCode = null;
    let nextCleanupSignalErrorIndex = 0;
    let protocolFailed = false;
    let supervisorProtocolState = 'initial';
    let protocolError = null;
    let ownedGroupState = ownedGroupId === null ? 'gone' : 'live';
    let ownedGroupTerminalAt = null;
    // The control channel counts as a channel to drain. A supervisor killed by its own
    // sweep can have a phase result still in flight, and settling on process death alone
    // would throw away the status the gate is being asked to report.
    let openChannelCount = 3;
    let deadlineTimer = null;
    let killEscalationTimer = null;
    let groupStateTimer = null;
    let settleDeadlineTimer = null;

    // Any process that remains in this exact group reserves the id. Once the group becomes
    // terminal we stop signalling it, before the kernel can make the number reusable.
    function signalOwnedGroup(signal) {
      if (ownedGroupId === null || ownedGroupState !== 'live') return false;
      try {
        process.kill(-ownedGroupId, signal);
        return true;
      } catch (error) {
        if (error.code === 'ESRCH') {
          ownedGroupState = 'gone';
          ownedGroupTerminalAt = ownedGroupTerminalAt ?? performance.now();
        } else if (error.code !== 'EPERM') {
          unexpectedSignalErrorCode = error.code;
        }
        return false;
      }
    }

    function sendToSupervisor(message) {
      if (!supervisor.connected) return false;
      try {
        supervisor.send(message);
        return true;
      } catch {
        return false;
      }
    }

    function sweepOnParentExit() {
      signalOwnedGroup('SIGKILL');
    }

    process.once('exit', sweepOnParentExit);

    function settle() {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(killEscalationTimer);
      clearTimeout(groupStateTimer);
      clearTimeout(settleDeadlineTimer);
      process.removeListener('exit', sweepOnParentExit);
      supervisor.stdout?.destroy();
      supervisor.stderr?.destroy();
      if (supervisor.connected) supervisor.disconnect();
      supervisor.unref();
      resolve({
        status: phaseStatus,
        signal: phaseSignal,
        error: supervisorSpawnError ?? protocolError ?? phaseError,
        timedOut,
        cleanupError,
        outputDrainTimedOut,
        durationMilliseconds: performance.now() - startedAt,
        terminationLatencyMilliseconds:
          cleanupRequestedAt !== null && ownedGroupTerminalAt !== null ? ownedGroupTerminalAt - cleanupRequestedAt : null,
        ownerPid: ownedGroupId,
        ownedGroupId,
        phasePid,
        unexpectedSignalErrorCode,
        stdout: stdout.tail(),
        stderr: stderr.tail(),
        stdoutBytes: stdout.totalBytes(),
        stderrBytes: stderr.totalBytes(),
      });
    }

    function appendCleanupError(message) {
      cleanupError = cleanupError === null ? message : `${cleanupError} ${message}`;
    }

    function refreshOwnedGroupState() {
      if (ownedGroupId === null || ownedGroupState !== 'live') return ownedGroupState;
      try {
        ownedGroupState = classifyProcessGroupState(ownedGroupId);
      } catch (error) {
        unexpectedSignalErrorCode = unexpectedSignalErrorCode ?? error.code ?? 'GROUP_STATE_PROBE_FAILED';
        ownedGroupState = 'live';
      }
      if (ownedGroupState !== 'live') ownedGroupTerminalAt = ownedGroupTerminalAt ?? performance.now();
      return ownedGroupState;
    }

    function settleWhenDrained() {
      if (!supervisorExited || openChannelCount > 0) return;
      if (cleanupRequestedAt !== null && refreshOwnedGroupState() === 'live') {
        if (groupStateTimer === null) {
          groupStateTimer = setTimeout(() => {
            groupStateTimer = null;
            settleWhenDrained();
          }, 20);
        }
        return;
      }
      settle();
    }

    function armSettleDeadline(milliseconds) {
      if (settleDeadlineTimer !== null) return;
      settleDeadlineTimer = setTimeout(() => {
        const groupState = refreshOwnedGroupState();
        if (groupState === 'live') {
          appendCleanupError(
            `The owned process group ${ownedGroupId} remained live ${milliseconds}ms after cleanup started; SIGTERM and SIGKILL did not make it terminal.`,
          );
        } else if (openChannelCount > 0) {
          outputDrainTimedOut = true;
        }
        settle();
      }, milliseconds);
    }

    function requestCleanup() {
      if (cleanupRequestedAt !== null) return;
      cleanupRequestedAt = performance.now();
      clearTimeout(deadlineTimer);
      // The supervisor normally runs the sweep, while the parent owns the escalation clock.
      // If the supervisor crashed, the surviving group members still reserve this exact id,
      // so the same signals remain confined to the owned group.
      if (!sendToSupervisor({ type: 'cleanup', terminationGraceMilliseconds: options.terminationGraceMilliseconds })) {
        signalOwnedGroup('SIGTERM');
      }
      killEscalationTimer = setTimeout(() => signalOwnedGroup('SIGKILL'), options.terminationGraceMilliseconds);
      armSettleDeadline(options.terminationGraceMilliseconds + options.cleanupDrainMilliseconds);
    }

    supervisor.stdout.on('data', (chunk) => stdout.append(chunk));
    supervisor.stderr.on('data', (chunk) => stderr.append(chunk));
    supervisor.stdout.once('close', () => {
      openChannelCount -= 1;
      settleWhenDrained();
    });
    supervisor.stderr.once('close', () => {
      openChannelCount -= 1;
      settleWhenDrained();
    });
    supervisor.once('disconnect', () => {
      openChannelCount -= 1;
      settleWhenDrained();
    });

    function failSupervisorProtocol(reason) {
      if (protocolFailed) return;
      protocolFailed = true;
      supervisorProtocolState = 'failed';
      protocolError = new Error(`The phase owner sent invalid control data: ${reason}.`);
      protocolError.code = 'EPROTO';
      requestCleanup();
    }

    function isNullableString(value) {
      return value === null || typeof value === 'string';
    }

    function isPhaseError(message) {
      return (
        typeof message.message === 'string'
        && isNullableString(message.code)
        && (message.errno === null || typeof message.errno === 'number' || typeof message.errno === 'string')
        && isNullableString(message.syscall)
        && isNullableString(message.path)
      );
    }

    function isPhaseExit(message) {
      const statusIsValid = message.status === null || Number.isInteger(message.status);
      const signalIsValid = isNullableString(message.signal);
      return statusIsValid && signalIsValid && (message.status === null) !== (message.signal === null);
    }

    function isPhaseStarted(message) {
      return Number.isInteger(message.pid) && message.pid > 0;
    }

    function startTerminalSettlement() {
      supervisorProtocolState = 'terminal';
      requestCleanup();
    }

    function hasExactFields(message, fields) {
      const messageFields = Object.keys(message).sort();
      return messageFields.length === fields.length && messageFields.every((field, index) => field === fields[index]);
    }

    function isSignalError(message) {
      return (
        hasExactFields(message, ['code', 'signal', 'type'])
        && (message.code === null || typeof message.code === 'string')
        && typeof message.signal === 'string'
      );
    }

    function recordSignalError(message) {
      if (!isSignalError(message)) {
        failSupervisorProtocol('signal-error did not contain exactly type, signal, and nullable string code');
        return;
      }
      const expectedSignal = ['SIGTERM', 'SIGKILL'][nextCleanupSignalErrorIndex];
      if (message.signal !== expectedSignal) {
        failSupervisorProtocol(`signal-error reported ${JSON.stringify(message.signal)} when ${JSON.stringify(expectedSignal ?? 'no further cleanup signal')} was expected`);
        return;
      }
      nextCleanupSignalErrorIndex += 1;
      unexpectedSignalErrorCode = unexpectedSignalErrorCode ?? message.code;
      appendCleanupError(
        message.code === null
          ? `The phase owner could not send ${message.signal} to its owned process group.`
          : `The phase owner could not send ${message.signal} to its owned process group: ${message.code}.`,
      );
    }

    function handleSupervisorMessage(message) {
      if (protocolFailed) return;
      if (message === null || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
        failSupervisorProtocol('the message was not an object with a string type');
        return;
      }
      if (supervisorProtocolState === 'terminal') {
        if (message.type === 'signal-error') recordSignalError(message);
        else failSupervisorProtocol(`received ${JSON.stringify(message.type)} after terminal settlement started`);
        return;
      }
      if (supervisorProtocolState === 'initial') {
        if (message.type === 'phase-started') {
          if (!isPhaseStarted(message)) {
            failSupervisorProtocol('phase-started did not contain one positive process id');
            return;
          }
          phasePid = message.pid;
          supervisorProtocolState = 'running';
          try {
            options.onPhaseStarted({ ownerPid: ownedGroupId, ownedGroupId, phasePid });
          } catch (error) {
            phaseError = error instanceof Error ? error : new Error(String(error));
            startTerminalSettlement();
          }
          return;
        }
        if (message.type === 'phase-error') {
          if (!isPhaseError(message)) {
            failSupervisorProtocol('phase-error was incomplete');
            return;
          }
          phaseError = restoreReportedError(message);
          startTerminalSettlement();
          return;
        }
        failSupervisorProtocol(`initial state cannot accept ${JSON.stringify(message.type)}`);
        return;
      }
      if (supervisorProtocolState === 'running') {
        if (message.type === 'phase-exit') {
          if (!isPhaseExit(message)) {
            failSupervisorProtocol('phase-exit did not contain exactly one status or signal');
            return;
          }
          phaseStatus = message.status;
          phaseSignal = message.signal;
          startTerminalSettlement();
          return;
        }
        if (message.type === 'phase-error') {
          if (!isPhaseError(message)) {
            failSupervisorProtocol('phase-error was incomplete');
            return;
          }
          phaseError = restoreReportedError(message);
          startTerminalSettlement();
          return;
        }
        failSupervisorProtocol(`running state cannot accept ${JSON.stringify(message.type)}`);
        return;
      }
      failSupervisorProtocol(`control data arrived after ${JSON.stringify(supervisorProtocolState)} settlement started`);
    }

    supervisor.on('message', (message) => {
      try {
        handleSupervisorMessage(message);
      } catch (error) {
        failSupervisorProtocol(error instanceof Error ? error.message : String(error));
      }
    });

    supervisor.once('error', (error) => {
      supervisorSpawnError = error;
      supervisorExited = true;
      openChannelCount = 0;
      settle();
    });

    supervisor.once('exit', (status, signal) => {
      supervisorExited = true;
      if (cleanupRequestedAt === null) {
        appendCleanupError(
          `The phase owner exited unexpectedly (status ${status}, signal ${signal}); its still-pinned process group was terminated.`,
        );
        requestCleanup();
      }
      settleWhenDrained();
    });

    sendToSupervisor({
      type: 'start',
      command: options.command,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
    });

    if (options.timeoutMilliseconds !== null) {
      // A deadline is a failed phase whichever way the root behaves next, so termination
      // starts here and escalates on its own clock. Waiting for the root's exit event to
      // begin escalation is what let a root ignoring SIGTERM hang the gate forever.
      deadlineTimer = setTimeout(() => {
        timedOut = true;
        supervisorProtocolState = 'terminal';
        requestCleanup();
      }, options.timeoutMilliseconds);
    }
  });
}

/**
 * Windows binds the subtree for us. libuv assigns every non-detached child to a job object
 * carrying kill-on-close whose only handle belongs to that child, so ending the root
 * through the live handle we already hold closes the job and takes its descendants with
 * it, measured at roughly 9ms with no helper process and no process id to get wrong.
 */
function runDirectlyOwnedPhase(options) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const stdout = createBoundedOutputCollector(options.retainedOutputBytes, options.forwardStdout);
    const stderr = createBoundedOutputCollector(options.retainedOutputBytes, options.forwardStderr);
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let settled = false;
    let timedOut = false;
    let childExited = false;
    let childExitedAt = null;
    let phaseStatus = null;
    let phaseSignal = null;
    let spawnError = null;
    let terminationRequestedAt = null;
    let cleanupError = null;
    let outputDrainTimedOut = false;
    let openStreamCount = 2;
    let deadlineTimer = null;
    let killEscalationTimer = null;
    let settleDeadlineTimer = null;

    function sweepOnParentExit() {
      if (!childExited) child.kill();
    }

    process.once('exit', sweepOnParentExit);

    function settle() {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(killEscalationTimer);
      clearTimeout(settleDeadlineTimer);
      process.removeListener('exit', sweepOnParentExit);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      resolve({
        status: phaseStatus,
        signal: phaseSignal,
        error: spawnError,
        timedOut,
        cleanupError,
        outputDrainTimedOut,
        durationMilliseconds: performance.now() - startedAt,
        terminationLatencyMilliseconds:
          terminationRequestedAt !== null && childExitedAt !== null ? childExitedAt - terminationRequestedAt : null,
        ownerPid: child.pid ?? null,
        ownedGroupId: null,
        phasePid: child.pid ?? null,
        unexpectedSignalErrorCode: null,
        stdout: stdout.tail(),
        stderr: stderr.tail(),
        stdoutBytes: stdout.totalBytes(),
        stderrBytes: stderr.totalBytes(),
      });
    }

    function settleWhenDrained() {
      if (!childExited) return;
      if (openStreamCount === 0) settle();
    }

    function armSettleDeadline(milliseconds) {
      if (settleDeadlineTimer !== null) return;
      settleDeadlineTimer = setTimeout(() => {
        if (!childExited) {
          cleanupError = `The owned phase root ${child.pid} was still alive ${milliseconds}ms after termination started.`;
        } else if (openStreamCount > 0) {
          outputDrainTimedOut = true;
        }
        settle();
      }, milliseconds);
    }

    function terminateOwnedTree() {
      if (terminationRequestedAt !== null) return;
      terminationRequestedAt = performance.now();
      clearTimeout(deadlineTimer);
      child.kill();
      killEscalationTimer = setTimeout(() => {
        if (!childExited) child.kill('SIGKILL');
      }, options.terminationGraceMilliseconds);
      armSettleDeadline(options.terminationGraceMilliseconds + options.cleanupDrainMilliseconds);
    }

    child.stdout.on('data', (chunk) => stdout.append(chunk));
    child.stderr.on('data', (chunk) => stderr.append(chunk));
    child.stdout.once('close', () => {
      openStreamCount -= 1;
      settleWhenDrained();
    });
    child.stderr.once('close', () => {
      openStreamCount -= 1;
      settleWhenDrained();
    });

    child.once('error', (error) => {
      spawnError = error;
      childExited = true;
      openStreamCount = 0;
      settle();
    });

    child.once('exit', (status, signal) => {
      childExited = true;
      childExitedAt = performance.now();
      phaseStatus = status;
      phaseSignal = signal;
      clearTimeout(deadlineTimer);
      armSettleDeadline(options.cleanupDrainMilliseconds);
      settleWhenDrained();
    });

    if (typeof child.pid === 'number') {
      options.onPhaseStarted({ ownerPid: child.pid, ownedGroupId: null, phasePid: child.pid });
    }

    if (options.timeoutMilliseconds !== null) {
      deadlineTimer = setTimeout(() => {
        timedOut = true;
        terminateOwnedTree();
      }, options.timeoutMilliseconds);
    }
  });
}

/**
 * Runs one gate phase as a tree this process owns and settles within
 * `timeoutMilliseconds + terminationGraceMilliseconds + cleanupDrainMilliseconds`, with
 * `cleanupError` set when the platform failed to end the tree. `timedOut` means the
 * deadline ended the phase: it is a failure on its own, whatever status or signal the root
 * managed to deliver on the way out.
 */
function runOwnedPhase(rawOptions) {
  const options = normalizeOptions(rawOptions);
  return platformUsesProcessGroups ? runSupervisedPhase(options) : runDirectlyOwnedPhase(options);
}

module.exports = {
  classifyProcessState,
  isProcessTerminal,
  runOwnedPhase,
};
