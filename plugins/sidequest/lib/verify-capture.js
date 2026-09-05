"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { runProcessVerification, shellCommand } = require("./ports/process.js");
const captureSlotTimeoutMilliseconds = 30 * 60 * 1e3;
const captureSlotRetryMilliseconds = 50;
const captureSlotOperationRetryLimit = 20;
const captureSlotContentionErrorCodes = /* @__PURE__ */ new Set(["EEXIST", "EPERM", "EBUSY", "ENOTEMPTY"]);
function captureRequirement(command) {
  return Object.freeze({ kind: "command", command, evidenceContract: "command output" });
}
async function runVerifyCapture(command, cwd = process.cwd(), timeoutMilliseconds, environment) {
  const result = runProcessVerification(captureRequirement(command), {
    cwd,
    ...timeoutMilliseconds === void 0 ? {} : { timeoutMilliseconds },
    ...environment === void 0 ? {} : { environment }
  });
  return Object.freeze({
    ...result,
    exitCode: result.exitCode ?? null,
    ...result.status === "passed" ? {} : { reason: result.evidence }
  });
}
function isFullSuiteCommand(command) {
  return /(?:^|[\s&;()])npm\s+run\s+test:full(?:\s|$)/.test(command);
}
function captureSlotDirectory(project) {
  const projectKey = path.resolve(project).toLocaleLowerCase();
  const projectHash = createHash("sha256").update(projectKey).digest("hex");
  return path.join(os.tmpdir(), "sidequest-verify-capture-slots", projectHash);
}
function captureSlotWaiterPath(slotDirectory, fileSystem = fs) {
  const waitingDirectory = path.join(slotDirectory, "waiting");
  fileSystem.mkdirSync(waitingDirectory, { recursive: true });
  return path.join(waitingDirectory, `${Date.now().toString().padStart(15, "0")}-${process.pid}-${randomUUID()}.json`);
}
function queuedWaiters(slotDirectory, fileSystem = fs) {
  try {
    return fileSystem.readdirSync(path.join(slotDirectory, "waiting")).sort();
  } catch {
    return [];
  }
}
function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function captureSlotErrorCode(error) {
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.name : String(error);
}
function captureSlotOperationFailure(operation, slotPath, attempts, error) {
  const errorCode = captureSlotErrorCode(error);
  return Object.freeze({
    reason: `Verification capture could not ${operation} slot path ${JSON.stringify(slotPath)} after ${attempts} retries; last errno ${errorCode}.`,
    errorCode
  });
}
async function retryCaptureSlotOperation(operation, slotPath, execute) {
  for (let attempts = 1; attempts <= captureSlotOperationRetryLimit; attempts += 1) {
    try {
      execute();
      return null;
    } catch (error) {
      const errorCode = captureSlotErrorCode(error);
      if (!captureSlotContentionErrorCodes.has(errorCode) || attempts === captureSlotOperationRetryLimit) {
        return captureSlotOperationFailure(operation, slotPath, attempts, error);
      }
      await wait(captureSlotRetryMilliseconds);
    }
  }
  throw new Error("Capture slot operation retry loop completed unexpectedly.");
}
async function releaseCaptureSlot(activeDirectory, fileSystem) {
  const tombstoneDirectory = `${activeDirectory}.released-${process.pid}-${randomUUID()}`;
  const renameFailure = await retryCaptureSlotOperation("rename", activeDirectory, () => fileSystem.renameSync(activeDirectory, tombstoneDirectory));
  if (renameFailure) {
    if (renameFailure.errorCode === "ENOENT") return null;
    return renameFailure;
  }
  return retryCaptureSlotOperation("remove", tombstoneDirectory, () => fileSystem.rmSync(tombstoneDirectory, { recursive: true, force: true }));
}
async function acquireCaptureSlot(project, timeoutMilliseconds = captureSlotTimeoutMilliseconds, fileSystem = fs) {
  const slotDirectory = captureSlotDirectory(project);
  const activeDirectory = path.join(slotDirectory, "active");
  const startedAt = Date.now();
  const waiterPath = captureSlotWaiterPath(slotDirectory, fileSystem);
  const waiterName = path.basename(waiterPath);
  fileSystem.writeFileSync(waiterPath, "", { encoding: "utf8", flag: "wx" });
  let waitingAnnounced = false;
  let queuePosition = 1;
  let acquireContentionAttempts = 0;
  for (; ; ) {
    const waiterIndex = queuedWaiters(slotDirectory, fileSystem).indexOf(waiterName);
    const active = fileSystem.existsSync(activeDirectory);
    queuePosition = Math.max(queuePosition, waiterIndex + (active ? 2 : 1));
    if (!active && waiterIndex === 0) {
      let acquired = false;
      try {
        fileSystem.mkdirSync(activeDirectory);
        acquired = true;
      } catch (error) {
        const errorCode = captureSlotErrorCode(error);
        if (!captureSlotContentionErrorCodes.has(errorCode)) {
          fileSystem.rmSync(waiterPath, { force: true });
          return captureSlotOperationFailure("create", activeDirectory, 1, error);
        }
        acquireContentionAttempts += 1;
        if (acquireContentionAttempts === captureSlotOperationRetryLimit) {
          fileSystem.rmSync(waiterPath, { force: true });
          return captureSlotOperationFailure("create", activeDirectory, acquireContentionAttempts, error);
        }
      }
      if (acquired) {
        fileSystem.rmSync(waiterPath, { force: true });
        return Object.freeze({
          waitedForSlotMs: Date.now() - startedAt,
          queuePosition,
          release: () => releaseCaptureSlot(activeDirectory, fileSystem)
        });
      }
    }
    if (!waitingAnnounced) {
      const siblingCount = queuePosition - 1;
      process.stdout.write(`verify-capture: waiting for ${siblingCount} sibling capture${siblingCount === 1 ? "" : "s"} to finish (queue position ${queuePosition}).
`);
      waitingAnnounced = true;
    }
    const waitedForSlotMs = Date.now() - startedAt;
    if (waitedForSlotMs >= timeoutMilliseconds) {
      fileSystem.rmSync(waiterPath, { force: true });
      return Object.freeze({
        waitedForSlotMs,
        queuePosition,
        reason: `Verification capture waited ${waitedForSlotMs}ms for the per-host full-suite slot at queue position ${queuePosition}; sibling capture contention exceeded the ${timeoutMilliseconds}ms limit.`
      });
    }
    await wait(captureSlotRetryMilliseconds);
  }
}
function captureSlotTimeout(command, slot) {
  return Object.freeze({
    kind: "command",
    status: "timeout",
    evidence: slot.reason,
    command,
    logPath: null,
    exitCode: 2,
    outputTail: null,
    failureIdentities: Object.freeze(["timeout:capture-slot-contention"]),
    reason: slot.reason,
    waitedForSlotMs: slot.waitedForSlotMs,
    queuePosition: slot.queuePosition
  });
}
function captureSlotCouldNotRun(command, slot) {
  return Object.freeze({
    kind: "command",
    status: "could_not_run",
    evidence: slot.reason,
    command,
    logPath: null,
    exitCode: 2,
    outputTail: null,
    failureIdentities: Object.freeze(["could_not_run:capture-slot"]),
    reason: slot.reason
  });
}
async function runFullSuiteCapture(command, project, cwd, fileSystem = fs) {
  let slot;
  try {
    slot = await acquireCaptureSlot(project, captureSlotTimeoutMilliseconds, fileSystem);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return captureSlotCouldNotRun(command, Object.freeze({
      reason: `Verification capture could not acquire its per-host full-suite slot: ${reason}`,
      errorCode: captureSlotErrorCode(error)
    }));
  }
  if ("reason" in slot) {
    return "waitedForSlotMs" in slot ? captureSlotTimeout(command, slot) : captureSlotCouldNotRun(command, slot);
  }
  let capture;
  let releaseFailure = null;
  try {
    capture = await runVerifyCapture(command, cwd, void 0, {
      ...process.env,
      SIDEQUEST_FULL_SUITE_SIBLING_CAPTURE_COUNT: String(slot.queuePosition - 1)
    });
  } finally {
    releaseFailure = await slot.release();
  }
  if (releaseFailure) return captureSlotCouldNotRun(command, releaseFailure);
  return Object.freeze({
    ...capture,
    waitedForSlotMs: slot.waitedForSlotMs,
    queuePosition: slot.queuePosition
  });
}
function captureTarget(args) {
  const projectIndex = args.indexOf("--project");
  const ticketIndex = args.indexOf("--ticket");
  const project = projectIndex >= 0 ? String(args[projectIndex + 1] || "").trim() : "";
  const ticket = ticketIndex >= 0 ? String(args[ticketIndex + 1] || "").trim() : "";
  return project && ticket ? Object.freeze({ project, ticket }) : null;
}
function captureProject(target) {
  const store = require("./store.js");
  const project = store.findProject(target.project);
  const projectPath = String(project.meta?.path || "").trim();
  return project.ok && project.slug && projectPath ? Object.freeze({ slug: project.slug, path: projectPath }) : null;
}
function captureWorkingDirectory(target, cwd) {
  const project = captureProject(target);
  if (!project) return cwd;
  const store = require("./store.js");
  const ticket = store.getTicket(project.slug, target.ticket);
  return store.workingTreeDeliveryCandidate(project.slug, ticket) ? project.path : cwd;
}
async function runCapturedVerification(command, target, cwd = process.cwd(), fileSystem = fs) {
  const captureCwd = target ? captureWorkingDirectory(target, cwd) : cwd;
  const capture = target && isFullSuiteCommand(command) ? await runFullSuiteCapture(command, target.project, captureCwd, fileSystem) : await runVerifyCapture(command, captureCwd);
  const recorded = target ? recordCapture(target, capture, captureCwd) : null;
  return Object.freeze({ capture, recorded });
}
function verifiedRevision(cwd) {
  try {
    const value = String(execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd,
      encoding: "utf8",
      windowsHide: true
    })).trim().toLowerCase();
    return value ? Object.freeze({ source: "git", value }) : null;
  } catch (_) {
    return null;
  }
}
function recordCapture(target, capture, cwd) {
  const store = require("./store.js");
  const project = store.findProject(target.project);
  if (!project.ok || !project.slug) return { ok: false, reason: "project_not_found" };
  const ticket = store.getTicket(project.slug, target.ticket);
  const workingTreeCandidate = store.workingTreeDeliveryCandidate(project.slug, ticket);
  const candidate = workingTreeCandidate?.candidate || verifiedRevision(cwd);
  if (!candidate) return { ok: false, reason: "verified_revision_unavailable" };
  return store.recordVerificationCapture(project.slug, target.ticket, {
    command: capture.command || "",
    status: capture.status,
    candidate,
    completedAt: (/* @__PURE__ */ new Date()).toISOString(),
    worktree: cwd,
    logPath: capture.logPath,
    exitCode: capture.exitCode,
    shell: capture.shell,
    ...capture.waitedForSlotMs === void 0 ? {} : { waitedForSlotMs: capture.waitedForSlotMs },
    ...capture.queuePosition === void 0 ? {} : { queuePosition: capture.queuePosition }
  });
}
function report(capture, recorded) {
  const reason = capture.reason ? ` reason=${JSON.stringify(capture.reason)}` : "";
  process.stdout.write(`verify=${capture.status} exit=${capture.exitCode ?? 2}${reason}
`);
  process.stdout.write(`shell=${capture.shell || ""}
`);
  process.stdout.write(`details=${capture.logPath || ""}
`);
  if (capture.waitedForSlotMs !== void 0) {
    process.stdout.write(`capture-slot waitedForSlotMs=${capture.waitedForSlotMs} queuePosition=${capture.queuePosition || 1}
`);
  }
  if (recorded?.ok && recorded.capture) {
    process.stdout.write(`capture=${recorded.capture.id} candidate=${recorded.capture.candidate.source}:${recorded.capture.candidate.value}
`);
  } else if (recorded) {
    process.stdout.write(`capture=unrecorded reason=${recorded.reason || "unknown"}
`);
  }
}
async function main() {
  const args = process.argv.slice(2);
  const encoded = args[0] === "--base64" ? args[1] : "";
  const command = encoded ? Buffer.from(encoded, "base64").toString("utf8").trim() : "";
  if (!command) {
    process.stderr.write("Usage: node verify-capture.js --base64 <base64 verify command> [--project <path> --ticket <ref>]\n");
    process.exitCode = 2;
    return;
  }
  const target = captureTarget(args);
  const { capture, recorded } = await runCapturedVerification(command, target);
  report(capture, recorded);
  process.exitCode = capture.exitCode === 0 && (!target || recorded?.ok) ? 0 : 2;
}
module.exports = { runVerifyCapture, runCapturedVerification, shellCommand, captureTarget, captureProject, captureSlotDirectory, isFullSuiteCommand, recordCapture, verifiedRevision };
if (require.main === module) void main();
