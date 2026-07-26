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
- `references/publishing.md` — the serialized publish transaction.
- `references/routing-details.md`, `references/routing-guide.md` — profiles, board rows, routes,
  fallbacks, spawn parameters; classification and workflow recipe wiring.
- `references/high-stakes.md`
- `references/external-trackers.md`, `references/board-features.md`, `references/category-links.md`, `references/ticket-authoring.md`

## Plan substantial work on the board first

When a task is **more than a single small change**, do this **before writing any code**:

0. **Decide the shape.** One cohesive change → a single ticket. Several tickets sharing one
   outcome → a **Sidequest story** first (`sidequest story add`, then `--story US-n` per piece). A story is Sidequest's own optional
   `US-n` grouping, not a Claude Code feature: use it when the
   shared outcome, dependencies, or waves need to stay visible together;
   leave independent or small work as atomic tickets.
1. **Decompose into bounded, independently checkable tickets** (`sidequest add ...`). One ticket
   = one piece a single agent can finish in a short bounded run and check on its own — a change with
   a verify command, or an investigation whose "done" is a concrete answer. Split only
   genuinely independent pieces. **Enumerated deliverables are a decomposition smell** — prefer
   the story shape: a planning-investigation ticket pins the shared contract, then a wave
   consumes its findings. Each ticket carries the context its agent needs — anchors, contract or
   question, bounds, settled decisions, exact verify; missing context → gather it first or split
   further.
   Cut along affected surfaces: store, CLI, MCP surface, skill/docs, and applicable full test directory.
   Use directory scope where that absorbs the intended blast radius; details: `references/ticket-authoring.md`.
2. **Link dependencies** (`link SQ-4 depends-on SQ-3`); shape a story as design → wave(s) →
   integrate so `ready` serializes the phases.
3. **Execute proportionally** — "Route execution down" below.

A **complexity 4+** ticket gets a planning pass first: concrete scope, anchors, exact
verify command. Wave tickets verify with a scoped test; full-suite
green belongs to the integration or ship ticket. The board makes the plan survive context loss; a
user-directed mechanical edit to one or two exact named files with stated content needs no ticket;
any edit requiring other-file reading or investigation does. Coexisting with an external tracker:
`references/external-trackers.md`.

## MCP is the executor board interface

Routed executors use **only** the `mcp__plugin_sidequest_board__*` tools for their lifecycle
(`commit`/`submit` take the executor's absolute worktree path). Missing tools → report the
blocker and release through an available board tool, never a command-line fallback.

MCP is also the normal interface for everyday board and admin/config work; the CLI is the
fallback and the path for git-context-bound operations. After a schema-bumping release, reload
plugins before MCP writes. Commands default to the current project; `--project "<path-or-slug>"`
(MCP: `project`) targets another board.

`dispatch <ref>` is **instant**: it returns the ticket's stable executor, a short `spawn` fetch
stub, and a token. Pass every supplied `spawn` field (`name` and `description` too) to Agent
unchanged. The executor fetches its
token-gated durable packet as the first action: full description, category route and contract, scope,
state, comment metadata, and absolute attachment paths. It must inspect every readable
attachment and report missing or unreadable ones, while the spawn keeps that content out of this
transcript. Never trust a worker's self-report — the
claim's token and exact executor name are the evidence.

**Workflow callers:** call `route_recipe` or `sidequest route <category> --json`; wire only `recipe.agent.model` and `recipe.agent.promptPrefix + prompt` in Agent. Do not manually translate route, gateway, virtual-model, marker, or effort fields. See `references/routing-guide.md`.

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

`sidequest add -t "Contact form does not send" -d "..." -p high -l bug --category <id>` — read
the live taxonomy (`category_list` MCP / `sidequest category list --json`), pick the narrowest
category by its description, never its name, stamp it with `--category` (a project-scoped match beats a global row;
classify by the deliverable; never copy category tables into prompts). Too underspecified
→ the taxonomy's fallback; reclassify once evidence exists.
`--complexity 1-10` + `--why` is the legacy fallback for ambiguity — never set
`--model`/`--effort`. Also: `-s` status · `-i` image · `--file` scope (repeatable) · `--story
US-n` · `--anchors "file:line symbol"` / `--verify "exact command"` (seeded verbatim; anchors
<4k, verify <1k).

**Descriptions are developer-to-developer specs, never a PM summary. The executor's entire brief is this description:** **Where** — exact
anchors; **Contract** — behavior/edge cases or the question to answer; **Bounds**;
**Dependencies/decisions**; **Verify** — the exact command or answer shape. Bugs carry the
reproduction. **Scale the spec inversely to the executor's model** and **front-load everything
you already know** — a weak executor fails on missing context; never file vague.

**Route by remaining uncertainty, not original difficulty.** Investigation pays for the judgment
once; a ticket whose exact edit is already settled drops tier (`coding.easy`, or `direct-ok` for a
one-or-two-file mechanical edit), and `add`/`update` warn when it doesn't. The fix is never to thin
the ticket: evidence, constraints, and anchors are what strong-model authorship contributes. A fully
specified EDIT downgrades the category; rich context does not.

Carry paid recon forward: every touched surface gets a `file:line` anchor and relevant excerpt, so the
executor starts where you left off, never cold. Review-gated tickets also need adversarial acceptance
criteria before their first dispatch. Details: `references/ticket-authoring.md`.

Descriptions/comments render **full markdown**. **CRITICAL: use real newlines, never a literal
`\n`** — multi-line `-d`/`-m` needs a heredoc or `$'...'`; MCP tools take plain strings with real
newlines.

Mid-task side issue? Don't stop: file it with `mcp__plugin_sidequest_board__add` (CLI if MCP
is unavailable), attaching any pasted image path.
**Filing a ticket is not a request to work it.** "Make a ticket for X" means file and stop.

## List / update / close

`sidequest list` (this project; `--status todo` for one column) · `projects` (every board) ·
`update SQ-3 --status done` (move; also `-p -t -d -l`) · `rm SQ-3` (delete). `--json` reads data;
`--brief` on `list`/`ready` implies `--json` and drops bodies. **Default to
`--brief` for routine orchestration reads.** "Close / ship it" → `--status done`.

## Work a ticket (safe with other agents)

The board may be shared: a ticket must be **claimed** before you touch it, and claiming is
**atomic**. **Never work a ticket you haven't successfully claimed**, even one you just filed.
Lifecycle (executors use the matching MCP tools; CLI forms for inline/admin work):
`next`/`claim SQ-3 --by <you> --direct --reason "why no executor can do this"` (user-labeled `direct-ok` exception only) → `commit` (declared
ticket paths only) → `submit --commit <hash> --verify "<cmd>"` (parks the verified LOCAL commit)
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
`submit` (claim released, parked in `doing`); the submission holds the full report, and the
terminal comment keeps only the commit hash + verification. The orchestrator runs the publish
transaction (lock → integrate → central version → reverify → review → push → reachability → `done`):
`references/publishing.md`.
Before integrating or closing a submitted ticket, read
`sidequest comments <ref> --json` and resolve any unresolved risk.
**Green verification is necessary but never a review**: before pushing, review the diff (yourself
for a small change, a dispatched `review-audit`/`security-audit` executor otherwise) and resolve
or explicitly accept every finding. Never mark a submitted ticket done without integrating it;
never re-dispatch one (refused as `submitted`). A dead executor's `done` only proves the board
transition, never that work shipped: salvage and close it per `references/publishing.md`.

## Route execution down; keep the loop tight

The orchestrator is usually the most expensive model. Gather enough evidence with direct read-only tools or
native `Explore`, then write precise tickets and route implementation by default. A routed direct claim needs a
user-granted `direct-ok` label and a meaningful reason (20+ characters), and cannot retroactively legitimize
prior inline investigation. Executors own their tickets; investigations return **compressed findings** (~1–2k tokens)
as comments, not transcripts. Routed implementation agents use a freshly dispatched Sidequest executor.
`Explore`, `claude-code-guide`, and `statusline-setup` are narrow harness reconnaissance utilities; other
delegated implementation or investigation work needs a ticketed route.

**The shape is a LOOP, not a hand-off**: spawn a wave → executors return terse reports and
submit verified commits → read each thread, re-run the verify, publish the wave in one
transaction, re-plan, spawn the next. Don't accept a file list as proof of coverage. Prevent
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
recognize means another session may be working the board; flag it first. Wave mechanics,
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
