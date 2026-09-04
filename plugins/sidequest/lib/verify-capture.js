"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { runProcessVerification, shellCommand } = require("./ports/process.js");
const captureSlotTimeoutMilliseconds = 30 * 60 * 1e3;
const captureSlotRetryMilliseconds = 50;
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
function captureSlotWaiterPath(slotDirectory) {
  const waitingDirectory = path.join(slotDirectory, "waiting");
  fs.mkdirSync(waitingDirectory, { recursive: true });
  return path.join(waitingDirectory, `${Date.now().toString().padStart(15, "0")}-${process.pid}-${randomUUID()}.json`);
}
function queuedWaiters(slotDirectory) {
  try {
    return fs.readdirSync(path.join(slotDirectory, "waiting")).sort();
  } catch {
    return [];
  }
}
function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function acquireCaptureSlot(project, timeoutMilliseconds = captureSlotTimeoutMilliseconds) {
  const slotDirectory = captureSlotDirectory(project);
  const activeDirectory = path.join(slotDirectory, "active");
  const startedAt = Date.now();
  const waiterPath = captureSlotWaiterPath(slotDirectory);
  const waiterName = path.basename(waiterPath);
  fs.writeFileSync(waiterPath, "", { encoding: "utf8", flag: "wx" });
  let waitingAnnounced = false;
  let queuePosition = 1;
  for (; ; ) {
    const waiterIndex = queuedWaiters(slotDirectory).indexOf(waiterName);
    const active = fs.existsSync(activeDirectory);
    queuePosition = Math.max(queuePosition, waiterIndex + (active ? 2 : 1));
    if (!active && waiterIndex === 0) {
      try {
        fs.mkdirSync(activeDirectory);
        fs.rmSync(waiterPath, { force: true });
        return Object.freeze({
          waitedForSlotMs: Date.now() - startedAt,
          queuePosition,
          release: () => fs.rmSync(activeDirectory, { recursive: true, force: true })
        });
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
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
      fs.rmSync(waiterPath, { force: true });
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
async function runFullSuiteCapture(command, project, cwd) {
  let slot;
  try {
    slot = await acquireCaptureSlot(project);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return Object.freeze({
      kind: "command",
      status: "could_not_run",
      evidence: `Verification capture could not acquire its per-host full-suite slot: ${reason}`,
      command,
      logPath: null,
      exitCode: 2,
      outputTail: null,
      failureIdentities: Object.freeze(["could_not_run:capture-slot"]),
      reason
    });
  }
  if ("reason" in slot) return captureSlotTimeout(command, slot);
  try {
    const capture = await runVerifyCapture(command, cwd, void 0, {
      ...process.env,
      SIDEQUEST_FULL_SUITE_SIBLING_CAPTURE_COUNT: String(slot.queuePosition - 1)
    });
    return Object.freeze({
      ...capture,
      waitedForSlotMs: slot.waitedForSlotMs,
      queuePosition: slot.queuePosition
    });
  } finally {
    slot.release();
  }
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
async function runCapturedVerification(command, target, cwd = process.cwd()) {
  const captureCwd = target ? captureWorkingDirectory(target, cwd) : cwd;
  const capture = target && isFullSuiteCommand(command) ? await runFullSuiteCapture(command, target.project, captureCwd) : await runVerifyCapture(command, captureCwd);
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
