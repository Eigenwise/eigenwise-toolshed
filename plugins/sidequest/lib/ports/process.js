"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var process_exports = {};
__export(process_exports, {
  createProcessPort: () => createProcessPort,
  runOwnedProcessVerification: () => runOwnedProcessVerification,
  runProcessVerification: () => runProcessVerification,
  shellCommand: () => shellCommand,
  verifierEnvironment: () => verifierEnvironment
});
module.exports = __toCommonJS(process_exports);
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
function nearestPackageRoot(directory) {
  if (fs.existsSync(path.join(directory, "package.json"))) return directory;
  const parent = path.dirname(directory);
  if (parent === directory) throw new Error(`no package.json at or above ${__dirname}`);
  return nearestPackageRoot(parent);
}
const ownedProcessTree = require(path.join(nearestPackageRoot(__dirname), "scripts", "owned-process-tree.js"));
const DEFAULT_TIMEOUT_MILLISECONDS = 10 * 60 * 1e3;
const DEFAULT_OUTPUT_TAIL_BYTES = 16 * 1024;
const COMMAND_NOT_FOUND_EXIT_CODES = /* @__PURE__ */ new Set([127, 9009]);
function missingCommandResult(requirement) {
  return Object.freeze({
    kind: requirement.kind,
    status: "could_not_run",
    evidence: "The required command verifier has no pinned command.",
    command: null,
    failureIdentities: Object.freeze(["could_not_run:missing-command"])
  });
}
function verificationLimits(options) {
  return {
    logPath: options.logPath || defaultLogPath(),
    timeoutMilliseconds: options.timeoutMilliseconds || DEFAULT_TIMEOUT_MILLISECONDS,
    outputTailBytes: options.outputTailBytes || DEFAULT_OUTPUT_TAIL_BYTES
  };
}
function ownedVerificationRun(requirement, command, options) {
  const { scriptPath, shell } = temporaryScript(command);
  return Object.freeze({
    requirement,
    command,
    scriptPath,
    shell,
    cwd: options.cwd || process.cwd(),
    environment: verifierEnvironment(options.environment || process.env),
    ...verificationLimits(options)
  });
}
const jobBrokerBoundary = "Processes created through a broker (a service, COM activation, a daemon such as dockerd) are outside the job and are not tracked.";
function treeEndedEvidence(jobClosedProcessIds, outcome) {
  if (jobClosedProcessIds === void 0) return `The owned process tree was ended; ${outcome}`;
  const ended = jobClosedProcessIds.length ? `processes ${jobClosedProcessIds.join(", ")}` : "none were still running";
  return `The Windows job owner ended every descendant that inherited the job (${ended}); ${outcome} ${jobBrokerBoundary}`;
}
function ownedTreeCleanupEvidence(phase) {
  if (phase.jobClosedProcessIds === null) return phase.cleanupError ?? "Survivor state unknown.";
  return treeEndedEvidence(phase.jobClosedProcessIds, phase.cleanupError === null ? "none survived." : `cleanup refused: ${phase.cleanupError}`);
}
function abnormalSettlement(phase, timeoutMilliseconds) {
  if (phase.timedOut) return { status: "timeout", reason: `Verification timed out after ${timeoutMilliseconds}ms.`, timeoutMilliseconds };
  if (phase.error?.code === "ABORT_ERR") return { status: "could_not_run", reason: "Verification was cancelled." };
  if (phase.cleanupError !== null) return { status: "could_not_run", reason: "The verification command ended, but its process tree did not." };
  return null;
}
function toolchainMissingResult(run, exitCode, tail) {
  const missingCommand = missingCommandName(run.logPath);
  const missingCommandEvidence = missingCommand ? `command ${JSON.stringify(missingCommand)}` : "a command";
  return failedResult(run.requirement, "toolchain_missing", run.command, run.logPath, `The verification environment could not find ${missingCommandEvidence} while running ${JSON.stringify(run.command)} (exit code ${exitCode}).`, exitCode, tail, void 0, run.shell.label);
}
function reportedExitResult(run, exitCode, tail) {
  if (shellCannotParsePosixSyntax(run.logPath, exitCode, run.shell)) {
    return failedResult(run.requirement, "could_not_run", run.command, run.logPath, `The ${run.shell.label} fallback could not parse POSIX syntax while running ${JSON.stringify(run.command)} (exit code ${exitCode}).`, exitCode, tail, void 0, run.shell.label);
  }
  if (commandNotFound(run.logPath, exitCode)) return toolchainMissingResult(run, exitCode, tail);
  if (exitCode === 0) {
    return Object.freeze({ kind: run.requirement.kind, status: "passed", evidence: run.requirement.evidenceContract, command: run.command, logPath: run.logPath, exitCode, shell: run.shell.label });
  }
  return failedResult(run.requirement, "failed_suite", run.command, run.logPath, `The required command exited ${exitCode}.`, exitCode, tail, void 0, run.shell.label);
}
function unreportedShellExitCode(phase) {
  if (phase.status !== null) return phase.status;
  return phase.error ? 2 : null;
}
function unreportedExitResult(run, phase, tail) {
  const shellExitCode = unreportedShellExitCode(phase);
  return failedResult(run.requirement, "could_not_run", run.command, run.logPath, shellExitReason(run.shell, shellExitCode, phase.error || void 0), shellExitCode, tail, void 0, run.shell.label);
}
function ownedVerificationResult(run, phase) {
  const tail = outputTail(run.logPath, run.outputTailBytes);
  const abnormal = abnormalSettlement(phase, run.timeoutMilliseconds);
  if (abnormal) {
    return failedResult(run.requirement, abnormal.status, run.command, run.logPath, `${abnormal.reason} ${ownedTreeCleanupEvidence(phase)} Output log: ${run.logPath}`, 2, tail, abnormal.timeoutMilliseconds, run.shell.label);
  }
  const exitCode = markerExitCode(run.logPath);
  return exitCode === null ? unreportedExitResult(run, phase, tail) : reportedExitResult(run, exitCode, tail);
}
async function runOwnedProcessVerification(requirement, options = {}) {
  const command = String(requirement.command || "").trim();
  if (!command) return missingCommandResult(requirement);
  const run = ownedVerificationRun(requirement, command, options);
  const log = fs.openSync(run.logPath, "w");
  try {
    const phase = await ownedProcessTree.runOwnedPhase({
      command: run.shell.executable,
      args: run.shell.arguments,
      cwd: run.cwd,
      env: run.environment,
      timeoutMilliseconds: run.timeoutMilliseconds,
      signal: options.signal,
      forwardStdout: (chunk) => fs.writeSync(log, chunk),
      forwardStderr: (chunk) => fs.writeSync(log, chunk)
    });
    return ownedVerificationResult(run, phase);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return failedResult(requirement, "could_not_run", command, run.logPath, reason, 2, outputTail(run.logPath, run.outputTailBytes), void 0, run.shell.label);
  } finally {
    fs.closeSync(log);
    fs.rmSync(run.scriptPath, { force: true });
  }
}
function windowsPosixShell() {
  const programFilesDirectories = [process.env.ProgramW6432, process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter((directory) => Boolean(directory));
  const candidates = [...new Set(programFilesDirectories.map((directory) => path.join(directory, "Git", "bin", "sh.exe")))];
  const installedShell = candidates.find((candidate) => fs.existsSync(candidate));
  if (installedShell) return installedShell;
  const discovered = spawnSync("where.exe", ["sh.exe"], { encoding: "utf8", windowsHide: true });
  if (discovered.status !== 0) return null;
  return String(discovered.stdout || "").split(/\r?\n/).map((candidate) => candidate.trim()).find((candidate) => fs.existsSync(candidate)) || null;
}
function shellDefinition(platform = process.platform) {
  if (platform === "win32") {
    const posixShell2 = windowsPosixShell();
    if (posixShell2) return Object.freeze({ executable: posixShell2, label: `POSIX shell (${posixShell2})`, scriptExtension: ".sh" });
    const commandPrompt = process.env.ComSpec || "cmd.exe";
    return Object.freeze({ executable: commandPrompt, label: `Command Prompt (${commandPrompt})`, scriptExtension: ".cmd" });
  }
  const posixShell = process.env.SHELL || "/bin/sh";
  return Object.freeze({ executable: posixShell, label: `POSIX shell (${posixShell})`, scriptExtension: ".sh" });
}
const WINDOWS_BACKSLASH_PATH = /(?:^|[\s=(])(?:[A-Za-z]:|\.{1,2}|[\w.-]+)\\[\w.-]/;
const QUOTED_SEGMENT = /"(?:\\.|[^"\\])*"|'[^']*'/g;
function unquotedText(command) {
  return command.replace(QUOTED_SEGMENT, " ");
}
function commandPromptShell() {
  const commandPrompt = process.env.ComSpec || "cmd.exe";
  return Object.freeze({ executable: commandPrompt, label: `Command Prompt (${commandPrompt})`, scriptExtension: ".cmd" });
}
function verifierShell(command, platform = process.platform) {
  return platform === "win32" && WINDOWS_BACKSLASH_PATH.test(unquotedText(command)) ? commandPromptShell() : shellDefinition(platform);
}
function commandForShell(scriptPath, shell) {
  const arguments_ = shell.scriptExtension === ".cmd" ? Object.freeze(["/d", "/s", "/c", scriptPath]) : Object.freeze([scriptPath]);
  return Object.freeze({ ...shell, arguments: arguments_ });
}
function shellCommand(scriptPath, platform = process.platform) {
  return commandForShell(scriptPath, shellDefinition(platform));
}
function shellScript(command, shell) {
  if (shell.scriptExtension === ".cmd") {
    return [
      "@echo off",
      `"%ComSpec%" /d /s /c "${command}"`,
      'set "sidequestExitCode=%ERRORLEVEL%"',
      "echo __SIDEQUEST_VERIFY_EXIT__=%sidequestExitCode%",
      "exit /b %sidequestExitCode%",
      ""
    ].join("\r\n");
  }
  return `(
${command}
)
sidequest_exit_code=$?
printf '\\n__SIDEQUEST_VERIFY_EXIT__=%s\\n' "$sidequest_exit_code"
exit "$sidequest_exit_code"
`;
}
function temporaryScript(command) {
  const shell = verifierShell(command);
  const scriptPath = path.join(os.tmpdir(), `sidequest-verify-${process.pid}-${randomUUID()}${shell.scriptExtension}`);
  fs.writeFileSync(scriptPath, shellScript(command, shell), { encoding: "utf8", flag: "wx", mode: 448 });
  return Object.freeze({ scriptPath, shell: commandForShell(scriptPath, shell) });
}
function defaultLogPath() {
  return path.join(os.tmpdir(), `sidequest-verify-${process.pid}-${randomUUID()}.log`);
}
function markerExitCode(logPath) {
  const output = fs.readFileSync(logPath, "utf8");
  const matches = [...output.matchAll(/^__SIDEQUEST_VERIFY_EXIT__=(\d+)$/gm)];
  const marker = matches.at(-1);
  return marker ? Number(marker[1]) : null;
}
function outputTail(logPath, maximumBytes) {
  const size = fs.statSync(logPath).size;
  const length = Math.min(size, maximumBytes);
  if (!length) return "";
  const file = fs.openSync(logPath, "r");
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(file, buffer, 0, length, size - length);
    return `${size > length ? "[output truncated]\n" : ""}${buffer.toString("utf8")}`.trim();
  } finally {
    fs.closeSync(file);
  }
}
function commandNotFound(logPath, exitCode) {
  if (COMMAND_NOT_FOUND_EXIT_CODES.has(exitCode)) return true;
  if (process.platform !== "win32" || exitCode !== 1) return false;
  return /^'[^']+' is not recognized as an internal or external command,$/m.test(fs.readFileSync(logPath, "utf8"));
}
function missingCommandName(logPath) {
  const output = fs.readFileSync(logPath, "utf8");
  const windowsMatch = output.match(/^'([^']+)' is not recognized as an internal or external command,$/m);
  if (windowsMatch?.[1]) return windowsMatch[1];
  for (const line of output.split(/\r?\n/)) {
    const posixMatch = line.match(/(?:^|:\s)([^:\s]+): (?:command )?not found$/);
    if (posixMatch?.[1]) return posixMatch[1];
  }
  return null;
}
function shellCannotParsePosixSyntax(logPath, exitCode, shell) {
  if (exitCode !== 1 || shell.scriptExtension !== ".cmd") return false;
  return /^'!' is not recognized as an internal or external command,$/m.test(fs.readFileSync(logPath, "utf8"));
}
function verifierEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !/^CLAUDE_PLUGIN_/i.test(name)));
}
function shellExitReason(shell, shellExitCode, spawnError) {
  const reason = `The ${shell.label} exited ${shellExitCode ?? "without a code"} before reporting the suite exit code.`;
  return spawnError ? `${reason} ${spawnError.message}` : reason;
}
function processTimedOut(error) {
  return error instanceof Error && "code" in error && error.code === "ETIMEDOUT";
}
function failedResult(requirement, status, command, logPath, reason, exitCode, tail, timeoutMilliseconds, shell) {
  const identity = exitCode == null ? status : `${status}:exit-${exitCode}`;
  return Object.freeze({
    kind: requirement.kind,
    status,
    evidence: reason,
    command,
    logPath,
    exitCode,
    ...timeoutMilliseconds === void 0 ? {} : { timeoutMilliseconds },
    ...shell === void 0 ? {} : { shell },
    outputTail: tail || null,
    failureIdentities: Object.freeze([identity])
  });
}
const OWNED_PROCESS_TREE_SCRIPT = path.join(nearestPackageRoot(__dirname), "scripts", "owned-process-tree.js");
const OWNED_TREE_SETTLE_MARGIN_MILLISECONDS = 15e3;
const OWNED_TREE_TIMEOUT_MARKER = /^__SIDEQUEST_VERIFY_TIMEOUT__=\d+$/m;
const OWNED_TREE_CLEANUP_ERROR_MARKER = /^__SIDEQUEST_VERIFY_CLEANUP_ERROR__=(.+)$/m;
function verifierRun(requirement, command, options) {
  return Object.freeze({
    requirement,
    command,
    logPath: options.logPath || defaultLogPath(),
    timeoutMilliseconds: options.timeoutMilliseconds || DEFAULT_TIMEOUT_MILLISECONDS,
    outputTailBytes: options.outputTailBytes || DEFAULT_OUTPUT_TAIL_BYTES,
    cwd: options.cwd,
    environment: verifierEnvironment(options.environment || process.env),
    ownedTree: requirement.environment === "shared"
  });
}
function spawnFailureResult(run, shell, error) {
  const reason = error instanceof Error ? error.message : String(error);
  const tail = fs.existsSync(run.logPath) ? outputTail(run.logPath, run.outputTailBytes) : "";
  return failedResult(run.requirement, "could_not_run", run.command, run.logPath, reason, 2, tail, void 0, shell.label);
}
function ownedTreeLaunch(shell, run) {
  const spec = { command: shell.executable, args: shell.arguments, cwd: run.cwd, timeoutMilliseconds: run.timeoutMilliseconds };
  return Object.freeze({ ...shell, executable: process.execPath, arguments: Object.freeze([OWNED_PROCESS_TREE_SCRIPT, JSON.stringify(spec)]) });
}
function spawnVerifier(shell, run) {
  const launch = run.ownedTree ? ownedTreeLaunch(shell, run) : shell;
  const timeout = run.ownedTree ? run.timeoutMilliseconds + OWNED_TREE_SETTLE_MARGIN_MILLISECONDS : run.timeoutMilliseconds;
  const log = fs.openSync(run.logPath, "w");
  try {
    return spawnSync(launch.executable, launch.arguments, {
      cwd: run.cwd,
      env: run.environment,
      windowsHide: true,
      timeout,
      stdio: ["ignore", log, log]
    });
  } finally {
    fs.closeSync(log);
  }
}
function verifierTimedOut(run, outcome) {
  if (processTimedOut(outcome.error)) return true;
  return run.ownedTree && OWNED_TREE_TIMEOUT_MARKER.test(fs.readFileSync(run.logPath, "utf8"));
}
function timeoutResult(run, shell, outcome, tail) {
  return failedResult(run.requirement, "timeout", run.command, run.logPath, `Verification timed out after ${run.timeoutMilliseconds}ms; partial output captured.`, outcome.status ?? 2, tail, run.timeoutMilliseconds, shell.label);
}
function ownedTreeCleanupError(run) {
  if (!run.ownedTree) return null;
  return OWNED_TREE_CLEANUP_ERROR_MARKER.exec(fs.readFileSync(run.logPath, "utf8"))?.[1] ?? null;
}
function abnormalVerifierResult(run, shell, outcome, tail) {
  if (verifierTimedOut(run, outcome)) return timeoutResult(run, shell, outcome, tail);
  const cleanupError = ownedTreeCleanupError(run);
  if (cleanupError === null) return null;
  return failedResult(run.requirement, "could_not_run", run.command, run.logPath, `The verification command ended, but its process tree did not. ${cleanupError} Output log: ${run.logPath}`, outcome.status ?? 2, tail, void 0, shell.label);
}
function exitCodeResult(run, shell, outcome, tail) {
  const exitCode = markerExitCode(run.logPath);
  if (exitCode !== null) return exitCodeVerdict(run, shell, exitCode, tail);
  const shellExitCode = outcome.status ?? (outcome.error ? 2 : null);
  return failedResult(run.requirement, "could_not_run", run.command, run.logPath, shellExitReason(shell, shellExitCode, outcome.error), shellExitCode, tail, void 0, shell.label);
}
function exitCodeVerdict(run, shell, exitCode, tail) {
  const { requirement, command, logPath } = run;
  if (shellCannotParsePosixSyntax(logPath, exitCode, shell)) {
    return failedResult(requirement, "could_not_run", command, logPath, `The ${shell.label} fallback could not parse POSIX syntax while running ${JSON.stringify(command)} (exit code ${exitCode}).`, exitCode, tail, void 0, shell.label);
  }
  if (commandNotFound(logPath, exitCode)) {
    const missingCommand = missingCommandName(logPath);
    const missingCommandEvidence = missingCommand ? `command ${JSON.stringify(missingCommand)}` : "a command";
    return failedResult(requirement, "toolchain_missing", command, logPath, `The verification environment could not find ${missingCommandEvidence} while running ${JSON.stringify(command)} (exit code ${exitCode}).`, exitCode, tail, void 0, shell.label);
  }
  if (exitCode === 0) {
    return Object.freeze({ kind: requirement.kind, status: "passed", evidence: requirement.evidenceContract, command, logPath, exitCode, shell: shell.label });
  }
  return failedResult(requirement, "failed_suite", command, logPath, `The required command exited ${exitCode}.`, exitCode, tail, void 0, shell.label);
}
function runProcessVerification(requirement, options = {}) {
  const command = String(requirement.command || "").trim();
  if (!command) {
    return Object.freeze({
      kind: requirement.kind,
      status: "could_not_run",
      evidence: "The required command verifier has no pinned command.",
      command: null,
      failureIdentities: Object.freeze(["could_not_run:missing-command"])
    });
  }
  const run = verifierRun(requirement, command, options);
  const { scriptPath, shell } = temporaryScript(command);
  let outcome;
  try {
    outcome = spawnVerifier(shell, run);
  } catch (error) {
    return spawnFailureResult(run, shell, error);
  } finally {
    fs.rmSync(scriptPath, { force: true });
  }
  const tail = outputTail(run.logPath, run.outputTailBytes);
  return abnormalVerifierResult(run, shell, outcome, tail) ?? exitCodeResult(run, shell, outcome, tail);
}
function createProcessPort() {
  return Object.freeze({ run: runProcessVerification });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createProcessPort,
  runOwnedProcessVerification,
  runProcessVerification,
  shellCommand,
  verifierEnvironment
});
