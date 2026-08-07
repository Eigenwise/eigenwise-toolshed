"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1e3;
const TERMINATION_GRACE_MS = 1e3;
function shellCommand(scriptPath, platform = process.platform) {
  if (platform === "win32") {
    return {
      executable: process.env.ComSpec || "cmd.exe",
      arguments: ["/d", "/s", "/c", scriptPath]
    };
  }
  return {
    executable: process.env.SHELL || "/bin/sh",
    arguments: [scriptPath]
  };
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
function createShellScript(command) {
  const extension = process.platform === "win32" ? ".cmd" : ".sh";
  const scriptPath = path.join(os.tmpdir(), `sidequest-verify-${process.pid}-${randomUUID()}${extension}`);
  fs.writeFileSync(scriptPath, shellScript(command), { encoding: "utf8", flag: "wx", mode: 448 });
  return scriptPath;
}
function markerExitCode(logPath) {
  const output = fs.readFileSync(logPath, "utf8");
  const matches = [...output.matchAll(/^__SIDEQUEST_VERIFY_EXIT__=(\d+)$/gm)];
  const match = matches.at(-1);
  return match ? Number(match[1]) : null;
}
function closeLog(stream) {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}
function waitForChild(child) {
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ kind: "error", error }));
    child.once("close", (code) => resolve({ kind: "closed", code }));
  });
}
function waitForChildOrTimeout(childCompletion, timeoutMilliseconds) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ kind: "timed-out" }), timeoutMilliseconds);
    childCompletion.then((outcome) => {
      clearTimeout(timeout);
      resolve(outcome);
    });
  });
}
async function terminateChildProcessTree(child) {
  if (process.platform === "win32" && child.pid !== void 0) {
    const terminator = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
    await waitForChildOrTimeout(waitForChild(terminator), TERMINATION_GRACE_MS);
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
  }
}
async function runVerifyCapture(command, cwd = process.cwd(), timeoutMilliseconds = DEFAULT_VERIFY_TIMEOUT_MS) {
  const logPath = path.join(os.tmpdir(), `sidequest-verify-${process.pid}-${randomUUID()}.log`);
  const log = fs.createWriteStream(logPath, { flags: "wx" });
  let scriptPath = null;
  let startError = null;
  let processExitCode = null;
  let timedOut = false;
  try {
    const generatedScriptPath = createShellScript(command);
    scriptPath = generatedScriptPath;
    const shell = shellCommand(generatedScriptPath);
    const child = spawn(shell.executable, shell.arguments, { cwd, windowsHide: true });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const childCompletion = waitForChild(child);
    const outcome = await waitForChildOrTimeout(childCompletion, timeoutMilliseconds);
    if (outcome.kind === "timed-out") {
      timedOut = true;
      await terminateChildProcessTree(child);
      const terminalOutcome = await waitForChildOrTimeout(childCompletion, TERMINATION_GRACE_MS);
      if (terminalOutcome.kind === "timed-out") {
        child.stdout.unpipe(log);
        child.stderr.unpipe(log);
      } else if (terminalOutcome.kind === "error") {
        startError = terminalOutcome.error;
      } else {
        processExitCode = terminalOutcome.code;
      }
    } else if (outcome.kind === "error") {
      startError = outcome.error;
    } else {
      processExitCode = outcome.code;
    }
  } catch (error) {
    startError = error instanceof Error ? error : new Error(String(error));
  }
  try {
    await closeLog(log);
  } finally {
    if (scriptPath) fs.rmSync(scriptPath, { force: true });
  }
  if (timedOut) {
    return {
      status: "could-not-run",
      exitCode: 2,
      logPath,
      reason: `Verification timed out after ${timeoutMilliseconds}ms; partial output captured.`
    };
  }
  if (startError) return { status: "could-not-run", exitCode: 2, logPath, reason: startError.message };
  const exitCode = markerExitCode(logPath);
  if (exitCode === null) {
    return {
      status: "could-not-run",
      exitCode: 2,
      logPath,
      reason: `The command shell exited ${processExitCode ?? "without a code"} before reporting the suite exit code.`
    };
  }
  return exitCode === 0 ? { status: "passed", exitCode, logPath } : { status: "failed-suite", exitCode, logPath };
}
function report(capture) {
  const reason = capture.reason ? ` reason=${JSON.stringify(capture.reason)}` : "";
  process.stdout.write(`verify=${capture.status} exit=${capture.exitCode}${reason}
`);
  process.stdout.write(`details=${capture.logPath}
`);
}
async function main() {
  const encoded = process.argv[2] === "--base64" ? process.argv[3] : "";
  const command = encoded ? Buffer.from(encoded, "base64").toString("utf8").trim() : "";
  if (!command) {
    process.stderr.write("Usage: node verify-capture.js --base64 <base64 verify command>\n");
    process.exitCode = 2;
    return;
  }
  const capture = await runVerifyCapture(command);
  report(capture);
  process.exitCode = capture.exitCode;
}
module.exports = { runVerifyCapture, shellCommand };
if (require.main === module) void main();
