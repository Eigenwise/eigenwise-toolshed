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
var intake_exports = {};
__export(intake_exports, {
  createIntake: () => createIntake,
  newStoryIntake: () => newStoryIntake,
  normalizeIntakeExempt: () => normalizeIntakeExempt,
  requiredIntakeText: () => requiredIntakeText
});
module.exports = __toCommonJS(intake_exports);
function requiredIntakeText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`story_intake: ${name} is required.`);
  return value.trim();
}
function normalizeIntakeExempt(value) {
  if (value === null) return null;
  if (typeof value !== "object") throw new Error("intakeExempt must be { reason } or null.");
  const reason = requiredIntakeText(Reflect.get(value, "reason"), "reason");
  if (reason.length < 20) throw new Error("intakeExempt reason must be at least 20 characters and name size, reversibility and stakes.");
  return { reason };
}
function newStoryIntake(by = "orchestrator", at) {
  return { status: "drafting", requester: { by, at }, delegates: [], sizing: null, playback: null, cycles: [], questions: [], optionsConsidered: [], approval: null, reopened: [] };
}
function requireRequester(intake, by) {
  if (intake.requester.by !== by) throw new Error("story_intake: only the requester may name a delegate.");
}
function approveIntake(story, intake, stamp) {
  const authorized = /* @__PURE__ */ new Set([intake.requester.by, ...intake.delegates.map((delegate) => delegate.by)]);
  if (!authorized.has(stamp.by)) throw new Error("story_intake approve: by must be the requester or a requester-named delegate.");
  intake.approval = { ...stamp, contractRevision: story.contractRevision };
  intake.status = "approved";
}
function intakeSizing(input, stamp) {
  const size = input.size;
  if (size !== "one-ticket" && size !== "one-wave" && size !== "multi-wave") throw new Error("story_intake: size must be one-ticket, one-wave or multi-wave.");
  return { ...stamp, size, reason: requiredIntakeText(input.reason, "reason") };
}
function validateIntakeOption(option) {
  return { label: requiredIntakeText(option.label, "option label"), reason: requiredIntakeText(option.reason, "option reason"), ...option.recommended === true ? { recommended: true } : {} };
}
function addIntakeQuestion(intake, input, stamp) {
  if (!Array.isArray(input.options) || !input.options.length) throw new Error("story_intake: options must be a non-empty array.");
  intake.questions.push({ ...stamp, id: `q${intake.questions.length + 1}`, text: requiredIntakeText(input.text, "text"), options: input.options.map(validateIntakeOption), answer: null, answeredBy: null, answeredAt: null });
  intake.status = "awaiting-human";
}
function answerIntakeQuestion(intake, input, stamp) {
  const question = intake.questions.find((question2) => question2.id === input.id);
  if (!question) throw new Error("story_intake: unknown question id.");
  Object.assign(question, { answer: requiredIntakeText(input.answer, "answer"), answeredBy: stamp.by, answeredAt: stamp.at });
  delete question.assumption;
  if (input.assumption === true) question.assumption = true;
}
function intakeTicketReference(value) {
  const reference = requiredIntakeText(value, "ticket ref").toUpperCase();
  if (!/^SQ-\d+$/.test(reference)) throw new Error("story_intake: ticket refs must use SQ-n.");
  return reference;
}
function recordIntakeCycle(intake, input, stamp) {
  intake.cycles.push({ ...stamp, n: intake.cycles.length + 1, reviewRef: intakeTicketReference(input.review), findingsSummary: requiredIntakeText(input.findings, "findings"), researchRefs: (input.research || []).map(intakeTicketReference) });
  if (intake.status === "drafting") intake.status = "reviewing";
}
function reopenIntake(intake, input, stamp) {
  intake.reopened.push({ ...stamp, reason: requiredIntakeText(input.reason, "reason") });
  intake.approval = null;
  intake.status = "reopened";
}
function mutateIntake(story, intake, input, stamp) {
  const actions = {
    playback: () => {
      intake.playback = { ...stamp, text: requiredIntakeText(input.text, "text") };
    },
    sizing: () => {
      intake.sizing = intakeSizing(input, stamp);
    },
    question: () => addIntakeQuestion(intake, input, stamp),
    answer: () => answerIntakeQuestion(intake, input, stamp),
    cycle: () => recordIntakeCycle(intake, input, stamp),
    approve: () => approveIntake(story, intake, stamp),
    delegate: () => {
      requireRequester(intake, requiredIntakeText(input.namedBy, "namedBy"));
      intake.delegates.push({ ...stamp, namedBy: input.namedBy });
    },
    reopen: () => reopenIntake(intake, input, stamp)
  };
  if (!Object.hasOwn(actions, input.action)) throw new Error("story_intake: unknown action.");
  actions[input.action]();
}
function categoryReference(ticket) {
  const category = typeof ticket.category === "string" ? ticket.category : ticket.category?.id;
  return ticket.categoryId || category || "";
}
function createIntake(dependencies) {
  function readOnlyCategory(slug, ticket) {
    if (typeof ticket.category === "object" && ticket.category?.readonly === true) return true;
    return dependencies.getCategory(categoryReference(ticket), { project: slug })?.readonly === true;
  }
  function intakeDispatchRefusal(slug, ticket) {
    if (dependencies.boardConfig(slug).intake.mode === "off") return null;
    if (readOnlyCategory(slug, ticket)) return null;
    if (ticket.intakeExempt) return null;
    if (!ticket.storyId) return null;
    return storyApprovalRefusal(slug, ticket.storyId);
  }
  function storyApprovalRefusal(slug, storyId) {
    const story = dependencies.getStory(slug, storyId);
    if (story?.intake?.approval?.contractRevision === story?.contractRevision && story?.intake?.approval) return null;
    return { reason: "intake_not_approved", message: `${story?.ref || storyId} intake is ${story?.intake?.status || "drafting"}. Run the intake round and approve through story_intake approve, or set intakeExempt with a reason naming size, reversibility and stakes.` };
  }
  function storyIntake(slug, input) {
    const by = requiredIntakeText(input.by, "by");
    if (input.action === "exempt") return exemptTicket(slug, input, by);
    return dependencies.transaction(() => {
      const story = dependencies.getStory(slug, requiredIntakeText(input.story, "story"));
      if (!story) throw new Error("story_intake: story not found.");
      const at = (/* @__PURE__ */ new Date()).toISOString();
      const intake = structuredClone(story.intake || newStoryIntake("orchestrator", at));
      mutateIntake(story, intake, input, { by, at });
      dependencies.putStory(slug, { ...story, intake, updatedAt: at });
      return { ...story, intake, updatedAt: at };
    });
  }
  function exemptTicket(slug, input, by) {
    const intakeExempt = normalizeIntakeExempt({ reason: input.reason });
    const ticket = dependencies.updateTicket(slug, intakeTicketReference(input.ref), { intakeExempt, by });
    if (!ticket) throw new Error("story_intake: ticket not found.");
    return ticket;
  }
  return { intakeDispatchRefusal, storyIntake };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createIntake,
  newStoryIntake,
  normalizeIntakeExempt,
  requiredIntakeText
});
