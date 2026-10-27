"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var completion_exports = {};
__export(completion_exports, {
  COMPLETION_TEXT_MAX_WORDS: () => COMPLETION_TEXT_MAX_WORDS,
  changesCatchupPayload: () => changesCatchupPayload,
  completionStage: () => completionStage,
  completionText: () => completionText,
  completionView: () => completionView,
  createCompletion: () => createCompletion,
  escapeCompletionText: () => escapeCompletionText
});
module.exports = __toCommonJS(completion_exports);
var import_node_path = __toESM(require("node:path"));
var import_integration_tests = require("../integration-tests.js");
const NOT_REQUIRED_CONTROL_KINDS = /* @__PURE__ */ new Set(["behavior-preserving-refactor", "inherited-read-only", "docs", "type-annotation-only", "fixture-only"]);
const DELIVERED_OUTCOMES = /* @__PURE__ */ new Set(["delivered", "verified"]);
const VERIFY_STATUS = {
  passed: "passed",
  failed_suite: "failed",
  failed_check: "failed",
  timeout: "failed",
  skipped: "skipped",
  manual: "manual",
  attestation: "manual"
};
const DELIVERY_METHOD = { merge: "merge", apply: "apply", replay: "replay", "cherry-pick": "replay", rebase: "replay" };
const QUALITY_STATUS = { measured: "measured-pass", failed: "measured-fail", unverified: "unverified", none: "none" };
const QUALITY_PRECEDENCE = ["measured-fail", "unverified", "none", "measured-pass"];
const QUALITY_WORDING = {
  "measured-pass": "measured, passed",
  "measured-fail": "measured, FAILED",
  unverified: "UNVERIFIED",
  "not-measured": "not measured (no quality record)",
  none: "not measured (no quality gate configured)"
};
const TERMINAL_STAGES = /* @__PURE__ */ new Set(["integrated", "released", "closed"]);
const SECTION_WORDS = { header: 14, result: 40, checked: 62, uncertain: 42, action: 30 };
const COMPLETION_TEXT_MAX_WORDS = 200;
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
function firstText(...values) {
  return values.map(text).find(Boolean) ?? "";
}
function shortCommit(value) {
  return /^[0-9a-f]{13,}$/i.test(value) ? value.slice(0, 12) : value;
}
function candidateOf(ticket) {
  const submission = ticket.submission;
  return text(submission?.commit) || text(submission?.sourceRevision?.value) || null;
}
function pendingSubmission(ticket) {
  return Boolean(candidateOf(ticket)) && !ticket.submission?.integratedAt;
}
function deliveredIntegration(ticket) {
  const integration = ticket.submission?.integration;
  return integration && DELIVERED_OUTCOMES.has(String(integration.outcome)) ? integration : null;
}
function openRejection(ticket) {
  const history = Array.isArray(ticket.rejectedSubmissions) ? ticket.rejectedSubmissions.filter(Boolean) : [];
  const latest = history[history.length - 1];
  return latest && !latest.supersededAt && !pendingSubmission(ticket) ? latest : null;
}
function integrationRunning(context) {
  const progress = context.integrationProgress;
  return progress?.state === "running" && progress.writerAlive !== false;
}
function submissionFacts(ticket) {
  const commit = candidateOf(ticket);
  if (!commit) return null;
  return { commit, at: text(ticket.submission?.at), by: text(ticket.submission?.by) };
}
function integrationDelivery(integration, ticket) {
  const commit = firstText(integration.deliveryCommit, integration.pinnedCommit, candidateOf(ticket));
  return {
    commit,
    branch: text(integration.targetBranch),
    head: firstText(integration.resultingHead, integration.sourceRevision?.value, commit),
    at: firstText(integration.deliveredAt, integration.recordedAt, ticket.submission?.integratedAt),
    method: DELIVERY_METHOD[String(integration.mode)] ?? "manual"
  };
}
function closureDelivery(ticket) {
  const delivery = ticket.completion?.delivery;
  const commit = text(delivery?.commit);
  if (!commit) return null;
  return { commit, branch: text(delivery?.targetBranch), head: commit, at: text(ticket.completion?.at), method: "manual" };
}
function deliveryFacts(ticket) {
  const integration = deliveredIntegration(ticket);
  return integration ? integrationDelivery(integration, ticket) : closureDelivery(ticket);
}
function candidateCapture(ticket) {
  const candidate = candidateOf(ticket);
  const captures = Array.isArray(ticket.verificationCaptures) ? ticket.verificationCaptures : [];
  return captures.slice().reverse().find((capture) => capture?.candidate?.value === candidate) ?? null;
}
function verifyRecord(ticket) {
  return ticket.submission?.integration?.verify ?? ticket.submission?.verificationResult ?? candidateCapture(ticket) ?? null;
}
function verifyStatus(record) {
  if (record.waiver) return "waived";
  return VERIFY_STATUS[String(record.status)] ?? "unavailable";
}
function isTestPath(file) {
  const normalized = file.replace(/\\/g, "/").toLowerCase();
  return /(^|\/)(?:test|tests|__tests__)(?:\/|$)/.test(normalized) || /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/.test(normalized);
}
function changedTestPaths(ticket) {
  const changed = Array.isArray(ticket.submission?.changedPaths) ? ticket.submission.changedPaths : [];
  return changed.map(String).filter(isTestPath);
}
function capturedCommand(ticket, record) {
  return Boolean(candidateCapture(ticket)) || Boolean(text(record.command) && text(record.logPath));
}
function verifyKinds(ticket, record, status, control) {
  const reviewed = ["accepted", "rejected"].includes(String(ticket.submission?.review?.outcome));
  const candidates = [
    [capturedCommand(ticket, record), "captured-command"],
    [changedTestPaths(ticket).length > 0, "mocked-test"],
    [reviewed, "source-review"],
    [control.evidence === "agent-reported", "agent-reported"],
    [status === "waived", "waived"],
    [status === "unavailable", "unavailable"]
  ];
  return candidates.filter(([present]) => present).map(([, kind]) => kind);
}
function verifyFacts(ticket, control, roots) {
  const record = verifyRecord(ticket);
  if (!record) return null;
  const status = verifyStatus(record);
  const logPath = approvedPath(text(record.logPath), roots);
  return { status, command: text(record.command) || text(ticket.submission?.verify) || null, logPath, kinds: verifyKinds(ticket, record, status, control) };
}
function qualityRows(ticket) {
  const rows = ticket.submission?.integration?.verify?.quality ?? ticket.submission?.verificationResult?.quality;
  return Array.isArray(rows) ? rows.filter(Boolean) : [];
}
function qualityDetail(rows) {
  const notes = rows.map((row) => text(row.captureGap) || text(row.debtTicketNote)).filter(Boolean);
  const enforced = rows.reduce((total, row) => total + (Number(row.enforced) || 0), 0);
  return notes[0] || (enforced ? `${enforced} bodies enforced` : null);
}
function qualityFacts(ticket) {
  const rows = qualityRows(ticket);
  if (!rows.length) return { status: "not-measured", detail: null };
  const statuses = new Set(rows.map((row) => QUALITY_STATUS[String(row.status)] ?? "unverified"));
  const status = QUALITY_PRECEDENCE.find((candidate) => statuses.has(candidate)) ?? "unverified";
  return { status, detail: qualityDetail(rows) };
}
function notRequiredControl(ticket) {
  const declared = text(ticket.dispatch?.workProvenance?.kind);
  if (NOT_REQUIRED_CONTROL_KINDS.has(declared)) return `not_required(${declared})`;
  const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
  const recorded = comments.map((comment) => /negativeControl: (not_required\([^)\n]*\))/.exec(String(comment?.body || ""))?.[1]).filter(Boolean);
  return recorded[recorded.length - 1] ?? null;
}
function controlFacts(ticket, context) {
  const notRequired = notRequiredControl(ticket);
  if (notRequired) return { kind: notRequired, evidence: "waived" };
  const kind = text(context.negativeControl?.kind) || "missing";
  if (kind === "failed") return { kind: "marker", evidence: "agent-reported" };
  return kind === "waived" ? { kind, evidence: "waived" } : { kind, evidence: "missing" };
}
function reviewFacts(ticket) {
  const review = ticket.submission?.review;
  if (!review?.ref) return null;
  return { bound: true, verdict: text(review.outcome) || null, by: text(review.ref) };
}
function releaseFacts(delivery, context) {
  const record = context.releaseRecord;
  const names = Boolean(delivery && record?.version && record.deliveryCommit === delivery.commit);
  return names ? { version: text(record?.version), evidence: "release-record" } : { version: null, evidence: "none" };
}
function summaryRecord(ticket) {
  const recorded = ticket.completionSummary;
  if (!recorded || recorded.version !== 1 || !text(recorded.result)) return null;
  const candidate = text(recorded.candidate) || null;
  return {
    version: 1,
    result: text(recorded.result),
    checked: text(recorded.checked),
    uncertain: text(recorded.uncertain),
    action: text(recorded.action),
    by: text(recorded.by),
    at: text(recorded.at),
    candidate,
    stale: candidate !== candidateOf(ticket)
  };
}
function comparablePath(value) {
  const resolved = import_node_path.default.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function insideRoot(candidate, root) {
  const base = comparablePath(root);
  return candidate === base || candidate.startsWith(base + "/");
}
function approvedPath(value, roots) {
  if (!value || !roots.length) return null;
  const absolute = import_node_path.default.isAbsolute(value) ? value : import_node_path.default.join(roots[0], value);
  const candidate = comparablePath(absolute);
  return roots.some((root) => insideRoot(candidate, root)) ? absolute : null;
}
function approvedRoots(context) {
  const roots = context.roots ?? {};
  return [roots.project, roots.verification, roots.evidence].map(text).filter(Boolean);
}
function evidenceEntries(ticket, roots) {
  const captures = (Array.isArray(ticket.verificationCaptures) ? ticket.verificationCaptures : []).filter((capture) => capture?.candidate?.value === candidateOf(ticket)).map((capture) => ({ kind: "captured-command", path: text(capture.logPath), label: `verify capture ${text(capture.status)}: ${text(capture.command)}` }));
  const gateLog = text(ticket.submission?.integration?.verify?.logPath);
  const gate = gateLog ? [{ kind: "captured-command", path: gateLog, label: "delivery gate log" }] : [];
  const tests = changedTestPaths(ticket).map((file) => ({ kind: "mocked-test", path: file, label: "changed test (no real-flow record)" }));
  return [...captures, ...gate, ...tests].map((entry) => ({ ...entry, path: approvedPath(entry.path, roots) ?? "" })).filter((entry) => entry.path);
}
const STAGE_RULES = [
  [(ticket) => ticket.submission?.integration?.outcome === "abandoned", "abandoned"],
  [(ticket, context) => ticket.status === "done" && releaseFacts(deliveryFacts(ticket), context).evidence === "release-record", "released"],
  [(ticket) => ticket.status === "done" && Boolean(deliveryFacts(ticket)), "integrated"],
  [(ticket) => ticket.status === "done", "closed"],
  [(ticket, context) => pendingSubmission(ticket) && integrationRunning(context), "integrating"],
  [(ticket) => pendingSubmission(ticket), "submitted"],
  [(ticket) => Boolean(openRejection(ticket)), "rejected"],
  [(ticket) => Boolean(text(ticket.claim?.by)), "running"],
  [(ticket, context) => Boolean(context.openBlockers?.length) || ticket.status === "awaiting-oracle", "blocked"]
];
function completionStage(ticket, context) {
  return STAGE_RULES.find(([applies]) => applies(ticket, context))?.[1] ?? "ready";
}
function blockedBlocker(ticket, context) {
  const refs = context.openBlockers ?? [];
  if (!refs.length) {
    const ask = text(ticket.oracle?.ask) || "the recorded oracle question";
    return { reason: "Waiting on a human verdict.", actor: "user", nextAction: `Answer: ${ask}` };
  }
  return { reason: `Blocked by ${refs.join(", ")}.`, actor: "dependency", nextAction: `Finish ${refs.join(", ")} first.`, refs: refs.slice() };
}
function rejectedBlocker(ticket) {
  const rejected = openRejection(ticket);
  const reason = text(rejected?.reason) || "no reason recorded";
  return {
    reason: `Candidate ${shortCommit(text(rejected?.commit))} was rejected: ${reason}`,
    actor: "executor",
    nextAction: "Dispatch the ticket so an executor reworks the rejected candidate."
  };
}
const BLOCKERS = {
  blocked: blockedBlocker,
  rejected: rejectedBlocker,
  ready: () => ({ reason: "Not dispatched yet.", actor: "orchestrator", nextAction: "Dispatch the ticket." }),
  proposed: () => ({ reason: "Not planned yet.", actor: "orchestrator", nextAction: "Groom the ticket." }),
  running: (ticket) => ({ reason: `Claimed by ${text(ticket.claim?.by)}.`, actor: "executor", nextAction: "Wait for the executor to submit." }),
  submitted: (ticket) => ({ reason: `Candidate ${shortCommit(candidateOf(ticket) || "")} awaits integration.`, actor: "orchestrator", nextAction: "Integrate the submitted candidate." }),
  integrating: () => ({ reason: "The integration gate is running.", actor: "board", nextAction: "Wait for the integration gate to finish." }),
  abandoned: () => ({ reason: "The submission was abandoned without landing.", actor: "orchestrator", nextAction: "Redispatch or close the ticket." })
};
function completionBlocker(stage, ticket, context) {
  return BLOCKERS[stage]?.(ticket, context) ?? null;
}
function completionFacts(ticket, context, summary) {
  const roots = approvedRoots(context);
  const negativeControl = controlFacts(ticket, context);
  const delivery = deliveryFacts(ticket);
  return {
    submission: submissionFacts(ticket),
    delivery,
    verify: verifyFacts(ticket, negativeControl, roots),
    quality: qualityFacts(ticket),
    negativeControl,
    review: reviewFacts(ticket),
    release: releaseFacts(delivery, context),
    candidateChanged: Boolean(summary?.stale) || Boolean(ticket.submission?.supersedesRejectedSubmission)
  };
}
function completionView(ticket, context = {}) {
  const summary = summaryRecord(ticket);
  const stage = completionStage(ticket, context);
  const view = {
    ref: ticket.ref,
    title: text(ticket.title),
    stage,
    blocker: completionBlocker(stage, ticket, context),
    facts: completionFacts(ticket, context, summary),
    summary,
    evidence: evidenceEntries(ticket, approvedRoots(context)),
    text: ""
  };
  view.text = completionText(view);
  return view;
}
const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeCompletionText(value) {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}
function words(value) {
  return value.split(/\s+/).filter(Boolean);
}
function clampWords(value, limit) {
  const all = words(value);
  return all.length <= limit ? all.join(" ") : all.slice(0, limit - 1).join(" ") + " ...";
}
function deliveryLine(delivery) {
  const branch = delivery.branch ? ` to ${delivery.branch}` : "";
  return `Delivered ${shortCommit(delivery.commit)}${branch} by ${delivery.method} at ${shortCommit(delivery.head)}.`;
}
const RESULT_LINES = {
  integrated: (view) => deliveryLine(view.facts.delivery),
  released: (view) => `${deliveryLine(view.facts.delivery)} Released in ${view.facts.release.version}.`,
  submitted: (view) => `Submitted ${shortCommit(view.facts.submission.commit)} by ${view.facts.submission.by || "an unrecorded actor"}; not integrated yet.`,
  integrating: (view) => `Submitted ${shortCommit(view.facts.submission.commit)}; integration is running.`,
  closed: () => "Closed without a delivery record.",
  rejected: (view) => view.blocker.reason,
  abandoned: () => "The submission was abandoned without landing.",
  running: (view) => `In progress. ${view.blocker.reason}`
};
function resultSection(view) {
  const factual = RESULT_LINES[view.stage]?.(view) ?? "No candidate yet.";
  if (!view.summary) return factual;
  const staleNote = view.summary.stale ? " (summary written for an older candidate)" : "";
  return `${view.summary.result}${staleNote} Record: ${factual}`;
}
function verifyClause(verify) {
  if (!verify) return "Verify: not recorded.";
  const kinds = verify.kinds.length ? verify.kinds.join(", ") : "none recorded";
  return `Verify ${verify.status}${verify.command ? ` (${verify.command})` : ""}; evidence: ${kinds}.`;
}
function reviewClause(review) {
  return review ? `Review ${review.by}: ${review.verdict || "no verdict yet"}.` : "Review: none bound.";
}
function controlClause(control) {
  return control.kind === control.evidence ? `Negative control: ${control.kind}.` : `Negative control: ${control.kind} (${control.evidence}).`;
}
function checkedSection(view) {
  const facts = view.facts;
  const agent = view.summary?.checked ? ` Agent says: ${view.summary.checked}` : "";
  return [
    verifyClause(facts.verify),
    `Quality: ${QUALITY_WORDING[facts.quality.status]}.`,
    controlClause(facts.negativeControl),
    reviewClause(facts.review)
  ].join(" ") + agent;
}
function hasCandidate(view) {
  return Boolean(view.facts.submission || view.facts.delivery);
}
function verifyDoubt(view) {
  const status = view.facts.verify?.status;
  if (!hasCandidate(view) || status === "passed") return null;
  return status ? `Verification ${status}.` : "No verification recorded.";
}
function qualityDoubt(view) {
  const status = view.facts.quality.status;
  return hasCandidate(view) && status !== "measured-pass" ? `Quality ${QUALITY_WORDING[status]}.` : null;
}
function controlDoubt(view) {
  const evidence = view.facts.negativeControl.evidence;
  if (!hasCandidate(view) || ["captured", "waived"].includes(evidence)) return null;
  return evidence === "agent-reported" ? "Negative control is agent-reported, not captured." : "No negative-control record.";
}
const DOUBTS = [
  (view) => view.summary?.stale ? "Summary describes an older candidate." : null,
  (view) => view.facts.candidateChanged && !view.summary?.stale ? "Candidate changed after a rejection." : null,
  verifyDoubt,
  qualityDoubt,
  controlDoubt,
  (view) => view.stage === "integrated" ? "No release record; shipping is unconfirmed." : null,
  (view) => view.summary?.uncertain ? `Agent says: ${view.summary.uncertain}` : null
];
function uncertainSection(view) {
  const doubts = DOUBTS.map((doubt) => doubt(view)).filter(Boolean);
  return doubts.length ? doubts.join(" ") : "Nothing flagged by the records.";
}
function actionSection(view) {
  const blocker = view.blocker;
  if (blocker?.actor === "user") return blocker.nextAction;
  const noAction = TERMINAL_STAGES.has(view.stage) || Boolean(blocker);
  const next = blocker ? ` Next (${blocker.actor}): ${blocker.nextAction}` : "";
  return noAction ? `No action needed.${next}` : "Check the ticket; the records name no next step.";
}
function completionText(view) {
  const sections = [
    ["", `${view.ref} ${view.title} [${view.stage}]`, SECTION_WORDS.header],
    ["Result: ", resultSection(view), SECTION_WORDS.result],
    ["Checked: ", checkedSection(view), SECTION_WORDS.checked],
    ["Still uncertain: ", uncertainSection(view), SECTION_WORDS.uncertain],
    ["Your action: ", actionSection(view), SECTION_WORDS.action]
  ];
  return sections.map(([label, body, limit]) => label + escapeCompletionText(clampWords(body, limit))).join("\n");
}
function catchupField(value) {
  return escapeCompletionText(value.replace(/\s+/g, " ").trim().slice(0, 180));
}
function catchupAction(slug, view, store) {
  const refs = view.blocker?.refs ?? [];
  const scheduled = refs.length > 0 && refs.every((ref) => Boolean(store.getTicket(slug, ref)?.claim?.by));
  if (scheduled) return "The agent will continue when they finish.";
  return view.blocker?.nextAction ?? "no action";
}
function catchupRow(slug, ref, store) {
  const view = store.completionPayload(slug, ref);
  const blocker = view.blocker;
  const actor = blocker?.actor ?? null;
  const nextAction = catchupAction(slug, view, store);
  const detail = blocker?.reason ?? view.title;
  const line = [ref, view.stage, catchupField(detail), catchupField(nextAction)].join(" · ");
  return { ref, stage: view.stage, actor, blocker, nextAction, line };
}
function changesCatchupPayload(slug, delta, store) {
  const tickets = delta.tickets.slice(0, 40).map(({ ref }) => catchupRow(slug, ref, store));
  const omitted = delta.tickets.length - tickets.length;
  const lines = tickets.map((ticket) => ticket.line);
  if (omitted) lines.push("+" + omitted + " more, narrow since");
  if (!lines.length) lines.push("nothing changed since " + delta.since);
  return { since: delta.since, serverTime: delta.serverTime, tickets, omitted, text: lines.join("\n") };
}
function createCompletion(dependencies) {
  const { getTicket, openBlockers, negativeControlResult, projectDir, readMeta } = dependencies;
  function controlHolder(ticket) {
    const holder = text(ticket.claim?.by) || text(ticket.submission?.by);
    return { ...ticket, claim: holder ? { by: holder } : null };
  }
  function completionContext(slug, ticket) {
    const boardDirectory = projectDir(slug);
    return {
      openBlockers: openBlockers(slug, ticket),
      integrationProgress: (0, import_integration_tests.readIntegrationProgress)((0, import_integration_tests.integrationProgressPath)(boardDirectory, ticket.ref)),
      negativeControl: negativeControlResult(controlHolder(ticket)),
      releaseRecord: null,
      roots: {
        project: readMeta(slug)?.path ?? null,
        verification: import_node_path.default.join(boardDirectory, "verification"),
        evidence: ticket.dispatch?.evidenceDirectory ?? null
      }
    };
  }
  function completionPayload(slug, idOrRef) {
    const ticket = getTicket(slug, idOrRef);
    return ticket ? completionView(ticket, completionContext(slug, ticket)) : null;
  }
  return { completionPayload };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  COMPLETION_TEXT_MAX_WORDS,
  changesCatchupPayload,
  completionStage,
  completionText,
  completionView,
  createCompletion,
  escapeCompletionText
});
