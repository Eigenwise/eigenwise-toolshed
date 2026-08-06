import './_temp-cleanup.js';
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const skill = fs.readFileSync(path.join(ROOT, 'skills', 'sidequest', 'SKILL.md'), 'utf8');
const featureSkillPath = path.join(ROOT, 'skills', 'feature', 'SKILL.md');
const featureSkill = fs.readFileSync(featureSkillPath, 'utf8');
const orchestrationPath = path.join(ROOT, 'skills', 'sidequest', 'references', 'orchestration.md');
const orchestration = fs.readFileSync(orchestrationPath, 'utf8');
const store = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'store.ts'), 'utf8');
const warnings = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'store', 'warnings.ts'), 'utf8');
const agentsync = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'agentsync.ts'), 'utf8');
const publishing = fs.readFileSync(path.join(ROOT, 'skills', 'sidequest', 'references', 'publishing.md'), 'utf8');
const executorTemplate = fs.readFileSync(path.join(ROOT, 'scripts', '_exec-template.md'), 'utf8');

test('feature skill required orchestration reference resolves to the canonical guide', () => {
  const reference = featureSkill.match(/Read `([^`]+orchestration\.md)` before a first\s+wave/);
  assert.ok(reference, 'feature skill must name its required orchestration reference');

  const resolvedReference = path.resolve(path.dirname(featureSkillPath), reference[1]);
  assert.equal(resolvedReference, orchestrationPath);
  assert.ok(fs.existsSync(resolvedReference), `required reference does not exist: ${reference[1]}`);
});

test('comment guidance makes durable handoffs concise and consumable', () => {
  assert.match(executorTemplate, /Comments are handoffs, not a diary/);
  assert.match(executorTemplate, /Record decisions, constraints,\n\s+risks/);
  assert.match(executorTemplate, /short\n   relevant excerpt/);
  assert.match(skill, /BOOKEND SUPERVISION/);
  assert.match(skill, /read the submit report/);
  assert.match(skill, /merged-tree gate/);
  assert.match(publishing, /Read each submitted handoff/);
  assert.match(publishing, /Do not cherry-pick until the thread is understood/);
});

test('mid-task sub-delegation uses cheap scoped helpers', () => {
  assert.match(executorTemplate, /Mid-task sub-delegation/);
  assert.match(executorTemplate, /always pin an explicit cheap model/);
  assert.match(executorTemplate, /`web-researcher`, never a gateway model/);
  assert.match(executorTemplate, /First classify matching work through Sidequest categories and board routing/);
  assert.match(executorTemplate, /genuinely uncategorized bounded work/);
  assert.match(executorTemplate, /Audit and review work always needs its routed `review-audit` ticket executor/);
  assert.match(executorTemplate, /`general-purpose` only after that category check/);
  assert.match(executorTemplate, /run in the background from your current working tree/);
  assert.match(executorTemplate, /report a visibility block rather than clean findings/);
  assert.match(executorTemplate, /Helper writes are mechanically limited to the parent ticket's effective scope/);
  assert.match(executorTemplate, /route an outside path through the parent as a scope request or new ticket/);
  assert.match(executorTemplate, /Helpers are throwaway, not sub-tickets/);
  assert.match(executorTemplate, /work that grows scope goes back to the board as a filed ticket/);
});

test('executor reference lookup guidance avoids large skill loads', () => {
  assert.match(executorTemplate, /Reference-heavy skills are not how executors look something up/);
  assert.match(executorTemplate, /targeted `Read`/);
  assert.match(executorTemplate, /file and dispatch a research ticket/);
});

test('executor completion reports land on the board without a routine message', () => {
  assert.match(executorTemplate, /full final report: changed paths, verification evidence, commit hash/);
  assert.match(executorTemplate, /keep the terminal board comment to the commit\n   hash, verify evidence, and a reference to the submission instead of repeating its narrative/);
  assert.match(executorTemplate, /After a terminal board closeout, stop without a routine `SendMessage` to `main`/);
  assert.match(executorTemplate, /`kind=question` needs, a scope conflict, or a failure the board cannot/);
  assert.match(orchestration, /Read completion from the board/);
  assert.match(orchestration, /Do not expect or request a routine\n  `SendMessage` report/);
});

test('planning guidance requires stories for waves and keeps one-ticket work story-less', () => {
  assert.match(skill, /Wave mode REQUIRES a Sidequest story/);
  assert.match(skill, /file the complete backlog under it and pin\n\s+the execution contract on it/);
  assert.match(skill, /Sidequest's own `US-n` grouping, not a Claude Code feature/);
  assert.match(skill, /One-ticket mode stays story-less/);
});

test('wave guidance maximizes ready work and assesses isolated overlap', () => {
  assert.match(orchestration, /Decompose to maximize the ready set/);
  assert.match(orchestration, /A cut that forces a serial chain needs a stated reason/);
  assert.match(orchestration, /same-file overlap alone is not a conflict/);
  assert.match(orchestration, /same functions, constants, or regions; share a runtime resource; or semantically couple/);
  assert.match(skill, /Dispatch everything whose dependencies are met, always;\n\s+assess same-file overlap in isolated worktrees, never auto-serialize it/);
  assert.match(warnings, /parallel is fine in isolated worktrees unless the same symbols\/regions change; assess/);
});

test('dispatch guidance uses stable executors and fresh adoption dispatches', () => {
  assert.match(orchestration, /Stable executors are\nready from session start/);
  assert.match(orchestration, /Cross-session adoption is a fresh `dispatch <ref>`/);
  assert.doesNotMatch(orchestration, /ephemeral|registration wait|waiting for registration/);
});

test('retry guidance diagnoses once and bans blind respawns', () => {
  for (const source of [skill, orchestration, executorTemplate]) {
    assert.match(source, /diagnose-first retry/i);
    assert.match(source, /blind\s+respawn/i);
    assert.match(source, /two failures/i);
  }
  assert.match(orchestration, /pulse and read the denial\nverbatim/);
  assert.match(executorTemplate, /`token` refusal means the dispatch token is missing or expired/);
  assert.match(skill, /comment the evidence on the ticket and surface the failure to the user/);
});

test('dispatch guidance requires board confirmation after an Agent launch', () => {
  assert.match(orchestration, /Agent acknowledgement means only\n`launched`/);
  assert.match(orchestration, /Pulse the ticket immediately/);
  assert.match(orchestration, /denied or missing claim gets one diagnose-first retry/);
});

test('dormant executors resume once before replacement', () => {
  assert.match(orchestration, /SQ-715 findings comment/);
  assert.match(orchestration, /task-completed notification with no submission or terminal board state/);
  assert.match(orchestration, /if dispatch is still claimed and fresh, `SendMessage` the same named agent once/);
  assert.match(orchestration, /A second silent stop means dead: salvage, release, fresh-dispatch, then spawn one new executor/);
  assert.match(orchestration, /Never respawn beside a live claim or `TaskStop` without terminal board evidence/);
});

test('infrastructure-death recovery preserves partial output as an untrusted lead', () => {
  assert.match(orchestration, /Recover partial reasoning from an infrastructure death/);
  assert.match(orchestration, /release its claim first/);
  assert.match(orchestration, /one diagnose-first respawn/);
  assert.match(orchestration, /only as a lead to confirm or refute with its own evidence/);
  assert.match(orchestration, /Never pass partial reasoning as a conclusion to inherit/);
});

test('post-wave integration judges the oracle instead of re-reviewing executor work', () => {
  assert.match(orchestration, /Integrate and verify by wave/);
  assert.match(orchestration, /Each executor runs its scoped verification before submission/);
  assert.match(orchestration, /read each submit report, run each ticket's exact verify command, then run the\n  full suite once for the combined wave/);
  assert.match(orchestration, /The oracle is the review: never open source\n  or inspect diffs to re-review executor work/);
  assert.match(orchestration, /dispatch a\n  `review-audit` for the affected files/);
});


test('executor guidance keeps board lifecycle MCP-only and protects shared trees', () => {
  assert.match(executorTemplate, /mcp__plugin_sidequest_board__claim/);
  assert.match(executorTemplate, /mcp__plugin_sidequest_board__commit/);
  assert.match(executorTemplate, /mcp__plugin_sidequest_board__submit/);
  assert.match(executorTemplate, /Do not look for a command\nline fallback/);
  assert.match(executorTemplate, /git diff --cached --name-only/);
  assert.match(executorTemplate, /Foreign staged paths or unexplained in-scope changes mean report and release/);
  assert.match(executorTemplate, /Out-of-scope changes are normal: commit what is declared/);
  assert.match(executorTemplate, /report every refused or unscoped path in the final report, never call partial work ready for integration/);
  assert.match(executorTemplate, /never release verified work over scope friction/);
  assert.match(executorTemplate, /NEVER edit or commit `\.claude-plugin\/plugin\.json` or `\.claude-plugin\/marketplace\.json`/);
  assert.match(executorTemplate, /orchestrator assigns release versions centrally/);
  assert.match(executorTemplate, /same absolute `worktree`/);
  assert.doesNotMatch(executorTemplate, /sidequest submit <ref>/);
  assert.match(executorTemplate, /Read every section of that packet, the comment thread \(default read; elided old bodies are recoverable with `full:true` only when they matter/);
  assert.match(executorTemplate, /missing or unreadable attachments as blockers or warnings/);
  assert.doesNotMatch(executorTemplate, /comments digest/i);
  assert.doesNotMatch(orchestration, /It carries the full ticket contract/);
});

test('executor guidance distinguishes a wrong in-scope anchor from a blocking contradiction', () => {
  assert.match(agentsync, /An anchor is orientation, not a contract/);
  assert.match(agentsync, /If that file is inside declared scope, correct the anchor in your handback and continue/);
  assert.match(agentsync, /only when the needed file is outside declared scope or the ticket premise is false/);
});

test('owned background work stays non-terminal through Monitor timeouts', () => {
  assert.match(executorTemplate, /Owned background work stays non-terminal/);
  assert.match(executorTemplate, /do not end the turn or let the agent finish while that work is still running/);
  assert.match(executorTemplate, /A `Monitor` timeout is not completion: if the\nprocess is still alive, re-arm before ending the turn/);
  assert.match(executorTemplate, /a status sentence like "validation continues" is not\na substitute and never satisfies the wait/);
  assert.match(executorTemplate, /Keep re-arming until every required process reaches a terminal\nstate, success or failure alike/);
  assert.match(executorTemplate, /Never launch a\nbackground `sleep` as a fake wait/);
});

test('terminal board closeout tears down owned monitors', () => {
  assert.match(executorTemplate, /Terminal closeout ends background ownership/);
  assert.match(executorTemplate, /A successful `release`, `submit`, or `done` ends your\nclaim and your ownership/);
  assert.match(executorTemplate, /Before terminal closeout, call\n`TaskStop` for each owned task using its task id/);
  assert.match(executorTemplate, /If a task is required for closeout, keep the claim and\nre-arm it instead/);
  assert.match(executorTemplate, /Do not close a ticket and then wait, re-arm, or write if a Monitor wakes you later/);
  assert.match(executorTemplate, /stop any extra nonblocking validation and submit it/);
  assert.match(executorTemplate, /blocking external gate.*never a reason to release unpinned green work/);
});

test('inline-safe guidance names allowed work and exploit-resistant negatives', () => {
  for (const source of [skill, orchestration]) {
    assert.match(source, /INLINE-SAFE|Inline-safe/);
    assert.match(source, /strict-TS null guard/);
    assert.match(source, /assertion[- ]string/);
    assert.match(source, /golden regeneration/);
    assert.match(source, /merge-conflict resolution/);
    assert.match(source, /Release\s+bookkeeping|release\s+bookkeeping/);
    assert.match(source, /(?:user-directed|stated).*(?:one-or-two|1.?2).*named.file/i);
    assert.match(source, /before solo-fit or (?:ticket )?filing/i);
    assert.match(source, /one-line `\.gitignore` entry/i);
    assert.match(source, /(?:do not file a ticket or spawn an executor|don't ticket or spawn it)/i);
    assert.match(source, /investigation or other-file reading/i);
    assert.match(source, /(?:new|adds?) behavior.*API|new behavior or API/i);
    assert.match(source, /failing test\s+that does not pinpoint|unpinpointed failing test/i);
    assert.match(source, /context already loaded/i);
    assert.match(source, /small change/i);
    assert.match(source, /faster\s+myself/i);
  }
  assert.match(store, /INVALID_DIRECT_REASON_PATTERNS/);
  assert.doesNotMatch(skill, /user-granted `direct-ok` label/);
});

test('blocked ticket steps gate dependent delivery actions', () => {
  assert.match(skill, /Blocked-step invariant/);
  assert.match(skill, /when a review,\n\s*investigation, or verification awaits a ticket, every dependent action stays blocked until it closes/);
  assert.match(skill, /direct PRs, skill flows, manual apply, or any alternate route are the same violation as inline work/);
});

test('complete Sidequest doctrine stays shipped and current', () => {
  assert.match(skill, /Cut along affected surfaces/);
  assert.match(skill, /store, CLI, MCP surface, skill\/docs, and applicable full test directory/);
  assert.match(readme, /scope work by affected\nsurfaces/);
  assert.match(skill, /~\/.claude\/sidequest\/sidequest\.db/);
  assert.match(readme, /loaded MCP server or old session can still write the old store/);
  assert.match(skill, /Do not recreate a standalone Switchboard/);
  assert.match(readme, /Do not recreate a standalone\nSwitchboard/);
  assert.match(orchestration, /Salvage before redispatch/);
  assert.match(skill, /Executors bounce back, they don't grind/);
  assert.match(skill, /release \+ report fast/);
  assert.match(orchestration, /payload and context bloat/);
  assert.match(orchestration, /lingering workers/);
  assert.match(orchestration, /route anomalies/);
  assert.match(orchestration, /board hygiene/);
  assert.match(orchestration, /steerable background execution by default/i);
  assert.match(readme, /\*\*Routed repo lifecycle:\*\* dispatch → token claim → scoped commit → submit →\s+orchestrator publish/);
  assert.match(readme, /matching versions in both\n  `\.claude-plugin\/plugin\.json` and `\.claude-plugin\/marketplace\.json`/);
  assert.match(orchestration, /exact executor name, and the stamped effort/);
  assert.match(orchestration, /never add, rewrite, or combine markers/);
  for (const source of [readme, skill, orchestration]) {
    assert.doesNotMatch(source, new RegExp('native' + '_agent', 'i'));
    assert.doesNotMatch(source, new RegExp(['MCP `dispatch`', ' are disabled'].join(''), 'i'));
  }
});

export {};
