"use strict";
const { reviewCandidateFromSubmission, reviewOutcomeFromOracleVerdict, sameReviewCandidate } = require("../kernel/review-binding");
function createPlans(dependencies) {
  const {
    assetPath,
    assetsDir,
    clearOracleMarker,
    createComment,
    fs,
    getTicket,
    isReadOnlyExecutor,
    nullableText,
    path,
    putTicket,
    queueEventNotification,
    stripControlChars,
    withTicketLock
  } = dependencies;
  const PLAN_ASSET_NAME = "plan.md";
  const PLAN_BODY_MAX_BYTES = 256 * 1024;
  function planAssetPath(slug, ticket) {
    return assetPath(slug, ticket.id, PLAN_ASSET_NAME);
  }
  function writeTicketPlan(slug, idOrRef, by, body) {
    const text = stripControlChars(String(body == null ? "" : body)).trim();
    if (!text) return { ok: false, reason: "empty" };
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > PLAN_BODY_MAX_BYTES) {
      return { ok: false, reason: "too_long", max: PLAN_BODY_MAX_BYTES, length: bytes };
    }
    const found = getTicket(slug, idOrRef);
    if (!found) return { ok: false, reason: "not_found" };
    return withTicketLock(slug, found.id, () => {
      const ticket = getTicket(slug, found.id);
      if (!ticket) return { ok: false, reason: "not_found" };
      fs.mkdirSync(assetsDir(slug, ticket.id), { recursive: true });
      fs.writeFileSync(planAssetPath(slug, ticket), text);
      if (!Array.isArray(ticket.assets)) ticket.assets = [];
      if (!ticket.assets.includes(PLAN_ASSET_NAME)) ticket.assets.push(PLAN_ASSET_NAME);
      const revision = (Number(ticket.plan && ticket.plan.revision) || 0) + 1;
      const at = (/* @__PURE__ */ new Date()).toISOString();
      ticket.plan = { revision, by: String(by || "agent"), at };
      ticket.updatedAt = at;
      putTicket(slug, ticket);
      return { ok: true, ticket, plan: ticket.plan, path: planAssetPath(slug, ticket) };
    });
  }
  function ticketPlanInfo(slug, idOrRef) {
    const ticket = getTicket(slug, idOrRef);
    if (!ticket || !ticket.plan || !ticket.plan.revision) return null;
    const file = planAssetPath(slug, ticket);
    if (!fs.existsSync(file)) return null;
    return { path: file, revision: ticket.plan.revision, by: ticket.plan.by, at: ticket.plan.at };
  }
  function experimentAssetName(ticket) {
    return `experiment-${String(ticket?.ref || ticket?.id || "ticket").replace(/[^a-z0-9_-]/gi, "_")}.md`;
  }
  function experimentLogTemplate(ticket) {
    return `# Experiment log — ${ticket.ref}

## Ruled out

## Standing constraints
`;
  }
  function experimentLine(value, label) {
    const line = String(value == null ? "" : value).replace(/[\r\n]+/g, " ").trim();
    if (!line) throw new Error(`${label || "Experiment value"} is required.`);
    return line;
  }
  function experimentText(value) {
    return String(value == null ? "" : value).trim();
  }
  function experimentRound(value) {
    const round = Number(value);
    if (!Number.isInteger(round) || round < 1) throw new Error("Experiment round must be a positive integer.");
    return round;
  }
  function experimentLogForTicket(slug, ticket) {
    const asset = experimentAssetName(ticket);
    const file = assetPath(slug, ticket.id, asset);
    return { asset, file };
  }
  function writeExperimentLog(slug, ticket, log) {
    const { asset, file } = experimentLogForTicket(slug, ticket);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, log);
    if (!Array.isArray(ticket.assets)) ticket.assets = [];
    if (!ticket.assets.includes(asset)) ticket.assets.push(asset);
    ticket.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    putTicket(slug, ticket);
    return { asset, file };
  }
  function readExperimentLog(slug, ticket) {
    const { asset, file } = experimentLogForTicket(slug, ticket);
    if (!fs.existsSync(file)) return null;
    return { asset, file, log: fs.readFileSync(file, "utf8") };
  }
  function experimentSections(log) {
    const source = String(log || "");
    const ruledOut = source.match(/^## Ruled out\r?\n([\s\S]*?)(?=^## Standing constraints\r?$)/m);
    const constraints = source.match(/^## Standing constraints\r?\n([\s\S]*?)(?=^## R\d+\b|\s*$)/m);
    if (!ruledOut || !constraints) throw new Error("Experiment log is missing its pinned sections.");
    return { ruledOut: (ruledOut[1] || "").trim(), constraints: (constraints[1] || "").trim() };
  }
  function experimentEntries(log) {
    const source = String(log || "");
    const matches = [...source.matchAll(/^## R(\d+) — ([^\r\n]+)\r?$/gm)];
    return matches.map((match, index) => {
      const start = match.index ?? source.length;
      const end = matches[index + 1]?.index ?? source.length;
      return {
        round: Number(match[1]),
        headline: `R${match[1]} — ${match[2]}`,
        start,
        end,
        block: source.slice(start, end).trim()
      };
    });
  }
  function withExperimentLog(slug, idOrRef, change) {
    const found = getTicket(slug, idOrRef);
    if (!found) return { ok: false, reason: "not_found" };
    return withTicketLock(slug, found.id, () => {
      const ticket = getTicket(slug, found.id);
      if (!ticket) return { ok: false, reason: "not_found" };
      const existing = readExperimentLog(slug, ticket);
      const log = existing ? existing.log : experimentLogTemplate(ticket);
      const result = change(ticket, log);
      if (!result || typeof result.log !== "string") return result;
      const location = writeExperimentLog(slug, ticket, result.log);
      return Object.assign({ ok: true }, location, result.result || {});
    });
  }
  function experimentLines(value, map) {
    if (value == null) return [];
    const entries = Array.isArray(value) ? value : [value];
    return entries.map(map).filter(Boolean);
  }
  function experimentEntryBlock(entry) {
    return [
      `## R${entry.round} — ${entry.date} — ${entry.headline}`,
      `Hypothesis: ${entry.hypothesis}`,
      `Change: ${entry.change} (commit ${entry.commit}, branch ${entry.branch})`,
      `Measured: ${entry.measured}`,
      `Deliverable: ${entry.deliverable}`,
      `Verdict: "${entry.verdict}" — ${entry.outcome}`,
      `Why it failed: ${entry.whyItFailed}`,
      `Constraint bought: ${entry.constraintBought}`,
      `Status: ${entry.status}`
    ].join("\n");
  }
  function oracleExperimentEntryBlock(oracle) {
    const date = String(oracle.at || (/* @__PURE__ */ new Date()).toISOString()).slice(0, 10);
    return experimentEntryBlock({
      round: oracle.round,
      date,
      headline: "Oracle verdict",
      hypothesis: oracle.ask,
      change: "",
      commit: oracle.candidate || "",
      branch: "",
      measured: "",
      deliverable: oracle.deliverable || "",
      verdict: "",
      outcome: "",
      whyItFailed: "",
      constraintBought: "",
      status: ""
    });
  }
  function writeOracleExperimentRound(slug, ticket) {
    const oracle = ticket?.oracle;
    if (!oracle) throw new Error("Oracle experiment round requires an active oracle marker.");
    const existing = readExperimentLog(slug, ticket);
    const log = existing ? existing.log : experimentLogTemplate(ticket);
    if (experimentEntries(log).some((entry) => entry.round === oracle.round)) return null;
    return writeExperimentLog(slug, ticket, `${String(log).trimEnd()}

${oracleExperimentEntryBlock(oracle)}
`);
  }
  function appendExperimentEntry(slug, idOrRef, entry) {
    entry = entry || {};
    const round = experimentRound(entry.round);
    const headline = experimentLine(entry.headline || entry.title, "Experiment headline");
    const date = experimentLine(entry.date || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10), "Experiment date");
    const hypothesis = experimentText(entry.hypothesis);
    const change = experimentText(entry.change);
    const commit = experimentText(entry.commit);
    const branch = experimentText(entry.branch);
    const measured = experimentText(entry.measured);
    const deliverable = experimentText(entry.deliverable);
    const verdict = experimentText(entry.verdict ?? entry.verdictText);
    const outcome = experimentText(entry.outcome);
    const whyItFailed = experimentText(entry.whyItFailed ?? entry.why);
    const constraintBought = experimentText(entry.constraintBought ?? entry.constraint);
    const status = experimentText(entry.status);
    return withExperimentLog(slug, idOrRef, (_ticket, log) => {
      if (experimentEntries(log).some((current) => current.round === round)) {
        return { ok: false, reason: "round_exists" };
      }
      const ruledOut = experimentLines(entry.ruledOut, (item) => {
        if (typeof item === "string") return `- ${experimentLine(item, "Ruled-out entry")}`;
        return `- ${experimentLine(item?.line ?? item?.value, "Ruled-out entry")} — ${experimentLine(item?.why, "Ruled-out reason")}`;
      });
      const constraints = experimentLines(entry.standingConstraints ?? entry.constraints, (item) => {
        if (typeof item === "string") return `- [R${round}] ${experimentLine(item, "Standing constraint")}`;
        const boughtBy = experimentRound(item?.round ?? item?.boughtBy ?? round);
        return `- [R${boughtBy}] ${experimentLine(item?.line ?? item?.value, "Standing constraint")}`;
      });
      let next = String(log);
      if (ruledOut.length) next = next.replace(/(^## Ruled out\r?\n)([\s\S]*?)(?=^## Standing constraints\r?$)/m, (_all, heading, body) => `${heading}${body.trimEnd()}${body.trim() ? "\n" : ""}${ruledOut.join("\n")}
`);
      if (constraints.length) next = next.replace(/(^## Standing constraints\r?\n)([\s\S]*?)(?=^## R\d+\b|\s*$)/m, (_all, heading, body) => `${heading}${body.trimEnd()}${body.trim() ? "\n" : ""}${constraints.join("\n")}

`);
      const block = experimentEntryBlock({
        round,
        date,
        headline,
        hypothesis,
        change,
        commit,
        branch,
        measured,
        deliverable,
        verdict,
        outcome,
        whyItFailed,
        constraintBought,
        status
      });
      return { log: `${next}

${block}
`, result: { round } };
    });
  }
  function verdictOutcome(value) {
    const outcome = String(value == null ? "" : value).trim().toLowerCase();
    if (outcome === "accepted") return "accepted";
    if (outcome === "rejected") return "rejected";
    if (outcome === "inconclusive") return "inconclusive";
    throw new Error("Verdict outcome must be accepted, rejected, or inconclusive.");
  }
  function verdictStatus(outcome, candidate) {
    const suffix = nullableText(candidate) ? ` ${nullableText(candidate)}` : "";
    if (outcome === "accepted") return `accepted${suffix}`;
    if (outcome === "rejected") return `DO-NOT-MERGE${suffix}`;
    return `inconclusive${suffix}`;
  }
  function replaceExperimentEntryField(block, label, value, nextLabel) {
    const escaped = String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const nextEscaped = String(nextLabel || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = nextLabel ? new RegExp(`^${escaped}:.*?(?=^${nextEscaped}:)`, "ms") : new RegExp(`^${escaped}:.*$`, "m");
    if (!pattern.test(String(block))) throw new Error(`Experiment round is missing its ${label} field.`);
    return String(block).replace(pattern, `${label}: ${value}${nextLabel ? "\n" : ""}`);
  }
  function appendStandingConstraint(log, round, constraint) {
    if (!constraint) return String(log);
    return String(log).replace(
      /(^## Standing constraints\r?\n)([\s\S]*?)(?=^## R\d+\b|\s*$)/m,
      (_all, heading, body) => `${heading}${body.trimEnd()}${body.trim() ? "\n" : ""}- [R${round}] ${constraint}

`
    );
  }
  function recordBoundReviewOutcome(slug, reviewTicket, outcome) {
    const target = reviewTicket?.reviewTarget;
    if (!target?.ticketId || !target?.candidate) return null;
    const sourceTicket = getTicket(slug, target.ticketId);
    const sourceCandidate = reviewCandidateFromSubmission(sourceTicket?.submission);
    if (!sourceTicket?.submission || target.ref && String(target.ref).toUpperCase() !== String(sourceTicket.ref || "").toUpperCase() || !sameReviewCandidate(sourceCandidate, target.candidate)) {
      throw new Error(`review outcome could not verify the bound source for ${reviewTicket.ref}`);
    }
    const mirror = sourceTicket.submission.review;
    if (mirror && (mirror.ticketId && String(mirror.ticketId) !== String(reviewTicket.id) || mirror.ref && String(mirror.ref).toUpperCase() !== String(reviewTicket.ref || "").toUpperCase() || mirror.candidate && !sameReviewCandidate(mirror.candidate, target.candidate))) {
      throw new Error(`review outcome could not verify the bound mirror for ${reviewTicket.ref}`);
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    reviewTicket.reviewTarget = Object.assign({}, target, { outcome });
    sourceTicket.submission = Object.assign({}, sourceTicket.submission, {
      review: {
        ticketId: reviewTicket.id,
        ref: reviewTicket.ref,
        candidate: target.candidate,
        createdAt: mirror?.createdAt || now,
        outcome
      }
    });
    sourceTicket.updatedAt = now;
    putTicket(slug, sourceTicket);
    return { sourceRef: sourceTicket.ref, outcome };
  }
  function acceptedReadonlyReviewOracle(ticket, outcome) {
    return outcome === "accepted" && ticket?.release?.kind === "oracle" && Boolean(ticket?.reviewTarget?.ticketId) && (ticket?.dispatch?.readonly === true || isReadOnlyExecutor(ticket?.dispatch?.executor));
  }
  function completeAcceptedReadonlyReview(slug, ticket, text) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const comment = createComment({
      by: "oracle",
      body: `Oracle verdict (accepted): ${text}`,
      kind: "comment",
      source: "mcp"
    }, now);
    if (!Array.isArray(ticket.comments)) ticket.comments = [];
    ticket.comments.push(comment);
    ticket.status = "done";
    ticket.statusTransition = { from: "awaiting-oracle", to: "done", at: now };
    ticket.completion = {
      key: [ticket.id, now, "oracle", "done"].join(":"),
      by: "oracle",
      state: "done",
      claimAt: null,
      at: now,
      commentId: comment.id,
      purpose: "oracle-review-verdict"
    };
    ticket.lastEventType = "status";
    ticket.lastEventSource = "mcp";
    ticket.updatedAt = now;
    return comment;
  }
  function applyExperimentVerdict(slug, idOrRef, input) {
    const text = String(input?.text == null ? "" : input.text);
    if (!text.trim()) throw new Error("Verdict text is required and must preserve the user's words.");
    const outcome = verdictOutcome(input?.outcome);
    const why = experimentText(input?.why);
    const constraint = experimentText(input?.constraint);
    const found = getTicket(slug, idOrRef);
    if (!found) return { ok: false, reason: "not_found" };
    return withTicketLock(slug, found.id, () => {
      const ticket = getTicket(slug, found.id);
      if (!ticket) return { ok: false, reason: "not_found" };
      const oracle = ticket.oracle;
      if (!oracle || ticket.status !== "awaiting-oracle") {
        return {
          ok: false,
          reason: "no_oracle",
          message: `${ticket.ref} is not awaiting an oracle verdict. Release an active experiment round with --oracle before recording a verdict, or link a completed review-audit ticket for a high-stakes review pass.`
        };
      }
      const existing = readExperimentLog(slug, ticket);
      let log = existing ? existing.log : experimentLogTemplate(ticket);
      let entry = experimentEntries(log).find((current) => current.round === oracle.round);
      if (!entry) {
        const block2 = oracleExperimentEntryBlock(oracle);
        log = `${String(log).trimEnd()}

${block2}
`;
        entry = experimentEntries(log).find((current) => current.round === oracle.round);
      }
      if (!entry) throw new Error("Oracle verdict round could not be created.");
      let block = replaceExperimentEntryField(entry.block, "Verdict", `"${text}" — ${outcome}`, "Why it failed");
      block = replaceExperimentEntryField(block, "Why it failed", why, "Constraint bought");
      block = replaceExperimentEntryField(block, "Constraint bought", constraint, "Status");
      block = replaceExperimentEntryField(block, "Status", verdictStatus(outcome, oracle.candidate));
      log = `${String(log).slice(0, entry.start)}${block}
${String(log).slice(entry.end).trimStart()}`;
      log = appendStandingConstraint(log, oracle.round, constraint);
      ticket.oracle = Object.assign({}, oracle, { verdict: { text, outcome, why, constraint, at: (/* @__PURE__ */ new Date()).toISOString() } });
      const reviewOutcome = recordBoundReviewOutcome(slug, ticket, reviewOutcomeFromOracleVerdict(outcome));
      const completionComment = acceptedReadonlyReviewOracle(ticket, outcome) ? completeAcceptedReadonlyReview(slug, ticket, text) : null;
      if (!completionComment) {
        const previousStatus = ticket.status;
        ticket.status = "todo";
        if (previousStatus !== ticket.status) ticket.statusTransition = { from: previousStatus, to: ticket.status, at: (/* @__PURE__ */ new Date()).toISOString() };
      }
      const location = writeExperimentLog(slug, ticket, log);
      putTicket(slug, ticket);
      if (completionComment) {
        queueEventNotification(slug, ticket, "status", "mcp");
        queueEventNotification(slug, ticket, "comment", "mcp", { commentBody: completionComment.body });
      }
      return Object.assign({ ok: true, round: oracle.round, outcome }, location, reviewOutcome ? { reviewOutcome } : {}, completionComment ? { completionComment } : {});
    });
  }
  function appendOverturnLine(slug, idOrRef, priorRound, overturningRound, line) {
    const options = priorRound && typeof priorRound === "object" ? priorRound : null;
    const target = experimentRound(options ? options.priorRound ?? options.targetRound ?? options.round : priorRound);
    const overturning = experimentRound(options ? options.overturningRound ?? options.byRound ?? options.overturnedBy : overturningRound);
    const text = experimentLine(options ? options.line : line, "Overturn line");
    return withExperimentLog(slug, idOrRef, (_ticket, log) => {
      const entries = experimentEntries(log);
      const entry = entries.find((current) => current.round === target);
      if (!entry) return { ok: false, reason: "round_not_found" };
      if (/^> Overturned by R\d+:/m.test(entry.block)) return { ok: false, reason: "already_overturned" };
      const insertion = `
> Overturned by R${overturning}: ${text}`;
      return { log: `${String(log).slice(0, entry.end).trimEnd()}${insertion}
${String(log).slice(entry.end)}`, result: { priorRound: target, overturningRound: overturning } };
    });
  }
  function experimentPacket(slug, idOrRef) {
    const ticket = getTicket(slug, idOrRef);
    if (!ticket) return null;
    const existing = readExperimentLog(slug, ticket);
    if (!existing) return null;
    return { asset: existing.asset, path: existing.file, packet: existing.log };
  }
  return {
    PLAN_ASSET_NAME,
    PLAN_BODY_MAX_BYTES,
    appendExperimentEntry,
    appendOverturnLine,
    applyExperimentVerdict,
    experimentPacket,
    ticketPlanInfo,
    writeOracleExperimentRound,
    writeTicketPlan
  };
}
module.exports = { createPlans };
