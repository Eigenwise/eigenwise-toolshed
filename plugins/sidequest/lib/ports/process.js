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
  runProcessVerification: () => runProcessVerification,
  shellCommand: () => shellCommand
});
module.exports = __toCommonJS(process_exports);
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const DEFAULT_TIMEOUT_MILLISECONDS = 10 * 60 * 1e3;
const DEFAULT_OUTPUT_TAIL_BYTES = 16 * 1024;
const COMMAND_NOT_FOUND_EXIT_CODES = /* @__PURE__ */ new Set([127, 9009]);
function shellCommand(scriptPath, platform = process.platform) {
  if (platform === "win32") {
    return Object.freeze({
      executable: process.env.ComSpec || "cmd.exe",
      arguments: Object.freeze(["/d", "/s", "/c", scriptPath])
    });
  }
  return Object.freeze({
    executable: process.env.SHELL || "/bin/sh",
    arguments: Object.freeze([scriptPath])
  });
}
function shellScript(command, platform = process.platform) {
  if (platform === "win32") {
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
  const extension = process.platform === "win32" ? ".cmd" : ".sh";
  const scriptPath = path.join(os.tmpdir(), `sidequest-verify-${process.pid}-${randomUUID()}${extension}`);
  fs.writeFileSync(scriptPath, shellScript(command), { encoding: "utf8", flag: "wx", mode: 448 });
  return scriptPath;
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
function processTimedOut(error) {
  return error instanceof Error && "code" in error && error.code === "ETIMEDOUT";
}
function failedResult(requirement, status, command, logPath, reason, exitCode, tail, timeoutMilliseconds) {
  const identity = exitCode == null ? status : `${status}:exit-${exitCode}`;
  return Object.freeze({
    kind: requirement.kind,
    status,
    evidence: reason,
    command,
    logPath,
    exitCode,
    ...timeoutMilliseconds === void 0 ? {} : { timeoutMilliseconds },
    outputTail: tail || null,
    failureIdentities: Object.freeze([identity])
  });
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
  const logPath = options.logPath || defaultLogPath();
  const timeoutMilliseconds = options.timeoutMilliseconds || DEFAULT_TIMEOUT_MILLISECONDS;
  const outputTailBytes = options.outputTailBytes || DEFAULT_OUTPUT_TAIL_BYTES;
  const scriptPath = temporaryScript(command);
  let outcome = null;
  try {
    const log = fs.openSync(logPath, "w");
    try {
      const shell = shellCommand(scriptPath);
      outcome = spawnSync(shell.executable, shell.arguments, {
        cwd: options.cwd || process.cwd(),
        windowsHide: true,
        timeout: timeoutMilliseconds,
        stdio: ["ignore", log, log]
      });
    } finally {
      fs.closeSync(log);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return failedResult(requirement, "could_not_run", command, logPath, reason, 2, fs.existsSync(logPath) ? outputTail(logPath, outputTailBytes) : "");
  } finally {
    fs.rmSync(scriptPath, { force: true });
  }
  const tail = outputTail(logPath, outputTailBytes);
  if (processTimedOut(outcome?.error)) {
    return failedResult(requirement, "timeout", command, logPath, `Verification timed out after ${timeoutMilliseconds}ms; partial output captured.`, 2, tail, timeoutMilliseconds);
  }
  const exitCode = markerExitCode(logPath);
  if (exitCode === null) {
    const shellExitCode = outcome?.status ?? (outcome?.error ? 2 : null);
    return failedResult(requirement, "could_not_run", command, logPath, `The command shell exited ${shellExitCode ?? "without a code"} before reporting the suite exit code.`, shellExitCode, tail);
  }
  if (commandNotFound(logPath, exitCode)) {
    const missingCommand = missingCommandName(logPath);
    const missingCommandEvidence = missingCommand ? `command ${JSON.stringify(missingCommand)}` : "a command";
    return failedResult(requirement, "toolchain_missing", command, logPath, `The verification environment could not find ${missingCommandEvidence} while running ${JSON.stringify(command)} (exit code ${exitCode}).`, exitCode, tail);
  }
  if (exitCode === 0) {
    return Object.freeze({ kind: requirement.kind, status: "passed", evidence: requirement.evidenceContract, command, logPath, exitCode });
  }
  return failedResult(requirement, "failed_suite", command, logPath, `The required command exited ${exitCode}.`, exitCode, tail);
}
function createProcessPort() {
  return Object.freeze({ run: runProcessVerification });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createProcessPort,
  runProcessVerification,
  shellCommand
});
