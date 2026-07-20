// Regenerate this list whenever global categories are edited.
export const DEFAULT_CATEGORIES = [
  {
    "id": "architecture-design",
    "name": "Architecture design",
    "description": "Design a system boundary, migration, or cross-cutting technical direction where several valid approaches have material tradeoffs. The request needs a decision framework, not implementation alone.",
    "route": {
      "model": "fable",
      "effort": "xhigh"
    },
    "fallback": {
      "model": "opus",
      "effort": "xhigh"
    },
    "contract": "State constraints, compare viable options, recommend one, and name tradeoffs.",
    "enabled": true
  },
  {
    "id": "codebase-exploration",
    "name": "Codebase exploration",
    "description": "Locate and explain how an unfamiliar code path, feature, or convention works. The deliverable is a grounded map of existing code, not an implementation or a design recommendation.",
    "route": {
      "model": "codex-gpt-5-6-luna",
      "effort": "medium"
    },
    "fallback": null,
    "contract": "Read before concluding; cite files and symbols. Do not edit project source. A ticket may explicitly name one bounded documentation artifact directory as its only write scope.",
    "enabled": true
  },
  {
    "id": "dataviz",
    "name": "Data visualization",
    "description": "Create or restyle a chart, graph, plot, dashboard, or any data visualization, in any medium (HTML, SVG, plotting libraries, notebooks).",
    "route": {
      "model": "codex-gpt-5-6-terra",
      "effort": "high"
    },
    "fallback": {
      "model": "sonnet",
      "effort": "high"
    },
    "contract": "Read the dataviz skill's references before writing chart code; follow its palette/form/accessibility rules; verify the RENDERED output, not just the code.",
    "enabled": true
  },
  {
    "id": "debugging",
    "name": "Debugging",
    "description": "Explain and fix an observed defect with an unknown cause, including intermittent failures and unexpected runtime behavior. The first job is to reproduce and narrow the hypothesis space. Use testing instead when the intended behavior is already known and only verification is needed — the two share a verification step but start from opposite certainty about the cause. \"Why is this slow\" belongs here; \"does approach X make it faster\" is spike-investigation.",
    "route": {
      "model": "codex-gpt-5-6-terra",
      "effort": "high"
    },
    "fallback": {
      "model": "sonnet",
      "effort": "high"
    },
    "contract": "Reproduce first; use a hypothesis loop and prove the fix.",
    "enabled": true
  },
  {
    "id": "deep-research",
    "name": "Deep research",
    "description": "A substantial multi-source research question needing fan-out searching and fact-checking, where a single search pass isn't enough. Use web-research for a bounded lookup with a few sources.",
    "route": {
      "model": "sonnet",
      "effort": "high"
    },
    "fallback": null,
    "contract": "Fan out searches across angles, adversarially verify key claims against independent sources, deliver a cited report. No repository edits.",
    "enabled": true
  },
  {
    "id": "docs-writing",
    "name": "Documentation writing",
    "description": "Write or edit prose from supplied facts and a clear audience, without needing to investigate technical truth beyond the provided context. Use `web-research` when sources must be found or checked.",
    "route": {
      "model": "codex-gpt-5-6-luna",
      "effort": "medium"
    },
    "fallback": null,
    "contract": "Preserve the requested voice and scope; do not invent facts.",
    "enabled": true
  },
  {
    "id": "general",
    "name": "General fallback",
    "description": "Required and undeletable fallback. Use only when no more specific category fits or the request is too underspecified to classify safely. Reclassify after the first concrete evidence appears.",
    "route": {
      "model": "codex-gpt-5-6-luna",
      "effort": "medium"
    },
    "fallback": null,
    "contract": "Clarify or inspect just enough to select a specific category; avoid broad work by default.",
    "enabled": true
  },
  {
    "id": "coding.hard",
    "name": "Hard coding",
    "description": "A code change with no single obviously-correct approach and real, hard-to-reverse consequences: a genuine architectural tradeoff, a blast radius spanning many systems, or work that must survive adversarial scrutiny (security, data integrity, a public API contract). Belongs here: a cross-cutting change with no established repo pattern to copy; a fix requiring an actual design tradeoff rather than a known recipe; a schema or data migration with real data-loss risk. Does not belong here: a change that merely touches many files but follows one clear pattern throughout — that stays coding.normal. Irreversibility and absence of a clear right answer are the signals, never file or line count.",
    "route": {
      "model": "codex-gpt-5-6-sol",
      "effort": "xhigh"
    },
    "fallback": {
      "model": "opus",
      "effort": "xhigh"
    },
    "contract": "Plan against the existing system, keep scope explicit, and verify end to end.",
    "enabled": true
  },
  {
    "id": "mechanical",
    "name": "Mechanical change",
    "description": "A tightly bounded, reversible change with an explicit target and expected result. No design choice, diagnosis, or repository-wide inference is needed.",
    "route": {
      "model": "codex-gpt-5-6-luna",
      "effort": "medium"
    },
    "fallback": null,
    "contract": "Change only the named surface; run the named check.",
    "enabled": true
  },
  {
    "id": "review-audit",
    "name": "Review or audit",
    "description": "Inspect an existing change, system, or artifact for correctness, regressions, or spec gaps. The deliverable is evidence-backed findings, not an unsolicited rewrite. Use security-audit for vulnerability-focused review.",
    "route": {
      "model": "codex-gpt-5-6-terra",
      "effort": "high"
    },
    "fallback": {
      "model": "sonnet",
      "effort": "high"
    },
    "contract": "Report concrete findings with evidence, confidence, and impact; do not edit unless asked.",
    "enabled": true
  },
  {
    "id": "security-audit",
    "name": "Security audit",
    "description": "Vulnerability-focused review: threat-model a change or system and hunt injection, authz, secrets exposure, and unsafe-input issues. Use review-audit for general correctness/quality review.",
    "route": {
      "model": "codex-gpt-5-6-sol",
      "effort": "high"
    },
    "fallback": {
      "model": "opus",
      "effort": "high"
    },
    "contract": "Severity-ranked findings with evidence and a concrete exploit scenario each; no fixes unless the ticket asks.",
    "enabled": true
  },
  {
    "id": "spike-investigation",
    "name": "Spike or investigation",
    "description": "Reduce an important unknown by testing alternatives, feasibility, behavior, or constraints. The deliverable is a recommendation with evidence and explicit remaining uncertainty. The unknown must be answerable by building or running something in this repo or system (\"does approach X actually work/perform here\"); if it's answerable by reading external sources — docs, tool behavior, comparative research — use web-research or deep-research instead.",
    "route": {
      "model": "codex-gpt-5-6-sol",
      "effort": "high"
    },
    "fallback": {
      "model": "opus",
      "effort": "high"
    },
    "contract": "Timebox exploration; record what was tested, ruled out, and recommended.",
    "enabled": true
  },
  {
    "id": "coding.normal",
    "name": "Standard coding",
    "description": "A code change with a clear destination but real engineering judgment in getting there: choosing among a few conventional, already-used-in-this-repo patterns, coordinating edits across files that reference each other, or filling in reasonable defaults the request left unspecified. Belongs here: a new endpoint or component following the shape of existing ones; a fix requiring understanding how two or three parts interact; a refactor following an established pattern already used elsewhere in this codebase. Does not belong here: work where the repo doesn't show the right pattern and you'd have to invent one (coding.hard), or work with no real decision points (coding.easy). Touching many files does not by itself promote a ticket out of this tier if one pattern applies throughout.",
    "route": {
      "model": "codex-gpt-5-6-sol",
      "effort": "medium"
    },
    "fallback": {
      "model": "opus",
      "effort": "medium"
    },
    "contract": "Establish the local pattern, implement to it, then run relevant checks.",
    "enabled": true
  },
  {
    "id": "coding.easy",
    "name": "Straightforward coding",
    "description": "A code change where the correct edit is mechanically obvious once you've found the right spot: the pattern to follow already exists verbatim elsewhere in the repo, and there's no point where a reasonable engineer could pick two different valid approaches. Belongs here: adding a field that mirrors existing fields; fixing a value that's clearly wrong against a known-correct reference; wiring a new call to a utility the way it's already called elsewhere. Does not belong here: anything where you must decide HOW to do it, even in one file (coding.normal or coding.hard), or an edit that first requires reading large files or broad repo context before a small change — route that coding.normal. File count alone never decides this tier.",
    "route": {
      "model": "codex-gpt-5-6-terra",
      "effort": "medium"
    },
    "fallback": {
      "model": "sonnet",
      "effort": "medium"
    },
    "contract": "Make the smallest working change and verify the stated contract.",
    "enabled": true
  },
  {
    "id": "testing",
    "name": "Testing and verification",
    "description": "Add, run, repair, or interpret a focused test or verification flow where the intended behavior is already known. Use `debugging` when the cause of a failing result is unknown.",
    "route": {
      "model": "codex-gpt-5-6-luna",
      "effort": "high"
    },
    "fallback": null,
    "contract": "Exercise the named behavior and report the observed result faithfully.",
    "enabled": true
  },
  {
    "id": "ui-frontend",
    "name": "UI and frontend work",
    "description": "Build or substantially reshape a user-facing interface where visual hierarchy, interaction design, and implementation must work together. Use `coding.easy` for a purely mechanical UI tweak.",
    "route": {
      "model": "codex-gpt-5-6-terra",
      "effort": "high"
    },
    "fallback": {
      "model": "sonnet",
      "effort": "high"
    },
    "contract": "Match the product’s visual language and validate the rendered flow, not only source code.",
    "enabled": true
  },
  {
    "id": "web-research",
    "name": "Web research",
    "description": "Answer a question whose result depends on current, external, or source-backed information. Gather primary sources where possible and distinguish evidence from inference. A single lookup or one authoritative source belongs here; use deep-research when sources must be cross-referenced, reconciled where they disagree, or synthesized into a recommendation.",
    "route": {
      "model": "sonnet",
      "effort": "high"
    },
    "fallback": null,
    "contract": "Return a sourced synthesis; do not edit repository files.",
    "enabled": true
  }
];
