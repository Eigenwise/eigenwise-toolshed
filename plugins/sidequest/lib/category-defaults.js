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
  STARTER_ROUTING_PROFILES: () => STARTER_ROUTING_PROFILES
});
module.exports = __toCommonJS(category_defaults_exports);
const ROUTING_PROFILE_SEED_REVISION = 1;
const DEFAULT_CATEGORIES = [
  {
    id: "codebase-exploration",
    name: "Codebase exploration",
    description: "Locate and explain how an unfamiliar code path, feature, or convention works. The deliverable is a grounded map of existing code, not an implementation or a design recommendation.",
    route: { model: "codex-gpt-5-6-luna", effort: "medium" },
    fallback: null,
    contract: "Read before concluding; cite files and symbols. Do not edit project source. A ticket may explicitly name one bounded documentation artifact path under .claude/.codebase-info as its only write scope.",
    artifactRoots: [".claude/.codebase-info"],
    enabled: true
  },
  {
    id: "debugging",
    name: "Debugging",
    description: 'Explain and fix an observed defect with an unknown cause, including intermittent failures and unexpected runtime behavior. The first job is to reproduce and narrow the hypothesis space. Use testing instead when the intended behavior is already known and only verification is needed — the two share a verification step but start from opposite certainty about the cause. "Why is this slow" belongs here; "does approach X make it faster" is spike-investigation.',
    route: { model: "codex-gpt-5-6-terra", effort: "high" },
    fallback: { model: "sonnet", effort: "high" },
    contract: "Reproduce first; use a hypothesis loop and prove the fix.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "docs-writing",
    name: "Documentation writing",
    description: "Write or edit prose from supplied facts and a clear audience, without needing to investigate technical truth beyond the provided context. Use `research` when sources must be found or checked.",
    route: { model: "codex-gpt-5-6-luna", effort: "medium" },
    fallback: null,
    contract: "Preserve the requested voice and scope; do not invent facts.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "general",
    name: "General fallback",
    description: "Required and undeletable fallback. Use only when no more specific category fits or the request is too underspecified to classify safely. Reclassify after the first concrete evidence appears.",
    route: { model: "codex-gpt-5-6-luna", effort: "medium" },
    fallback: null,
    contract: "Clarify or inspect just enough to select a specific category; avoid broad work by default.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "coding.hard",
    name: "Hard coding",
    description: "A code change whose approach itself is genuinely unknown or contested and has hard-to-reverse consequences: competing designs, unclear root cause, or no obvious correct path. Blast radius, cross-consumer or cross-surface risk, and work that feels scary to get wrong do not make a ticket hard. If you can already state the fix approach, it is coding.normal no matter the stakes. Does not belong here: a high-risk migration with an established rollout is coding.normal. This tier is deliberately RARE and expensive; choose it only when the approach is unclear or contested and consequences are high. On the fence between coding.normal and coding.hard? It's coding.normal.",
    route: { model: "codex-gpt-5-6-sol", effort: "xhigh" },
    fallback: { model: "opus", effort: "xhigh" },
    contract: "Plan against the existing system, keep scope explicit, and verify end to end.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "research",
    name: "Research",
    description: "External research from web sources, at any depth: a bounded lookup with a few sources up to a substantial multi-source question needing fan-out searching and fact-checking. Scale depth to the question. Use spike-investigation when the unknown is answerable by building or running something in this repo or system.",
    route: { model: "codex-gpt-5-6-luna", effort: "medium" },
    fallback: { model: "sonnet", effort: "medium" },
    contract: "Prefer primary sources and cross-check material claims; deliver a concise cited synthesis. For a bounded lookup, invoke the saved `web-research` Workflow with the ticket question as `args`. For a substantial question, fan out searches across angles and adversarially verify key claims against independent sources. No repository edits.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "review-audit",
    name: "Review or audit",
    description: "Inspect an existing change, system, or artifact for correctness, regressions, or spec gaps. The deliverable is evidence-backed findings, not an unsolicited rewrite. Includes vulnerability-focused review: threat-model the change and hunt injection, authz, secrets exposure, and unsafe-input issues when the ticket calls for it.",
    route: { model: "codex-gpt-5-6-terra", effort: "high" },
    fallback: { model: "sonnet", effort: "high" },
    contract: "Report concrete findings with evidence, confidence, and impact; do not edit unless asked. For security-focused review, severity-rank findings and give each a concrete exploit scenario.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "spike-investigation",
    name: "Spike or investigation",
    description: `Reduce an important unknown by testing alternatives, feasibility, behavior, or constraints. The deliverable is a recommendation with evidence and explicit remaining uncertainty. The unknown must be answerable by building or running something in this repo or system ("does approach X actually work/perform here"); if it's answerable by reading external sources — docs, tool behavior, comparative research — use research instead. Also covers direction-setting design: a system boundary, migration, or cross-cutting technical direction where several valid approaches have material tradeoffs and the deliverable is a decision framework and recommendation rather than implementation.`,
    route: { model: "codex-gpt-5-6-sol", effort: "high" },
    fallback: { model: "opus", effort: "high" },
    contract: "Timebox exploration; record what was tested, ruled out, and recommended. For design-direction work: state constraints, compare viable options, recommend one, and name tradeoffs.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "coding.normal",
    name: "Standard coding",
    description: "A code change with a clear destination but real engineering judgment in getting there: choosing among a few conventional, already-used-in-this-repo patterns, coordinating edits across files that reference each other, or filling in reasonable defaults the request left unspecified. A clear approach still belongs here even when the change is high-stakes or touches many consumers; raise the verification bar, not the model tier. Belongs here: a new endpoint or component following the shape of existing ones; a fix requiring understanding how two or three parts interact; a refactor following an established pattern already used elsewhere in this codebase. Does not belong here: work where the repo doesn't show the right pattern and you'd have to invent one (coding.hard), or work with no real decision points (coding.easy). This is the DEFAULT tier for real coding work: when you're unsure whether a change is normal or hard, choose coding.normal.",
    route: { model: "codex-gpt-5-6-terra", effort: "high" },
    fallback: { model: "sonnet", effort: "high" },
    contract: "Establish the local pattern, implement to it, then run relevant checks.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "coding.easy",
    name: "Straightforward change",
    description: "A change where the correct edit is mechanically obvious once you've found the right spot: the pattern to follow already exists verbatim elsewhere in the repo, and there's no point where a reasonable engineer could pick two different valid approaches. Belongs here: adding a field that mirrors existing fields; fixing a value that's clearly wrong against a known-correct reference; wiring a new call to a utility the way it's already called elsewhere; a tightly bounded, reversible non-code change (config value, doc move, rename) with an explicit target and expected result. Does not belong here: anything where you must decide HOW to do it, even in one file (coding.normal or coding.hard), or an edit that first requires reading large files or broad repo context before a small change — route that coding.normal. File count alone never decides this tier.",
    route: { model: "codex-gpt-5-6-terra", effort: "medium" },
    fallback: { model: "sonnet", effort: "medium" },
    contract: "Make the smallest working change and verify the stated contract.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "testing",
    name: "Testing and verification",
    description: "Add, run, repair, or interpret a focused test or verification flow where the intended behavior is already known. Use `debugging` when the cause of a failing result is unknown.",
    route: { model: "codex-gpt-5-6-luna", effort: "high" },
    fallback: null,
    contract: "Exercise the named behavior and report the observed result faithfully.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "ui-frontend",
    name: "UI and frontend work",
    description: "Build or substantially reshape a user-facing interface where visual hierarchy, interaction design, and implementation must work together. Includes charts, graphs, dashboards, and any data visualization, in any medium (HTML, SVG, plotting libraries, notebooks). Use `coding.easy` for a purely mechanical UI tweak.",
    route: { model: "codex-gpt-5-6-terra", effort: "high" },
    fallback: { model: "sonnet", effort: "high" },
    contract: "Match the product's visual language and validate the rendered flow, not only source code. For charts and data visualizations, read the dataviz skill's references before writing chart code, follow its palette/form/accessibility rules, and verify the RENDERED output.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "visual-review",
    name: "Visual review",
    description: `Fresh-eyes review of a RENDERED interface — a dashboard, web UI, TUI, or report — judged visually through browser screenshots (Playwright) as a first-time user would see it: confusing representations, misleading labels or units, naming defects, dead panels, layout and flow problems. Belongs here: "review this dashboard's UX", "does this page make sense", screenshot-driven design critique. Does not belong here: reviewing code or diffs (review-audit), building or fixing UI (ui-frontend/coding), or anything whose evidence is source files rather than pixels.`,
    route: { model: "sonnet", effort: "high" },
    fallback: null,
    contract: "Strictly read-only and review-only: browse and screenshot the rendered surface, never edit files, never fix, never restart or write to live services. Deliverable is a prioritized findings comment on the ticket — worst problems first, each naming the exact panel/element and what a user would misunderstand.",
    artifactRoots: [],
    enabled: true
  }
];
const CREATIVE_MUSIC_CATEGORIES = [
  {
    id: "creative-direction",
    name: "Creative direction",
    description: "Shape a musical concept, mood, structure, or artistic direction before detailed composition or production work begins.",
    route: { model: "fable", effort: "high" },
    fallback: { model: "opus", effort: "high" },
    contract: "State genre, instrumentation, audience, and mood assumptions explicitly. Do not invent artist attribution or claim a style choice came from a source that was not provided.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "music-composition",
    name: "Music composition",
    description: "Write or develop lyrics, harmony, melody, arrangement, orchestration, or production direction for a concrete musical piece.",
    route: { model: "fable", effort: "high" },
    fallback: { model: "opus", effort: "high" },
    contract: "State genre, instrumentation, performer, and audience assumptions. Keep proposed musical choices internally consistent and never invent attribution.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "critique-revision",
    name: "Critique and revision",
    description: "Critique an existing musical draft and revise its lyrics, harmony, arrangement, production, or overall structure.",
    route: { model: "fable", effort: "medium" },
    fallback: { model: "opus", effort: "medium" },
    contract: "Name the supplied genre, instrumentation, audience, and intent assumptions, then tie each revision to a specific weakness in the draft.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "research",
    name: "Research",
    description: "Find sourced musical, historical, cultural, technical, or production context needed to support creative work.",
    route: { model: "sonnet", effort: "high" },
    fallback: null,
    contract: "Prefer primary sources, cite material claims, state uncertainty, and never invent attribution.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "general",
    name: "General fallback",
    description: "Handle creative-music work that does not yet fit a more specific direction, composition, revision, or research category.",
    route: { model: "fable", effort: "medium" },
    fallback: { model: "opus", effort: "medium" },
    contract: "Clarify genre, instrumentation, audience, and intended outcome before proceeding. Never invent attribution.",
    artifactRoots: [],
    enabled: true
  }
];
const RESEARCH_CATEGORIES = [
  {
    id: "quick-research",
    name: "Quick research",
    description: "Answer a bounded factual question with a small number of authoritative sources and a clearly limited search surface.",
    route: { model: "sonnet", effort: "medium" },
    fallback: null,
    contract: "Prefer primary sources, cite each material claim, and stop when the bounded question is answered.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "deep-research",
    name: "Deep research",
    description: "Investigate a substantial question through fan-out searching, independent verification, and reconciliation of conflicting evidence.",
    route: { model: "sonnet", effort: "high" },
    fallback: null,
    contract: "Fan out across distinct source angles, verify key claims independently, and state remaining uncertainty.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "analysis-synthesis",
    name: "Analysis and synthesis",
    description: "Turn an established source set into a recommendation, decision, or explanatory synthesis where evidence and uncertainty must stay visible.",
    route: { model: "fable", effort: "high" },
    fallback: { model: "opus", effort: "high" },
    contract: "Separate source evidence from inference, compare plausible readings, and qualify recommendations with uncertainty.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "general",
    name: "General fallback",
    description: "Handle research work whose depth or deliverable is not yet clear enough for a more specific category.",
    route: { model: "sonnet", effort: "medium" },
    fallback: null,
    contract: "Bound the question, identify the needed source quality, and report uncertainty explicitly.",
    artifactRoots: [],
    enabled: true
  }
];
const WRITING_CATEGORIES = [
  {
    id: "drafting",
    name: "Drafting",
    description: "Create original prose from supplied facts, goals, audience, and voice constraints.",
    route: { model: "fable", effort: "high" },
    fallback: { model: "opus", effort: "high" },
    contract: "Honor the requested audience and voice, distinguish assumptions from facts, and do not invent support.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "editing",
    name: "Editing",
    description: "Revise existing prose for clarity, structure, tone, concision, or consistency without changing its factual basis.",
    route: { model: "fable", effort: "medium" },
    fallback: { model: "opus", effort: "medium" },
    contract: "Preserve meaning and voice unless the brief explicitly asks to change them. Flag unsupported claims instead of rewriting them as fact.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "fact-checking",
    name: "Fact checking",
    description: "Verify factual claims in a draft against authoritative sources and identify unsupported, outdated, or misleading language.",
    route: { model: "sonnet", effort: "high" },
    fallback: null,
    contract: "Cite authoritative sources, separate false from unverified, and state confidence and uncertainty.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "docs-writing",
    name: "Documentation writing",
    description: "Write or revise technical documentation from an established implementation and known product behavior.",
    route: { model: "codex-gpt-5-6-luna", effort: "medium" },
    fallback: { model: "sonnet", effort: "medium" },
    contract: "Verify behavior against the supplied implementation, write for the named audience, and do not invent APIs or guarantees.",
    artifactRoots: [],
    enabled: true
  },
  {
    id: "general",
    name: "General fallback",
    description: "Handle writing work whose source material or requested operation is not yet clear enough for a more specific category.",
    route: { model: "fable", effort: "medium" },
    fallback: { model: "opus", effort: "medium" },
    contract: "Clarify audience, voice, source material, and factual constraints before drafting.",
    artifactRoots: [],
    enabled: true
  }
];
const STARTER_ROUTING_PROFILES = [
  {
    id: "coding",
    name: "Coding",
    description: "Software engineering, debugging, verification, technical research, and interface work.",
    categories: DEFAULT_CATEGORIES
  },
  {
    id: "creative-music",
    name: "Creative music",
    description: "Creative direction, composition, production, critique, and sourced musical context.",
    categories: CREATIVE_MUSIC_CATEGORIES
  },
  {
    id: "research",
    name: "Research",
    description: "Bounded lookup, deep source verification, and evidence-led synthesis.",
    categories: RESEARCH_CATEGORIES
  },
  {
    id: "writing",
    name: "Writing",
    description: "Original drafting, editing, fact checking, and technical documentation.",
    categories: WRITING_CATEGORIES
  }
];
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_CATEGORIES,
  ROUTING_PROFILE_SEED_REVISION,
  STARTER_ROUTING_PROFILES
});
