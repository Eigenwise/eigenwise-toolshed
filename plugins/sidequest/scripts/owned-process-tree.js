'use strict';

const { spawn, spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { addAbortListener } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const platformUsesProcessGroups = process.platform !== 'win32';
const defaultSupervisorModulePath = path.join(__dirname, 'owned-phase-supervisor.js');
const windowsJobOwnerSourcePath = path.join(__dirname, 'windows-job-owner.cs');
const jobOwnerCompileTimeoutMilliseconds = 120_000;
const win32FileNotFoundCodes = new Set([2, 3]);
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
  // 0 and negatives are not process ids: `kill` reads them as the current or a named process
  // group, so probing one answers a different question than the caller asked and answers it
  // affirmatively. On win32 `process.kill(0, 0)` simply succeeds, which made a caller holding an
  // unparsed pid wait out its whole budget and then report a live process that never existed
  // (SQ-2195). Refuse rather than guess.
  if (!Number.isInteger(processId) || processId <= 0) {
    throw new Error(`${processId} is not a process id, so its state cannot be classified.`);
  }
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

function normalizeOptions(rawOptions) {
  const options = {
    args: [],
    timeoutMilliseconds: null,
    retainedOutputBytes: defaultRetainedOutputBytes,
    terminationGraceMilliseconds: defaultTerminationGraceMilliseconds,
    cleanupDrainMilliseconds: defaultCleanupDrainMilliseconds,
    supervisorModulePath: defaultSupervisorModulePath,
    forwardStdout: (chunk) => process.stdout.write(chunk),
    forwardStderr: (chunk) => process.stderr.write(chunk),
    onPhaseStarted: () => {},
  };
  for (const name of Object.keys(options)) options[name] = rawOptions[name] ?? options[name];
  return { ...options, command: rawOptions.command, cwd: rawOptions.cwd, env: rawOptions.env, signal: rawOptions.signal };
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

    function armDeadline() {
      if (options.timeoutMilliseconds === null || deadlineTimer !== null) return;
      deadlineTimer = setTimeout(() => {
        timedOut = true;
        startTimeoutSettlement();
      }, options.timeoutMilliseconds);
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

    function startTimeoutSettlement() {
      supervisorProtocolState = supervisorProtocolState === 'running' ? 'timed-out-awaiting-phase-exit' : 'terminal';
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
      if (supervisorProtocolState === 'timed-out-awaiting-phase-exit') {
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
        if (message.type === 'signal-error') {
          recordSignalError(message);
          return;
        }
        failSupervisorProtocol(`timeout cleanup cannot accept ${JSON.stringify(message.type)} after phase start`);
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
            return;
          }
          armDeadline();
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

  });
}

/**
 * The Windows leaf is the job owner from runJobOwnedPhase. Closing its stdin asks it to account
 * for its job and exit, which closes the Job Object holding every descendant; the SIGKILL
 * escalation on the retained ChildProcess handle covers an owner that does not, since its
 * death closes the job just the same. Observing its exit proves only the leaf is terminal.
 */
async function runDirectlyOwnedPhase(options) {
  options.signal?.throwIfAborted();
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const stdout = createBoundedOutputCollector(options.retainedOutputBytes, options.forwardStdout);
    const stderr = createBoundedOutputCollector(options.retainedOutputBytes, options.forwardStderr);
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // An exit request the owner can no longer read is moot: its exit event settles the phase.
    child.stdin.on('error', () => {});

    const phasePid = child.pid ?? null;
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

    let unexpectedSignalErrorCode = null;
    let abortListener = null;

    function sweepOnParentExit() {
      signalOwnedLeaf('SIGKILL');
    }

    process.once('exit', sweepOnParentExit);

    function settle() {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(killEscalationTimer);
      clearTimeout(settleDeadlineTimer);
      process.removeListener('exit', sweepOnParentExit);
      abortListener?.[Symbol.dispose]();
      child.stdin?.destroy();
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
        ownerPid: phasePid,
        ownedGroupId: null,
        phasePid,
        unexpectedSignalErrorCode,
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

    function armDeadline() {
      if (options.timeoutMilliseconds === null || deadlineTimer !== null) return;
      deadlineTimer = setTimeout(() => {
        timedOut = true;
        terminateOwnedLeaf();
      }, options.timeoutMilliseconds);
    }

    function signalOwnedLeaf(signal) {
      if (childExited || child.kill(signal)) return;
      cleanupError = `The owned phase leaf ${child.pid} could not be sent ${signal}; exit has not been observed.`;
    }

    function requestOwnedLeafExit() {
      if (!childExited) child.stdin.end();
    }

    function terminateOwnedLeaf() {
      if (terminationRequestedAt !== null || childExited) return;
      terminationRequestedAt = performance.now();
      clearTimeout(deadlineTimer);
      requestOwnedLeafExit();
      killEscalationTimer = setTimeout(() => signalOwnedLeaf('SIGKILL'), options.terminationGraceMilliseconds);
      armSettleDeadline(options.terminationGraceMilliseconds + options.cleanupDrainMilliseconds);
    }

    function cancelOwnedLeaf() {
      if (child.exitCode !== null || child.signalCode !== null || settled) return;
      spawnError = Object.assign(new Error('The owned phase was aborted.', { cause: options.signal.reason }), {
        name: 'AbortError',
        code: 'ABORT_ERR',
      });
      terminateOwnedLeaf();
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

    child.on('error', (error) => {
      spawnError = error;
      if (child.pid === undefined) {
        childExited = true;
        openStreamCount = 0;
        settle();
        return;
      }
      unexpectedSignalErrorCode = error.code ?? null;
      cleanupError = `The owned phase leaf ${child.pid} reported an error before exit: ${error.message}.`;
      terminateOwnedLeaf();
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

    child.once('spawn', () => {
      try {
        options.onPhaseStarted({ ownerPid: child.pid, ownedGroupId: null, phasePid: child.pid });
      } catch (error) {
        spawnError = error instanceof Error ? error : new Error(String(error));
        terminateOwnedLeaf();
      }
      if (terminationRequestedAt === null) armDeadline();
    });

    if (options.signal) abortListener = addAbortListener(options.signal, cancelOwnedLeaf);
  });
}

function frameworkCompilerPath() {
  const windowsDirectory = process.env.SystemRoot || 'C:\\Windows';
  const compiler = ['Framework64', 'Framework']
    .map((framework) => path.join(windowsDirectory, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe'))
    .find((candidate) => fs.existsSync(candidate));
  return compiler || null;
}

function compilerFailure(compile) {
  return compile.error ? compile.error.message : `${compile.stdout}${compile.stderr}`.trim();
}

function jobOwnerUnavailable(reason) {
  return Object.assign(new Error(`The Windows job owner is unavailable: ${reason}`), { code: 'JOB_OWNER_UNAVAILABLE' });
}

// A concurrent first use may already have published the same source's build; that copy serves.
function publishJobOwner(stagingPath, ownerPath) {
  try {
    fs.renameSync(stagingPath, ownerPath);
  } catch (error) {
    fs.rmSync(stagingPath, { force: true });
    if (!fs.existsSync(ownerPath)) throw error;
  }
}

function compileJobOwner(ownerPath, compiler = frameworkCompilerPath()) {
  if (compiler === null) throw jobOwnerUnavailable('the .NET Framework csc.exe that ships with Windows was not found.');
  fs.mkdirSync(path.dirname(ownerPath), { recursive: true });
  const stagingPath = `${ownerPath}.${process.pid}-${randomUUID()}.exe`;
  const compile = spawnSync(compiler, ['/nologo', '/optimize+', '/target:exe', `/out:${stagingPath}`, windowsJobOwnerSourcePath], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: jobOwnerCompileTimeoutMilliseconds,
  });
  if (compile.status !== 0) {
    fs.rmSync(stagingPath, { force: true });
    throw jobOwnerUnavailable(`${compiler} could not compile ${windowsJobOwnerSourcePath}: ${compilerFailure(compile)}`);
  }
  publishJobOwner(stagingPath, ownerPath);
}

// Node has no Job Object API, so the owner is built from the plugin's own C# source on first use
// and cached per user under the hash of that source.
function windowsJobOwnerPath() {
  const sourceDigest = createHash('sha256').update(fs.readFileSync(windowsJobOwnerSourcePath)).digest('hex').slice(0, 16);
  const ownerPath = path.join(os.tmpdir(), 'sidequest-job-owner', sourceDigest, 'sidequest-job-owner.exe');
  if (!fs.existsSync(ownerPath)) compileJobOwner(ownerPath);
  return ownerPath;
}

// The owner can die or be read mid-write, so only a "members <count> <pid>... end" record whose
// count matches its ids is the job's account; "members 0 end" is its word that nothing was left.
function completeMemberIds([count, ...idsAndEnd]) {
  const ids = idsAndEnd.slice(0, -1);
  const wellFormed = idsAndEnd.at(-1) === 'end' && [count, ...ids].every((value) => /^\d+$/.test(value));
  return wellFormed && ids.length === Number(count) ? ids.map(Number) : null;
}

const jobReportEvents = new Map([
  ['members', (report, values) => {
    report.closedMemberIds = completeMemberIds(values);
    if (report.closedMemberIds === null) report.accountFailure = "the job owner's account of its job members was cut off or malformed";
  }],
  ['members-unknown', (report, [code]) => { report.accountFailure = `QueryInformationJobObject failed with Win32 error ${code}`; }],
  ['requested', (report) => { report.endedOnRequest = true; }],
  ['affinity', (report, [mask]) => { report.affinityMask = mask; }],
  ['owner-error', (report, [code, ...message]) => { report.ownerError = { code: Number(code), message: message.join(' ') }; }],
]);

function readJobReport(reportPath) {
  const report = { closedMemberIds: null, accountFailure: null, endedOnRequest: false, affinityMask: null, ownerError: null };
  const text = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : '';
  for (const line of text.split(/\r?\n/)) {
    const [event, ...values] = line.split(' ');
    jobReportEvents.get(event)?.(report, values);
  }
  return report;
}

// The owner's own exit code is not the phase's: a phase the owner could not run has no status or
// pid, and a phase the owner ended on request has no status.
function ownerReportedPhaseFields(report) {
  if (report.endedOnRequest) return { status: null };
  if (report.ownerError === null) return {};
  const error = Object.assign(new Error(`The Windows job owner could not run the phase: ${report.ownerError.message}`), {
    code: win32FileNotFoundCodes.has(report.ownerError.code) ? 'ENOENT' : 'JOB_OWNER_FAILED',
  });
  return { status: null, phasePid: null, error };
}

async function waitForJobMembersToEnd(processIds, budgetMilliseconds) {
  const deadline = performance.now() + budgetMilliseconds;
  let survivors = processIds.filter((processId) => !isProcessTerminal(processId));
  while (survivors.length > 0 && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    survivors = survivors.filter((processId) => !isProcessTerminal(processId));
  }
  return survivors;
}

function survivorCleanupError(cleanupError, survivingProcessIds) {
  if (survivingProcessIds.length === 0) return cleanupError;
  const survivors = `Job members ${survivingProcessIds.join(', ')} were still alive after the job owner closed its job.`;
  return cleanupError === null ? survivors : `${cleanupError} ${survivors}`;
}

function unknownSurvivorsError(report, cleanupError) {
  const unknown = `Survivor state unknown: ${report.accountFailure ?? 'the job owner left no account of its job members'}.`;
  return cleanupError === null ? unknown : `${unknown} ${cleanupError}`;
}

/**
 * jobClosedProcessIds are the job's own account of the members still inside it as the owner
 * closed it, which the job then killed; survivingProcessIds are any of those still alive once
 * the drain window ran out. Both are null when no such account exists, which fails the phase
 * rather than passing for an empty job.
 */
async function withJobEvidence(result, reportPath, budgetMilliseconds) {
  const report = readJobReport(reportPath);
  fs.rmSync(reportPath, { force: true });
  const accounted = { ...result, ...ownerReportedPhaseFields(report), processorAffinityMask: report.affinityMask };
  if (report.closedMemberIds === null) {
    return { ...accounted, cleanupError: unknownSurvivorsError(report, result.cleanupError), jobClosedProcessIds: null, survivingProcessIds: null };
  }
  const survivingProcessIds = await waitForJobMembersToEnd(report.closedMemberIds, budgetMilliseconds);
  return {
    ...accounted,
    cleanupError: survivorCleanupError(result.cleanupError, survivingProcessIds),
    jobClosedProcessIds: report.closedMemberIds,
    survivingProcessIds,
  };
}

/**
 * Windows phases run under the job owner, which joins its own kill-on-close job before it creates
 * the phase, so the direct leaf runDirectlyOwnedPhase retains is the owner and its exit, for any
 * reason, ends every descendant that inherited the job. A process created through a broker (a
 * service, COM activation, a daemon such as dockerd) is outside the job and is not tracked.
 */
async function runJobOwnedPhase(options) {
  const reportPath = path.join(os.tmpdir(), `sidequest-job-${process.pid}-${randomUUID()}.log`);
  const result = await runDirectlyOwnedPhase({
    ...options,
    command: windowsJobOwnerPath(),
    args: [options.command, ...options.args],
    env: { ...(options.env ?? process.env), SIDEQUEST_JOB_OWNER_REPORT: reportPath },
  });
  return withJobEvidence(result, reportPath, options.cleanupDrainMilliseconds);
}

/**
 * POSIX phases own the inherited process group; Windows phases own a Job Object that holds
 * every descendant that inherited the job, reparented and detached ones included, and report the
 * job's own account of its members in jobClosedProcessIds, survivingProcessIds (null when the
 * account is missing, cut off or malformed, which is a cleanupError, never an empty job) and
 * processorAffinityMask. Processes created through a broker (a service, COM activation, a daemon)
 * are outside the job and are not tracked.
 * SIDEQUEST_JOB_AFFINITY_MASK in the phase environment pins a Windows job to those processors.
 * Settlement is bounded by the deadline, termination grace and output-drain windows.
 * A cleanupError reports failure, never proof of terminality. A timedOut phase fails
 * regardless of its eventual status. Windows accepts a caller AbortSignal: pre-aborted
 * input rejects before spawn; later cancellation returns ABORT_ERR after exit or explicit
 * cleanup failure. A Windows host whose job owner cannot be built rejects with
 * JOB_OWNER_UNAVAILABLE. The signal does not change the POSIX supervision contract.
 */
function runOwnedPhase(rawOptions) {
  const options = normalizeOptions(rawOptions);
  return platformUsesProcessGroups ? runSupervisedPhase(options) : runJobOwnedPhase(options);
}

const ownedVerifyTimeoutExitCode = 124;
const ownedVerifyTimeoutMarker = '__SIDEQUEST_VERIFY_TIMEOUT__';

// The Windows leaf handle ends only the shell: its children silently break away from libuv's job
// object, so a docker client or browser under the shell outlives it. taskkill /T walks the parent
// chain, but only while the root is still alive, so the sweep runs before the leaf is terminated.
function sweepWindowsTree(rootPid) {
  if (spawnSync('taskkill', ['/pid', String(rootPid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }).status === 0) return;
  process.stderr.write(`\ntaskkill /T found no live tree under pid ${rootPid}; a descendant that outlived its root may still be running.\n`);
}

/**
 * Runs one verifier shell as an owned phase for a synchronous caller: the deadline ends the
 * whole tree (process group on POSIX, taskkill tree on Windows), the output is forwarded to
 * stdout/stderr, and a timeout is reported with a marker line and exit code 124 so the caller
 * can tell it from the verifier's own exit.
 */
function ownedVerifyExitCode(result, timedOut, timeoutMilliseconds) {
  if (timedOut) {
    process.stderr.write(`\n${ownedVerifyTimeoutMarker}=${timeoutMilliseconds}\n`);
    return ownedVerifyTimeoutExitCode;
  }
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    return 2;
  }
  return result.status ?? 2;
}

async function runOwnedVerifyPhase(spec) {
  let sweepTimer = null;
  let deadlineReached = false;
  const result = await runOwnedPhase({
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    env: { ...process.env, SIDEQUEST_OWNED_VERIFY_PHASE: '1' },
    timeoutMilliseconds: platformUsesProcessGroups ? spec.timeoutMilliseconds : null,
    onPhaseStarted({ phasePid }) {
      if (platformUsesProcessGroups) return;
      // A deadline is a timeout even when the sweep finds no tree: a root that exited early can leave a
      // descendant holding the output open past it, and that must never pass as the verifier's own exit.
      sweepTimer = setTimeout(() => {
        deadlineReached = true;
        sweepWindowsTree(phasePid);
      }, spec.timeoutMilliseconds);
    },
  });
  clearTimeout(sweepTimer);
  return ownedVerifyExitCode(result, result.timedOut || deadlineReached, spec.timeoutMilliseconds);
}

module.exports = {
  compileJobOwner,
  classifyProcessState,
  isProcessTerminal,
  ownedVerifyTimeoutExitCode,
  ownedVerifyTimeoutMarker,
  runOwnedPhase,
  withJobEvidence,
  runOwnedVerifyPhase,
};

if (require.main === module) {
  runOwnedVerifyPhase(JSON.parse(process.argv[2])).then((exitCode) => { process.exitCode = exitCode; });
}
