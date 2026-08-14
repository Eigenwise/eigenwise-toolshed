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
var category_defaults_exports = {};
__export(category_defaults_exports, {
  DEFAULT_CATEGORIES: () => DEFAULT_CATEGORIES,
  ROUTING_PROFILE_SEED_REVISION: () => ROUTING_PROFILE_SEED_REVISION,
  STARTER_ROUTING_PROFILES: () => STARTER_ROUTING_PROFILES,
  starterRoutingProfilesFor: () => starterRoutingProfilesFor
});
module.exports = __toCommonJS(category_defaults_exports);
const ROUTING_PROFILE_SEED_REVISION = 7;
const DEFAULT_CATEGORIES = [
  {
    id: "codebase-exploration",
    name: "Codebase exploration",
    description: "Trace and explain how an unfamiliar code path, feature, or convention works. Existing code bounds the answer and no design choice is required, so high code reasoning is appropriate. The deliverable is a grounded map of existing code, not an implementation or design recommendation.",
    route: { model: "sonnet", effort: "high" },
    fallback: null,
    contract: "Read before concluding; cite files and symbols. Do not edit project source. A ticket may explicitly name one bounded documentation artifact path under .claude/.codebase-info as its only write scope.",
    artifactRoots: [".claude/.codebase-info"],
    readonly: true,
    enabled: true
  },
  {
    id: "debugging",
    name: "Debugging",
    description: 'Explain and fix an observed defect with an unknown cause, including intermittent failures and unexpected runtime behavior. Selecting and eliminating competing hypotheses requires high-capability reasoning. Use behavior-verification when the intended behavior is already known and only verification is needed. "Why is this slow" belongs here; "does approach X make it faster" is spike-investigation.',
    route: { model: "opus", effort: "high" },
    fallback: null,
    contract: "Reproduce first; use a hypothesis loop and prove the fix.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "experiment",
    name: "Experiment",
    description: "Use ONLY when the verdict is a human's judgement and no offline metric has been shown to reproduce it. Comparing candidates against an irreducibly subjective oracle requires high-capability judgement. If a test can decide, it is coding or debugging.",
    route: { model: "opus", effort: "high" },
    fallback: null,
    contract: "Read the experiment log fully before the first edit. Run one hypothesis per round. Always commit the candidate to sidequest/experiment/<ref> and pin refs/sidequest/<ref>/r<N>, even when it loses. Write the oracle ask as a blind ranked comparison. Never paraphrase the user's verdict. Hand off with release and the oracle ask.",
    artifactRoots: [],
    readonly: false,
    enabled: true
  },
  {
    id: "implementation-explanation",
    name: "Implementation-grounded explanation",
    description: "Explain established technical behavior for a named audience when the implementation already supplies the factual boundary. Known code bounds both facts and structure, so high code-and-language capability is appropriate.",
    route: { model: "sonnet", effort: "high" },
    fallback: { model: "sonnet", effort: "medium" },
    contract: "Verify every behavioral claim against the supplied implementation, preserve the requested voice and scope, and do not invent APIs or guarantees.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "general",
    name: "General fallback",
    description: "Required and undeletable fallback. Use only when no more specific capability fits or the request is too underspecified to classify safely. This route performs bounded triage, so high reasoning is appropriate. Reclassify after the first concrete evidence appears.",
    route: { model: "sonnet", effort: "high" },
    fallback: null,
    contract: "Clarify or inspect just enough to select a specific category; avoid broad work by default.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "coding.hard",
    name: "Hard coding",
    description: "A code change whose approach itself is genuinely unknown or contested and has hard-to-reverse consequences: competing designs, unclear root cause, or no obvious correct path. Blast radius, cross-consumer or cross-surface risk, and work that feels scary to get wrong do not make a ticket hard. If you can already state the fix approach, it is coding.normal no matter the stakes. Does not belong here: a high-risk migration with an established rollout is coding.normal. This tier is deliberately RARE and expensive; choose it only when the approach is unclear or contested and consequences are high. On the fence between coding.normal and coding.hard? It's coding.normal.",
    route: { model: "opus", effort: "xhigh" },
    fallback: null,
    contract: "Plan against the existing system, keep scope explicit, and verify end to end.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "source-lookup",
    name: "Source lookup",
    description: "Resolve a bounded external documentation or factual question with a small authoritative source set. The narrow search surface and concrete answer make medium research capability sufficient. Use evidence-research when claims must be reconciled across sources.",
    route: { model: "sonnet", effort: "medium" },
    fallback: null,
    contract: "Prefer primary sources, cite each material claim, stop when the bounded question is answered, and make no project edits.",
    artifactRoots: [],
    readonly: true,
    enabled: true
  },
  {
    id: "evidence-research",
    name: "Evidence research",
    description: "Investigate a substantial external question through fan-out searching, independent verification, or reconciliation of conflicting sources. The breadth and conflict resolution require high research capability. Use spike-investigation when the unknown is answerable by building or running something in this repo or system.",
    route: { model: "sonnet", effort: "high" },
    fallback: null,
    contract: "Fan out across distinct source angles, prefer primary sources, verify key claims independently, state remaining uncertainty, and make no repository edits.",
    artifactRoots: [],
    readonly: true,
    enabled: true
  },
  {
    id: "review-audit",
    name: "Review or audit",
    description: "Inspect an existing change, system, or artifact for correctness, regressions, or spec gaps. Adversarially checking interactions and tracing concrete impact requires high code-review capability. The deliverable is evidence-backed findings, not an unsolicited rewrite. Includes vulnerability-focused review when the ticket calls for it.",
    route: { model: "sonnet", effort: "high" },
    fallback: { model: "sonnet", effort: "high" },
    contract: "Report concrete findings with evidence, confidence, and impact; do not edit unless asked. For security-focused review, severity-rank findings and give each a concrete exploit scenario.",
    artifactRoots: [],
    readonly: true,
    enabled: true
  },
  {
    id: "spike-investigation",
    name: "Spike or investigation",
    description: "Reduce an important unknown by testing alternatives, feasibility, behavior, or constraints. Comparing viable approaches under material uncertainty requires high technical reasoning. The deliverable is a recommendation with evidence and explicit remaining uncertainty. The unknown must be answerable by building or running something in this repo or system; use source-lookup or evidence-research for external-source questions.",
    route: { model: "opus", effort: "high" },
    fallback: null,
    contract: "Timebox exploration; record what was tested, ruled out, and recommended. For design-direction work: state constraints, compare viable options, recommend one, and name tradeoffs.",
    artifactRoots: [],
    readonly: true,
    enabled: true
  },
  {
    id: "coding.normal",
    name: "Standard coding",
    description: "A code change with a clear destination but real engineering judgment in getting there: choosing among a few conventional, already-used-in-this-repo patterns, coordinating edits across files that reference each other, or filling in reasonable defaults the request left unspecified. A clear approach still belongs here even when the change is high-stakes or touches many consumers; raise the verification bar, not the model tier. Belongs here: a new endpoint or component following the shape of existing ones; a fix requiring understanding how two or three parts interact; a refactor following an established pattern already used elsewhere in this codebase. Does not belong here: work where the repo doesn't show the right pattern and you'd have to invent one (coding.hard), or work with no real decision points (coding.easy). This is the DEFAULT tier for real coding work: when you're unsure whether a change is normal or hard, choose coding.normal.",
    route: { model: "sonnet", effort: "high" },
    fallback: { model: "sonnet", effort: "high" },
    contract: "Establish the local pattern, implement to it, then run relevant checks.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "coding.easy",
    name: "Straightforward change",
    description: "A change where the correct edit is mechanically obvious once you've found the right spot: the pattern to follow already exists verbatim elsewhere in the repo, and there's no point where a reasonable engineer could pick two different valid approaches. Belongs here: adding a field that mirrors existing fields; fixing a value that's clearly wrong against a known-correct reference; wiring a new call to a utility the way it's already called elsewhere; a tightly bounded, reversible non-code change (config value, doc move, rename) with an explicit target and expected result. Does not belong here: anything where you must decide HOW to do it, even in one file (coding.normal or coding.hard), or an edit that first requires reading large files or broad repo context before a small change — route that coding.normal. File count alone never decides this tier.",
    route: { model: "sonnet", effort: "medium" },
    fallback: { model: "sonnet", effort: "medium" },
    contract: "Make the smallest working change and verify the stated contract.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "behavior-verification",
    name: "Behavior verification",
    description: "Add, run, repair, or interpret a focused verification flow where the intended behavior and deciding signal are already known. Those fixed constraints still benefit from high execution-and-test reasoning. Use debugging when the cause of a failing result is unknown.",
    route: { model: "sonnet", effort: "high" },
    fallback: null,
    contract: "Exercise the named behavior with the narrowest reliable check and report the observed result faithfully.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "interaction-design-implementation",
    name: "Interaction design and implementation",
    description: "Build or substantially reshape a user-facing interface where visual hierarchy, interaction design, and implementation must work together. Coordinating those concerns and judging rendered results requires high frontend capability. Includes charts, dashboards, and other data visualization. Use coding.easy for a purely mechanical UI tweak.",
    route: { model: "sonnet", effort: "high" },
    fallback: { model: "sonnet", effort: "high" },
    contract: "Match the product's visual language and validate the rendered flow, not only source code. For charts and data visualizations, read the dataviz skill's references before writing chart code, follow its palette, form, and accessibility rules, and verify the rendered output.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "visual-evaluation",
    name: "Visual evaluation",
    description: "Judge a rendered interface through browser screenshots as a first-time user would see it, finding confusing representations, misleading labels, dead panels, and layout or flow problems. Visual judgement needs a multimodal model, while the bounded review-only deliverable keeps effort at medium. Source-code evidence belongs in review-audit.",
    route: { model: "opus", effort: "medium" },
    fallback: null,
    contract: "Strictly read-only and review-only: browse and screenshot the rendered surface, never edit files, never fix, never restart or write to live services. Deliver a prioritized findings comment on the ticket, worst problems first, with each finding naming the exact element and what a user would misunderstand.",
    artifactRoots: [],
    readonly: true,
    enabled: true
  }
];
const CREATIVE_MUSIC_CATEGORIES = [
  {
    id: "concept-framing",
    name: "Concept framing",
    description: "Resolve an open musical brief into a coherent mood, structure, palette, and artistic direction before detailed writing begins. The open-ended aesthetic choices require high creative capability.",
    route: { model: "fable", effort: "high" },
    fallback: { model: "opus", effort: "high" },
    contract: "State genre, instrumentation, audience, mood, and reference assumptions explicitly. Present a coherent direction without composing details the brief has not reached, and never invent attribution.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "musical-generation",
    name: "Musical generation",
    description: "Generate or develop lyrics, harmony, melody, arrangement, orchestration, or production choices for a concrete piece. Maintaining long-range musical and lyrical coherence requires high creative capability.",
    route: { model: "fable", effort: "high" },
    fallback: { model: "opus", effort: "high" },
    contract: "State genre, instrumentation, performer, audience, and structural assumptions. Keep musical choices internally consistent and never invent attribution.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "evaluative-revision",
    name: "Evaluative revision",
    description: "Diagnose weaknesses in an existing musical draft and make targeted lyrical, harmonic, structural, arrangement, or production revisions. The supplied draft narrows the solution space, so medium creative capability is sufficient.",
    route: { model: "fable", effort: "medium" },
    fallback: { model: "opus", effort: "medium" },
    contract: "Name the supplied genre, instrumentation, audience, and intent assumptions, then tie each revision to a specific weakness in the draft.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "context-research",
    name: "Context research",
    description: "Establish musical, historical, cultural, technical, or production context from authoritative sources. Evaluating domain-specific claims across sources requires high research capability. Creative generation belongs in concept-framing or musical-generation.",
    route: { model: "sonnet", effort: "high" },
    fallback: null,
    contract: "Prefer primary sources, cite material claims, state uncertainty, never invent attribution, and make no project edits.",
    artifactRoots: [],
    readonly: true,
    enabled: true
  },
  {
    id: "general",
    name: "General fallback",
    description: "Handle creative-music work whose needed capability is not yet clear. Musical fluency is still needed to classify the brief. Medium effort is enough because the first step is clarification.",
    route: { model: "fable", effort: "medium" },
    fallback: { model: "opus", effort: "medium" },
    contract: "Clarify genre, instrumentation, audience, source material, and intended outcome before proceeding. Never invent attribution.",
    artifactRoots: [],
    enabled: true
  }
];
const RESEARCH_CATEGORIES = [
  {
    id: "source-lookup",
    name: "Source lookup",
    description: "Answer a bounded factual question from a small authoritative source set. The narrow search surface and concrete stopping point make medium research capability sufficient.",
    route: { model: "sonnet", effort: "medium" },
    fallback: null,
    contract: "Prefer primary sources, cite each material claim, stop when the bounded question is answered, and make no project edits.",
    artifactRoots: [],
    readonly: true,
    enabled: true
  },
  {
    id: "evidence-investigation",
    name: "Evidence investigation",
    description: "Investigate a substantial question through source fan-out, independent verification, and reconciliation of conflicting evidence. The breadth and conflict resolution require high research capability.",
    route: { model: "sonnet", effort: "high" },
    fallback: null,
    contract: "Fan out across distinct source angles, verify key claims independently, state remaining uncertainty, and make no project edits.",
    artifactRoots: [],
    readonly: true,
    enabled: true
  },
  {
    id: "evidence-synthesis",
    name: "Evidence synthesis",
    description: "Turn an established source set into a recommendation, decision, or explanatory model while keeping evidence, inference, and uncertainty separate. Weighing plausible readings and downstream implications requires high open-ended synthesis capability.",
    route: { model: "fable", effort: "high" },
    fallback: { model: "opus", effort: "high" },
    contract: "Separate source evidence from inference, compare plausible readings, qualify recommendations with uncertainty, and make no project edits.",
    artifactRoots: [],
    readonly: true,
    enabled: true
  },
  {
    id: "general",
    name: "General fallback",
    description: "Handle research work whose question, source standard, or deliverable is not yet clear enough to classify. This route only bounds the inquiry, so medium research capability is sufficient.",
    route: { model: "sonnet", effort: "medium" },
    fallback: null,
    contract: "Bound the question, identify the needed source quality and output, report uncertainty explicitly, and make no project edits.",
    artifactRoots: [],
    readonly: true,
    enabled: true
  }
];
const WRITING_CATEGORIES = [
  {
    id: "prose-generation",
    name: "Prose generation",
    description: "Create original prose by reconciling supplied facts, goals, audience, structure, and voice constraints. Sustaining those open-ended language choices across a new draft requires high creative-writing capability.",
    route: { model: "fable", effort: "high" },
    fallback: { model: "opus", effort: "high" },
    contract: "Honor the requested audience and voice, distinguish assumptions from facts, and do not invent support.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "meaning-preserving-revision",
    name: "Meaning-preserving revision",
    description: "Improve existing prose for clarity, structure, tone, concision, or consistency without changing its factual basis. The source draft constrains both meaning and scope, so medium creative-writing capability is sufficient.",
    route: { model: "fable", effort: "medium" },
    fallback: { model: "opus", effort: "medium" },
    contract: "Preserve meaning and voice unless the brief explicitly asks to change them. Flag unsupported claims instead of rewriting them as fact.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "source-verification",
    name: "Source verification",
    description: "Verify supplied factual claims against authoritative sources and identify false, unsupported, outdated, or misleading language. Comparing claims with source context and uncertainty requires high research capability.",
    route: { model: "sonnet", effort: "high" },
    fallback: null,
    contract: "Cite authoritative sources, separate false from unverified, state confidence and uncertainty, and do not revise the draft or project files.",
    artifactRoots: [],
    readonly: true,
    enabled: true
  },
  {
    id: "general",
    name: "General fallback",
    description: "Handle writing work whose source material, audience, or requested operation is not yet clear enough to classify. Clarifying those constraints needs broad language understanding, while medium effort is sufficient because drafting waits until classification.",
    route: { model: "sonnet", effort: "medium" },
    fallback: null,
    contract: "Clarify audience, voice, source material, factual constraints, and intended operation before writing.",
    artifactRoots: [],
    enabled: true
  }
];
const STARTER_ROUTING_PROFILES = [
  {
    id: "coding",
    name: "Coding",
    description: "Software work separated by the capability needed to explore, decide, implement, verify, review, research, explain, or judge a rendered result.",
    categories: DEFAULT_CATEGORIES
  },
  {
    id: "creative-music",
    name: "Creative music",
    description: "Musical work separated by concept framing, generation, evaluative revision, and sourced context research.",
    categories: CREATIVE_MUSIC_CATEGORIES
  },
  {
    id: "research",
    name: "Research",
    description: "Research separated by bounded retrieval, multi-source investigation, and evidence synthesis.",
    categories: RESEARCH_CATEGORIES
  },
  {
    id: "writing",
    name: "Writing",
    description: "Writing separated by open-ended generation, constrained revision, and source verification.",
    categories: WRITING_CATEGORIES
  }
];
const GATEWAY_ROUTE_BY_PROFILE_CATEGORY = {
  coding: {
    "codebase-exploration": { model: "codex-gpt-5-6-luna", effort: "high" },
    "implementation-explanation": { model: "codex-gpt-5-6-luna", effort: "high" },
    general: { model: "codex-gpt-5-6-luna", effort: "high" },
    "review-audit": { model: "codex-gpt-5-6-terra", effort: "high" },
    "coding.normal": { model: "codex-gpt-5-6-terra", effort: "high" },
    "coding.easy": { model: "codex-gpt-5-6-terra", effort: "medium" },
    "behavior-verification": { model: "codex-gpt-5-6-luna", effort: "high" },
    "interaction-design-implementation": { model: "codex-gpt-5-6-terra", effort: "high" }
  }
};
function starterRoutingProfilesFor(models) {
  const availableGatewayModels = new Set(models.filter((model) => model.provider === "codex").map((model) => model.slug));
  return STARTER_ROUTING_PROFILES.map((profile) => ({
    ...profile,
    categories: profile.categories.map((category) => {
      const gatewayRoute = GATEWAY_ROUTE_BY_PROFILE_CATEGORY[profile.id]?.[category.id];
      return gatewayRoute && availableGatewayModels.has(gatewayRoute.model) ? { ...category, route: gatewayRoute } : { ...category };
    })
  }));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_CATEGORIES,
  ROUTING_PROFILE_SEED_REVISION,
  STARTER_ROUTING_PROFILES,
  starterRoutingProfilesFor
});
