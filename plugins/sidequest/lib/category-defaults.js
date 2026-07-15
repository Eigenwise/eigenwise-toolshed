'use strict';

const DEFAULT_CATEGORIES = [
  ['mechanical', 'Mechanical change', 'A tightly bounded, reversible change with an explicit target and expected result. No design choice, diagnosis, or repository-wide inference is needed.', 'codex-gpt-5-6-luna', 'medium', 'haiku', 'Change only the named surface; run the named check.'],
  ['docs-writing', 'Documentation writing', 'Write or edit prose from supplied facts and a clear audience, without needing to investigate technical truth beyond the provided context. Use `web-research` when sources must be found or checked.', 'codex-gpt-5-6-luna', 'medium', 'haiku', 'Preserve the requested voice and scope; do not invent facts.'],
  ['codebase-exploration', 'Codebase exploration', 'Locate and explain how an unfamiliar code path, feature, or convention works. The deliverable is a grounded map of existing code, not an implementation or a design recommendation.', 'codex-gpt-5-6-luna', 'medium', 'sonnet', 'Read before concluding; cite files and symbols, with no edits.'],
  ['web-research', 'Web research', 'Answer a question whose result depends on current, external, or source-backed information. Gather primary sources where possible and distinguish evidence from inference.', 'codex-gpt-5-6-luna', 'high', 'sonnet', 'Return a sourced synthesis; do not edit repository files.'],
  ['testing', 'Testing and verification', 'Add, run, repair, or interpret a focused test or verification flow where the intended behavior is already known. Use `debugging` when the cause of a failing result is unknown.', 'codex-gpt-5-6-luna', 'high', 'sonnet', 'Exercise the named behavior and report the observed result faithfully.'],
  ['coding.easy', 'Straightforward coding', 'Implement a small, localized code change with a known approach and low interaction risk. The task does not require architectural decisions or multi-system reasoning.', 'codex-gpt-5-6-luna', 'high', 'sonnet', 'Make the smallest working change and verify the stated contract.'],
  ['coding.normal', 'Standard coding', 'Implement a bounded feature or fix that needs repository context, several coordinated edits, or normal engineering judgment, but has a conventional solution.', 'codex-gpt-5-6-terra', 'high', 'opus', 'Establish the local pattern, implement to it, then run relevant checks.'],
  ['coding.hard', 'Hard coding', 'Implement a complex, ambiguous, or cross-cutting change requiring substantial design judgment, deep reasoning, or autonomous multi-step execution.', 'codex-gpt-5-6-sol', 'xhigh', 'fable', 'Plan against the existing system, keep scope explicit, and verify end to end.'],
  ['debugging', 'Debugging', 'Explain and fix an observed defect with an unknown cause, including intermittent failures and unexpected runtime behavior. The first job is to reproduce and narrow the hypothesis space.', 'codex-gpt-5-6-terra', 'high', 'opus', 'Reproduce first; use a hypothesis loop and prove the fix.'],
  ['review-audit', 'Review or audit', 'Inspect an existing change, system, or artifact for correctness, regressions, security, or spec gaps. The deliverable is evidence-backed findings, not an unsolicited rewrite.', 'codex-gpt-5-6-terra', 'high', 'opus', 'Report concrete findings with evidence, confidence, and impact; do not edit unless asked.'],
  ['ui-frontend', 'UI and frontend work', 'Build or substantially reshape a user-facing interface where visual hierarchy, interaction design, and implementation must work together. Use `coding.easy` for a purely mechanical UI tweak.', 'codex-gpt-5-6-terra', 'high', 'opus', 'Match the product’s visual language and validate the rendered flow, not only source code.'],
  ['spike-investigation', 'Spike or investigation', 'Reduce an important unknown by testing alternatives, feasibility, behavior, or constraints. The deliverable is a recommendation with evidence and explicit remaining uncertainty.', 'codex-gpt-5-6-terra', 'high', 'opus', 'Timebox exploration; record what was tested, ruled out, and recommended.'],
  ['architecture-design', 'Architecture design', 'Design a system boundary, migration, or cross-cutting technical direction where several valid approaches have material tradeoffs. The request needs a decision framework, not implementation alone.', 'codex-gpt-5-6-sol', 'xhigh', 'fable', 'State constraints, compare viable options, recommend one, and name tradeoffs.'],
  ['general', 'General fallback', 'Required and undeletable fallback. Use only when no more specific category fits or the request is too underspecified to classify safely. Reclassify after the first concrete evidence appears.', 'codex-gpt-5-6-luna', 'medium', 'sonnet', 'Clarify or inspect just enough to select a specific category; avoid broad work by default.'],
].map(([id, name, description, model, effort, fallbackModel, contract]) => ({
  id,
  name,
  description,
  route: { model, effort },
  fallback: { model: fallbackModel, effort },
  contract,
  enabled: true,
}));

module.exports = { DEFAULT_CATEGORIES };
