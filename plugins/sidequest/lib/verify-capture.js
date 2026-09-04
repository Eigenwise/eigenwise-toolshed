"use strict";
const { execFileSync } = require("node:child_process");
const { runProcessVerification, shellCommand } = require("./ports/process.js");
function captureRequirement(command) {
  return Object.freeze({ kind: "command", command, evidenceContract: "command output" });
}
async function runVerifyCapture(command, cwd = process.cwd(), timeoutMilliseconds) {
  const result = runProcessVerification(captureRequirement(command), {
    cwd,
    ...timeoutMilliseconds === void 0 ? {} : { timeoutMilliseconds }
  });
  return Object.freeze({
    ...result,
    exitCode: result.exitCode ?? null,
    ...result.status === "passed" ? {} : { reason: result.evidence }
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
async function runCapturedVerification(command, target, cwd = process.cwd()) {
  const captureCwd = target ? captureWorkingDirectory(target, cwd) : cwd;
  const capture = await runVerifyCapture(command, captureCwd);
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
    shell: capture.shell
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
module.exports = { runVerifyCapture, runCapturedVerification, shellCommand, captureTarget, captureProject, recordCapture, verifiedRevision };
if (require.main === module) void main();
