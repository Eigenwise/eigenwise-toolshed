---
name: sidequest
description: >-
  Open or manage Sidequest tickets and board workflow. Use to show the dashboard, file, update, close,
  prioritize, link, or claim tickets, or plan substantial work.
---

# sidequest

A Trello-light quest log: tickets in a central store under `~/.claude/sidequest`, a live
Kanban dashboard, one CLI (`bin/sidequest.js`), matching MCP tools. Detail lives in reference files
— **read them only when the situation calls for it**:

- `references/orchestration.md` — decomposition depth, fan-out waves, checkpoints, background
  execution, cost levers, agent teams.
- `references/experiment-loop.md` — oracle rounds, branches, verdicts, promotion.
- `references/publishing.md` — delivery modes, publish transaction.
- `references/routing-details.md`, `references/routing-guide.md` — routes and wiring.
- `references/high-stakes.md`
- `references/external-trackers.md`, `references/board-features.md`, `references/category-links.md`, `references/ticket-authoring.md`.

## Plan substantial work on the board first

For substantial work:

0. **solo-fit gate.** **SOLO-FIT picks one-executor vs wave; it NEVER means you implement
   inline.** Small coherent work gets **one ticket** and one executor; use it too when the contract
   cannot be pinned without doing the work. With a written spec and executable done-oracle,
   contract-first wave is the default. Claiming the contract is unpinnable needs either a completed
   exploration/planning ticket that tried and names the interface that resisted a written contract, or no written
   contract surface in the request. “Feels coupled” is not evidence: when unsure, file planning first.
1. **Ticket shape.** If a written spec pins shared types/interfaces, file boundaries, and
   per-piece verification, 3+ independently checkable pieces use contract-first fan-out: pin the
   contract in ticket descriptions or a short planning ticket, then one parallel wave on
   category-appropriate cheaper models and integrate once per wave. **Wave mode REQUIRES a Sidequest story** first
   (`sidequest story add`, then `--story US-n` per piece): file the complete backlog under it and pin
   the execution contract on it. A story is Sidequest's own `US-n` grouping, not a Claude Code feature.
   One-ticket mode stays story-less; use stories for shared outcomes or dependencies. Cut along affected surfaces: store, CLI, MCP surface, skill/docs, and applicable full test directory.
   Tickets carry anchors, contract, and a scoped verify. Use directory scope for the blast radius; details:
   `references/ticket-authoring.md`.
2. **Link dependencies** (`link SQ-4 depends-on SQ-3`); shape a story as design → wave(s) →
   integrate so `ready` serializes the phases.
3. **File the whole planned wave backlog before dispatching.** After solo-fit chooses wave mode, put every
   planned ticket for every wave on the board, with declared files, dependency links, and per-ticket verify;
   then dispatch the entire ready wave in parallel. Dispatch everything whose dependencies are met, always;
   assess same-file overlap in isolated worktrees, never auto-serialize it. Drip-filing, dispatching, waiting, then filing the next
   ticket serializes work and hides the plan until the user cannot steer it. Later discoveries still become
   normal mid-run tickets.
4. **Execute proportionally** — "Route execution down" below.

Complexity 4+ needs planning: scope, anchors, a scoped verify. Executors test the changed
surface; the full suite runs once on the merged tree at integration. A passing executable
done-oracle needs no review-audit + fix wave unless it lacks determinism or is high-stakes. **Blocked-step invariant:** when a review,
investigation, or verification awaits a ticket, every dependent action stays blocked until it closes;
direct PRs, skill flows, manual apply, or any alternate route are the same violation as inline work.
The board keeps plans. Before solo-fit or filing, do a stated one-line `.gitignore` entry or other mechanical edit to 1–2 named files inline; don't ticket or spawn it. Investigation or other-file reading needs a ticket.

### INLINE-SAFE direct work

If inline-safe work was already ticketed, the orchestrator may claim `--direct` and edit inline after annotating the ticket, giving a 20+ character reason, and matching this allowlist:

- A failing integration gate pinpoints an exact, known small diff: a strict-TS null guard, an
  assertion string synced after a deliberate reword, byte-checked golden regeneration, or a
  merge-conflict resolution that preserves both sides' intent.
- Release bookkeeping: release fragments, the cut flow, or closing tickets with evidence.
- The existing user-directed one-or-two-named-file carve-out above, unchanged.

`direct-ok` may remain as a user signal, but it gates nothing. Never inline work that needs
investigation or other-file reading to be confident, adds behavior or an API, or has a failing test
that does not pinpoint the exact location. "Context already loaded", "small change", and "faster
myself" are invalid reasons. File a ticket and dispatch its executor instead. The blocked-step and
never-inline invariants still apply to substantive work.
Coexisting with an external tracker: `references/external-trackers.md`.

## MCP is the executor board interface

Routed executors use **only** the `mcp__plugin_sidequest_board__*` tools for their lifecycle
(`commit`/`submit` take the executor's absolute worktree path). Missing tools → report the
blocker and release through an available board tool, never a command-line fallback.

MCP is the normal interface for board admin/config; the CLI is fallback for git-context operations.
Apply board-only admin changes directly through an available MCP tool, never as a ticket or dispatch. Live
category/profile edits affect only that board, not installation defaults unless the user asks. After a
schema-bumping release, reload plugins before MCP writes. Commands default to the current project;
`--project "<path-or-slug>"` (MCP: `project`) targets another board.

`dispatch <ref>` is **instant**: it returns the ticket's stable executor, a short `spawn` fetch
stub, and a token. Pass every supplied `spawn` field (`name` and `description` too) to Agent
unchanged. Set `Agent.description` to `spawn.description` byte-for-byte, never deriving it from
`spawn.prompt`, its route marker, the ticket title, model, or effort. The executor fetches its
token-gated durable packet as the first action: full description, category route and contract, scope,
state, comment metadata, and absolute attachment paths. It must inspect every readable
attachment and report missing or unreadable ones, while the spawn keeps that content out of this
transcript. Never trust a worker's self-report — the
claim's token and exact executor name are the evidence.

**Workflow callers:** call `route_recipe` or `sidequest route <category> --json`; wire only `recipe.agent.model` and `recipe.agent.promptPrefix + prompt` in Agent. Do not manually translate route, gateway, virtual-model, marker, or effort fields. A user-named model for one ticket means set that ticket's `route` override, never edit the category route, which repoints later tickets too. See `references/routing-guide.md`.

**Locations:** CLI: `plugins/sidequest/bin/sidequest.js`; DB: `~/.claude/sidequest/sidequest.db`
(`SIDEQUEST_HOME`); attachments: `~/.claude/sidequest/projects/<slug>/assets/`. Never scan from root.

## Routing profiles

A board selects one profile plus local ADD/OVERRIDE/DETACH/DISABLE rows. Mutations take one of
`--profile`/`--project`; details: `references/routing-details.md`. Category `readonly` selects the
restricted executor and `done` closeout. `--readonly true|false` overrides it for a prepared dispatch.
Read-only files or changes warn before dispatch. Resolve or override.

## Open the dashboard

`sidequest dashboard` starts the local server and prints the URL. Verify server changes in an isolated
`SIDEQUEST_HOME` on a distinct port, never the shared board.

## File a ticket

`sidequest add -t "Contact form does not send" -d "..." -p high -l bug --category <id>` — read the
live taxonomy (`category_list` MCP / `sidequest category list --json`), choose by description, and
stamp `--category`; use its fallback only when no category fits. `--complexity` is legacy ambiguity
fallback; never set `--model`/`--effort`. Use `--file`, `--story`, `--anchors`, and exact `--verify` as
needed; scope and authoring details: `references/ticket-authoring.md`.

**Descriptions are developer-to-developer specs, never PM summaries.** Include anchors, behavior and
edge cases, bounds, dependencies/decisions, and a runnable `cd <repo-relative-dir> && ...` verify command. Bugs include
a reproduction. Front-load evidence for cheaper executors. Route by remaining
uncertainty, not original difficulty: a settled one-or-two-file edit is `coding.easy`; use direct
only for the INLINE-SAFE allowlist below, with its recorded reason.

Descriptions/comments render markdown. Use real newlines, never literal `\n`. Mid-task side issue? File
it with `mcp__plugin_sidequest_board__add`, then keep going. Filing a ticket is not a request to work it.

## List / update / close

`sidequest list` (this project; `--status todo` for one column) · `projects` (every board) ·
`update SQ-3 --status done` (move; also `-p -t -d -l`) · `rm SQ-3` (delete). `--json` reads data;
`--brief` on `list`/`ready` implies `--json` and drops bodies. **Default to
`--brief` for routine orchestration reads.** "Close / ship it" → `--status done`.

## Work a ticket (safe with other agents)

The board may be shared: a ticket must be **claimed** before you touch it, and claiming is
**atomic**. **Never work a ticket you haven't successfully claimed**, even one you just filed.
Lifecycle (executors use the matching MCP tools; CLI forms for inline/admin work):
`next`/`claim SQ-3 --by <you> --direct --reason "why this is inline-safe"` (only for the
INLINE-SAFE allowlist) → `commit` (declared ticket paths only) → `submit --commit <hash> --verify
"<cmd>"` (parks the verified LOCAL commit)
or `done --model <model> --effort <level>` (inline/non-repo only) or `release` (drop unfinished,
optionally `--status todo`).

- **`--by` must be genuinely unique to this session** — a random token generated once (e.g.
  `claude-<8 hex>`); a generic label lets two sessions silently coexist as one worker.
- **If a claim fails, do not work that ticket.** A denied or unclaimed spawn gets **one
  diagnose-first retry only**: `pulse <ref>`, read the deny reason, retry only when the diagnosis
  changes the spawn — never a blind respawn. Two failures on one dispatch:
  comment the evidence on the ticket and surface the failure to the user. Never both resume a
  prior executor and spawn a fresh one for the same ticket.
- **Read the thread before working a ticket** (`sidequest comments <ref>`). Default reads retain all
  metadata; pass `--full` only for needed elided bodies.
- **Claims release on observed death, not age**: a long run is not stale (`pulse` shows
  `claim.reclaimable`; null = leave it), and closeout never consults a clock. Dead executor: salvage
  its worktree FIRST, `release SQ-3 --by <dead-worker-id> --status todo`, then spawn one replacement.
- Agents report automatically. **Never use `TaskOutput`** for a Sidequest task ID
  or launch name. THE polling read: `changes --since`; `pulse <ref>` for liveness.
  `TaskStop` only after terminal evidence.
  **Never proxy-wait** either: no shell/`Monitor`/cron task whose only job is waiting for an
  executor or polling for its artifact (a one-shot local readiness watch is fine).

**Repository publishing is the orchestrator's, alone.** Executors stop at verified local commits and
`submit` (claim released, parked in `doing`); `submit.body` holds the canonical full report, so do not post a separate pre-submit report comment. The
terminal comment keeps only the commit hash + verification. **Submit is terminal for the executor:** a
submitted ticket cannot be amended by messaging the executor that produced it, however small the
follow-up looks. File a follow-up ticket for changes. Redispatch the existing ticket only when it was
released without a pending submission. The orchestrator is the integrator: choose
`sidequest integrate <ref> --by <who> --mode apply|replay|merge` from the board default, then run the
publish transaction (lock → delivery → merged-tree gate → central version → review → push → reachability → `done`):
`references/publishing.md`.
**BOOKEND SUPERVISION.** Between dispatch and submission, do nothing with that ticket: no pulses,
comment reads, or peeks. At integration, read the submit report, deliver the range, and run the
merged-tree gate once per wave. Judge by that oracle, never by opening source or reviewing diffs. A human-grade review need is a separately routed `review-audit`
(or `security-audit`) ticket, never orchestrator re-review. Never mark a submitted ticket done without
integrating it; never re-dispatch one (refused as `submitted`). A dead executor's `done` only proves
the board transition, never that work shipped: salvage and close it per `references/publishing.md`.

## Route execution down; keep the loop tight

The orchestrator is usually the most expensive model. Gather enough evidence with direct read-only tools or
native `Explore`, then write precise tickets and route implementation by default. A direct claim is limited
to the INLINE-SAFE allowlist and its meaningful 20+ character recorded reason; it cannot retroactively
legitimize prior inline investigation. Executors own their tickets; investigations return **compressed findings** (~1–2k tokens)
as comments, not transcripts. Routed implementation agents use a freshly dispatched Sidequest executor.
`Explore`, `claude-code-guide`, and `statusline-setup` are narrow harness reconnaissance utilities; other
delegated implementation or investigation work needs a ticketed route.

**The shape is a LOOP, not a hand-off**: spawn a wave → executors return terse reports and
submit verified commits → read each thread, use scoped verification for each ticket, then run the
full suite once while publishing the wave in one transaction → re-plan, spawn the next. Don't accept a file list as proof of coverage. Prevent
executor mini-sessions from the spawn side: **the ticket is the spec** (the cheaper the model,
the more patch-level the detail); **scope the spawn prompt only with logistics**, the ticket
contract traveling in full and unnarrowed;
**Executors bounce back, they don't grind** — on ambiguity, growing scope, or two failed
attempts they release + report fast; **batch small same-model tickets into ONE executor**
(different models never batch); **parallel fan-out spawns one executor per ticket in a single
message** when the wave justifies it.

**Ready** = unclaimed, unblocked, not done, not archived — `sidequest ready --json
--brief` lists exactly this set, partitioned into **parallel-safe waves** by declared file scope.
Fan out one wave at a time; worktrees isolate files, not runtime resources (ports, servers,
databases), so serialize those collisions even inside a wave. A claim under a `--by` you don't
recognize means another session may be working the board; flag it first. With
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` on, executors ARE teammates — use the teammate
affordances, don't ignore them: answer scope requests over the mailbox, steer and resume with
`SendMessage`, and never stop→redispatch work a message can fix. Wave mechanics,
liveness, salvage, cost levers, agent teams:
`references/orchestration.md`.

## Category-first routing (ENFORCED)

Sidequest owns ticket routing. Do not recreate a standalone Switchboard (a split-out router could
only ever be a shared library imported by Sidequest). The live taxonomy is the routing authority:
classify from it, persist the ID, and the category route resolves model and effort — never
hand-pick either. Legacy complexity maps to bands at read time (1–3/4–6/7–10 →
`coding.easy`/`normal`/`hard`) without persisting a category.

1. **Classify before claim.** A `category: null` ticket gets stamped via `update --category <id>`
   **before** claim or spawn, then re-read. Reads never silently persist a classification.
2. **Trust the category projection.** Inject the read's category contract verbatim into the spawn
   prompt alongside the ticket contract; do not narrow, rewrite, or invent around it.
3. **The ticket read tells you exactly what to spawn.** Print `SQ-n · category · Model · effort`,
   then spawn the exact `agent` a fresh `dispatch <ref>` returned through native Agent,
   every spawn field unchanged (including `isolation`). **Claude routes**: `model: exec.model` +
   `mode: "bypassPermissions"` + a unique `name` (omitting `model` inherits the pricey session
   model). This includes Haiku: use the stable executor and model the dispatch returned, never a
   plain generic Agent. **Codex routes** (`exec.model` null): `model` OMITTED — the prompt's
   `[sidequest-route ...]` marker carries the real model; any `model` value silently runs
   Anthropic. Effort rides **verbatim** — a mismatched claim is refused. Detail and fallbacks:
   `references/routing-details.md`.
4. **Claim by resolved route:** `next --model X` / `ready --model X` filter by resolved route.

## Comments

`comment SQ-3 -m` (durable handoff, keep working) · `comments SQ-3` (read the thread).
**Comments are cross-actor handoffs, not diary entries**: decisions, constraints, ruled-out
approaches, risks, exact verification command/result, concise findings — no progress narration.
**Write findings back after an investigation** — root cause with evidence (`file:line`), the fix,
verification.

## Link tickets

`sidequest link SQ-4 depends-on SQ-3` (stored on both sides) · `blocks` · `related`
(non-blocking) · `unlink` removes. A ticket blocked by an unfinished one is skipped by `next` and
excluded from `ready`.

## Guidelines

**Act, then report** — run the command, tell the user the result (ref, status, or URL). **Keep
titles tight**; detail goes in `-d`. **Don't invent tickets** — only file what the user raised.
Reminders, stories, human assignment: `references/board-features.md`.
