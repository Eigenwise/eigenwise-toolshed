---
name: sidequest
description: >-
  Open the sidequest board (a live, self-hosted Kanban of tickets) or manage tickets from the CLI/MCP.
  Use for "show me the dashboard", "open the board/kanban", "what's on my board", or to file, list,
  update, move, close, prioritize, label, or delete tickets — e.g. "add a bug ticket", "close SQ-3",
  "bump SQ-5 to urgent". Use when the user wants to WORK the board — "grab the next task", "pick up
  SQ-3" — which requires atomically CLAIMING a ticket first so shared boards stay safe across agents.
  Use when the user hands you substantial or multi-part work — decompose it into linked tickets BEFORE
  implementing. Use to comment on a ticket, ask the user something on it (a question means
  pause-and-wait), or relate tickets (depends-on/blocks). Tickets carry a category that drives
  model/effort routing, with complexity kept for legacy tickets and genuine ambiguity. For a mid-task
  side issue, prefer the ticket-filer agent instead of derailing.
---

# sidequest

sidequest is a Trello-light quest log. Tickets live in a central store under `~/.claude/sidequest`
(keyed by project path), and a bundled dashboard shows them as a live Kanban board — every project at
once. Everything is driven by one CLI (`bin/sidequest.js`) or the matching MCP tools.

Detail that used to live inline here is split into reference files — **read them only when the
situation calls for it**:

- [references/orchestration.md](references/orchestration.md) — fan-out waves, orchestration cost
  (keeping the lead cheap to wake), workflows (opt-in, sizing), agent-teams caveats, spike tickets,
  native Agent dispatch.
- [references/routing-details.md](references/routing-details.md) — category routes, fallback resolution,
  legacy complexity bands, and a worked dispatch example.
- [references/routing-guide.md](references/routing-guide.md) — model and effort guidance for choosing
  a category when the live taxonomy leaves genuine ambiguity.
- [references/external-trackers.md](references/external-trackers.md) — running sidequest alongside
  Jira / Linear / GitHub Issues.
- [references/board-features.md](references/board-features.md) — stories, notifications, reminders,
  human assignment, attachment paths.
- [references/category-links.md](references/category-links.md) — project category link states, warnings,
  and detach/relink behavior across CLI, MCP, and dashboard surfaces.

## Plan substantial work on the board first

When the user gives you a task that is **more than a single small change** — a feature with several
parts, multiple deliverables, or an explicit "split this into tickets" — do this **before writing any
code**:

0. **Decide the shape.** One cohesive change → a single ticket, done. A feature that naturally breaks
   into several tickets sharing one outcome → create a **Sidequest story** first (`sidequest story add
   -t "..."`), then file each piece into it with `--story US-n`. A story is Sidequest's own optional
   `US-n` grouping, not a Claude Code feature: use it when the shared outcome, dependencies, or waves
   need to stay visible together; leave independent or small work as atomic tickets. Infer this
   yourself; the user shouldn't have to say "make a story". (Story commands:
   [references/board-features.md](references/board-features.md).)
1. **Decompose into bounded, independently checkable tickets** (`sidequest add ...`). One ticket = one piece a single agent can finish in a short bounded run and check on its own. That's often a code change with a verify command, but just as often an investigation, spike, or review whose "done" is a concrete answer or artifact, not a diff — don't force every ticket into an implementation shape. The reason to split is **parallelism as much as cost**: independent tickets fan out to sub-agents that run at the same time, so cut where the pieces are genuinely independent (several files to probe, several questions to answer, several changes that don't touch each other). Split work with multiple independently checkable outcomes or that would make an agent broadly rediscover the codebase; keep tightly coupled work that must land and resolve together in one ticket — atomic does not mean artificially tiny. **Enumerated deliverables are a decomposition smell:** when one ticket would "own" several named pieces (e.g. CLI + wiring + script + state metadata + tests), that enumeration is the tell that it's a feature pivoting on one shared contract, not a single atomic change — prefer the **story shape** over a single large ticket. File a cheap read-only design/scout ticket (route it to a low-cost model) that pins the shared contract and anchors, then an independent **wave** that fans the deliverables out to parallel sub-agents, each reading that scout's result. Keep them bundled in one ticket only when the pieces genuinely cannot verify independently. This is also how context-completeness stays cheap: don't pay for it with orchestrator tokens by investigating inline on the pricey thread — pay for it with the scout ticket whose output the wave consumes, instead of the orchestrator re-deriving it. Each ticket carries the context its agent needs: exact anchors (files, symbols, lines where known), the contract or the question it answers, bounds/non-goals, dependencies or settled decisions, and how you'll know it's done (an exact verify command for a change, the artifact or answer shape for an investigation). The test: if finishing the ticket would need context its description does not carry, gather it first and put what you learned in the spec, or split it further. Cut along file/module boundaries (not conceptual halves), declare each piece's scope with `--file` (repeatable; a dir prefix covers everything under it), and shrink until the complexity drops — a piece still scoring 7+ is usually a small design ticket plus a mechanical application ticket.
2. **Link dependencies**: `sidequest link SQ-4 depends-on SQ-3`. Shape a story as design → wave(s) →
   integrate, so `ready` naturally serializes the phases.
3. **Execute proportionally** — see "Execute proportionally" below. The board stays the source of
   truth for what's left.

Before filing a **complexity 4+** ticket, make a scout pass first: read the integration surface yourself when it is obvious, or delegate a proportional read-only scout when it is unfamiliar. Pin the resulting file scope, executor anchors, and exact verify command in the ticket before filing. For a wave ticket, make that verify command a scoped test or reproduction for its declared files; reserve full-suite green for the integration or ship ticket. A separate scout ticket is still only for a genuinely unfamiliar and large surface; the requirement is the planning pass and its concrete output, not ceremony.

The point of the board: the plan is visible, survives context loss, and other agents can pick up
unblocked pieces. For a genuinely trivial one-step change, just do it — no ticket ceremony.

If the repo already uses Jira/Linear/GitHub Issues, that tracker owns the deliverable; sidequest is
still your local execution ledger — see
[references/external-trackers.md](references/external-trackers.md).

## The MCP tools ARE the board interface; the CLI is the fallback

When tools named **`mcp__plugin_sidequest_board__*`** are in your toolset (`list`, `ready`, `add`,
`update`, `claim`, `next`, `done`, `release`, `comment`, `ask`, `comments`, `link`, `assign`,
`models`, `projects`), **every board action goes through them — reaching for Bash out of habit when
they're present is the wrong call.** Same store, same rules (complexity+why on `add`, effort guard on
`claim`, atomic claiming), but structured JSON in/out, one tool approval instead of a Bash prompt per
call, and no shell-quoting trap (multi-line markdown bodies are plain strings with real newlines).
They take the same fields as the CLI flags shown below — the examples in this file use CLI form for
compactness, not as a recommendation. After shipping a schema-bumping Sidequest release, treat an
already-loaded MCP server as a stale writer until plugins reload: route every store write through the
new CLI and use MCP only for reads. When resuming or recovering context, read the board through
`mcp__plugin_sidequest_board__list` with `status: doing` first; use the resolved CLI only when MCP is
unavailable.

The **CLI** is for when the MCP tools aren't loaded, for humans, and for the things only it does:
`dashboard`/`serve` and legacy temporary `native-agent` cleanup. For routed work, `dispatch <ref>` is **instant by default**: it returns the ticket's stable per-model executor, a complete `briefing`, a `spawn` object, and a token. Spawn that exact stable executor immediately with the returned briefing as its prompt. There is no registration announcement or watcher-lag wait. Claude routes pass the resolved `model`; Codex routes omit it so the generated executor's frontmatter pins the backend. Use `dispatch <ref> --ephemeral` only for cross-session adoption. It creates a self-contained temporary executor definition, and that opt-in path waits for the generated type to register. Never end the turn waiting for registration: continue independent work or use a background timer to wake the session. Any session may
adopt an unspawned prepared definition, whose claim must carry its token. Routes without a stable executor, such as haiku, use `--ephemeral`. Never trust a worker's self-report: the dispatch token and claim executor guard are the evidence. The
SessionStart hook injects the **resolved
absolute command** (`node "<path>/bin/sidequest.js"`) into your context — use exactly that with the
Bash tool; `sidequest` in this file is shorthand for it. Commands default to the current project
(`$CLAUDE_PROJECT_DIR`); add `--project "<path-or-slug>"` (MCP: the `project` field) for another
board.

**Where things live** (never scan the filesystem from root to find them): the CLI at
`plugins/sidequest/bin/sidequest.js` under the installed plugin; ticket data under
`~/.claude/sidequest` (override: `SIDEQUEST_HOME`) as `projects/<slug>/tickets/<id>.json`; attachment
images under `projects/<slug>/assets/<ticket-id>/` (resolve via `sidequest list --json` — see
[references/board-features.md](references/board-features.md)).

## Open the dashboard

```bash
sidequest dashboard
```

Idempotent — starts the local server if needed, opens the browser, prints the URL. **Report the URL.**
Binds to `127.0.0.1` only.

## File a ticket

```bash
sidequest add -t "Contact form does not send" -d "Submit does nothing; no email arrives." -p high -l bug \
  --category <id>
```

1. Read the live taxonomy from a board read (`list` or `ready` JSON includes `categories`). Match the
   work to each category's description, choose the narrowest fit, and stamp its ID with `--category`.
   A plausibly matching project-scoped category wins over any global row because it exists for that
   project's distinct work. Classify by the deliverable, not by whether the workflow involves code or
   tooling. Categories are board data: never copy a category table or ID list into a prompt or skill.
2. If the request is too underspecified to classify safely, use the taxonomy's fallback category or file
   it unclassified only when the API explicitly permits that. Reclassify once concrete evidence exists.
3. `--complexity 1-10` + `--why "<motivation>"` remains the legacy route for old tickets and the
   fallback when category classification is genuinely ambiguous. Do not set `--model` or `--effort`.
4. `-t` title (required) · `-d` description · `-p` `low|normal|high|urgent` · `-l` label (repeatable) ·
   `-s` status `todo|doing|done` · `-i` image path (repeatable) · `--file` scope (repeatable) ·
   `--story US-n`
5. `--anchors "file:line symbol"` and `--verify "exact command"` seed native executor prompts verbatim.
   For wave tickets, make `--verify` the precise per-ticket test or reproduction; the integration or ship
   ticket owns the full suite. Keep anchors under 4k chars, verify under 1k, and the assembled prompt under
   7.6k so Windows' 8191-character command limit stays safe.

**Descriptions are developer-to-developer specs, never a PM summary.** For non-trivial work, make the description an agent-ready brief: **Where** gives exact anchors (files, symbols, lines where known); **Contract** states the intended behavior, inputs/outputs, edge cases, and error behavior — or, for an investigation/spike, the question to answer and why it matters; **Bounds** names non-goals; **Dependencies/decisions** records prerequisites and choices already settled; **Verify** gives the exact command/test/reproduction that proves a change done, or the artifact/answer shape that proves an investigation done. Bugs additionally carry the reproduction; spikes state what's actually unknown. Trivial tickets only need the fields that add information, never boilerplate. **Scale the spec inversely to the executor's model**: work routed to a cheap model needs a near-patch-level spec — exact anchors, expected strings, precise verification commands — because the spec substitutes for judgment. **Everything you already know goes in the description**: a weaker executor fails on missing context, not on the work itself, so front-load what your investigation found (paths, the surrounding contract, the gotcha you spotted) instead of letting the executor re-derive it. Too little detail to write that? Investigate until you have it, or ask a quick clarifying question — never file a vague ticket.

Descriptions and comments render **full markdown** in the dashboard — use headings/lists/fenced blocks
when the spec needs structure. **CRITICAL: use real newlines, never a literal `\n`** — the two
characters backslash-n render as text. Multi-line `-d`/`-m` values need a heredoc or `$'...'` quoting
(MCP tools take plain strings with real newlines, no escaping):

```bash
sidequest add -t "Contact form does not send" --complexity 4 --why "one handler + its endpoint" -d "$(cat <<'EOF'
## Where
`src/routes/contact.ts` — the `POST /contact` handler

## Verify
`curl -X POST localhost:3000/contact -d '...'` and confirm an email arrives.
EOF
)"
```

For a side issue raised **while you're mid-task** ("oh, and the footer link is broken"), don't stop:
spawn the **`ticket-filer`** subagent (`run_in_background: true`) with the issue text, any pasted
image path, and the CLI command. **Filing a ticket is not a request to work it** — "make a ticket for
X" means file it and stop.

## List / update / close

```bash
sidequest list                    # this project, grouped by column
sidequest list --status todo      # one column
sidequest projects                # every board with open counts
sidequest update SQ-3 --status done   # move (todo|doing|done); also -p, -t, -d, -l
sidequest rm SQ-3                 # delete
```

Add `--json` to read data instead of showing it. Add `--brief` on `list`/`ready` (it implies
`--json`) for the compact shape: ref, title, status, priority, complexity, category ID/name, model, effort,
files, claim, `blockedBy`, a `comments` count, and `awaitingReply`. No description bodies, no thread
contents. **Default to `--brief` for routine orchestration reads**; drop it only when you actually
need bodies. "Close / mark done / ship it" → `--status done`. "Start / in progress" → `--status
doing`.

## Work a ticket (safe with other agents)

The board may be shared — other sessions or teammates can be working it too. A ticket must be
**claimed** before you touch it, and claiming is **atomic**: two workers can never both win the same
ticket. **Never start work on a ticket you haven't successfully claimed**, even one you just filed.

```bash
sidequest next --by <you>              # atomically claim the top-priority available ticket
sidequest claim SQ-3 --by <you>        # or claim a specific one
sidequest done SQ-3 --by <you> --model <model> --effort <level>   # finish + stamp who/what worked it
sidequest release SQ-3 --by <you>      # or drop it unfinished (optionally --status todo)
```

- **`--by` must be genuinely unique to this session** — generate a random token once (e.g.
  `claude-<8 hex>`) and reuse that exact string all session. A claim only fails when `held.by !== by`,
  so two sessions both using a generic label like `"claude"` silently coexist as the same worker and
  the atomicity guarantee never trips.
- **If a claim fails** (already claimed / done / gone), **do not work that ticket** — pick another or
  stop. Re-read its claim state immediately before spawning any replacement. Never both resume a prior
  executor with `SendMessage` and spawn a fresh executor for the same ticket.
- **Read the thread before working a ticket** (`sidequest comments <ref>`) — a prior agent may have
  left exactly the context you need.
- **Stale claims** are reclaimable after a TTL (`SIDEQUEST_CLAIM_TTL_MIN`, default 60 min). Claims
  this session still holds auto-release back to `todo` when the session ends (bundled SessionEnd
  hook); `sidequest reconcile` runs the same release by hand. When a dead executor's claim age exceeds
  that TTL, release it with `sidequest release SQ-3 --by <dead-worker-id> --status todo`, then re-read
  the ticket and respawn one replacement. Do not force a fresh claim while a live-looking worker may return.

When a dead or stopped executor's ticket reads `done`, inspect `git status` and the ticket's declared files before
trusting that it shipped. The done state proves only the board transition; a missing commit hash or uncommitted
in-scope diff means recover the work, then commit and push it before treating the ticket as complete.

## Route execution down; keep the loop tight

Every ticket is category-routed from the live taxonomy (below), and the economics are the point:
**the orchestrator (this thread) is usually the most expensive model in the session; the stamped
models are cheaper.** Executing ticket labor inline pays orchestrator prices for laborer work and
drags tool output into the planning context — so **route essentially all real execution to each
ticket's stamped model**. Inline only a genuinely trivial one-step change (a one-liner, a rename)
where the spawn round-trip costs more than the work itself. Never pull substantial or parallel work
inline to save orchestration cost: that just moves the whole execution onto this expensive thread at
full context, which costs more than the wakeups it was meant to save.

**The orchestrator keeps the thinking; each executor owns its ticket.** Decision-level investigation
— root-causing across findings, deciding the decomposition, writing the specs, reviewing and
integrating what comes back — stays in this thread: its value is integration across pieces, and
pushing it down just makes a cheap model do the real reasoning and compress it lossily. Breadth-first
discovery *in service of* that plan (which files touch X, scanning logs for the needle) is what you
delegate — and a scout returns **compressed findings** (a pointer list or short summary, ~1–2k
tokens), never transcripts. Once a ticket is cut with a self-contained spec, its executor owns the
within-ticket work end to end — don't pull ticket-internal digging back up here.

**The shape is a LOOP, not a hand-off.** Orchestrator spawns a wave → executors return terse reports
*quickly* → orchestrator re-runs each ticket's exact assigned verify command, verifies, integrates,
re-plans, spawns the next wave. Do not accept an executor's file list as proof of coverage. Done comments
echo the exact command and full output tail so a narrowed verify is visible at a glance. Many short
round-trips beat one long autonomous run. **Verify by artifact, not by claim** — an executor report cites the
actual verification output (the test line, the diff), and you spot-check it; cap how much you fan out
in parallel at what you can actually verify. The failure mode to prevent is the executor
mini-session: a worker that runs for ten minutes re-discovering context, broadening scope, and
re-verifying the world. You prevent it from the spawn side:

- **The ticket is the spec.** File it with exact anchors and the precise verify command (the cheaper
  the model, the more patch-level the spec — see "File a ticket"). A well-specced ticket leaves the
  executor nothing to wander on.
- **Scope the spawn prompt only with logistics**: the ref, worker id and exact claim/done commands, stamped effort/model, and whether a thread is empty. **Carry the ticket contract in full and unnarrowed.** Do not describe a smaller implementation than the ticket specifies, omit deliverables, or reinterpret its bounds. The ticket is authoritative; edit it first if planning changes. **Anti-pattern: dispatch narrower than ticket.** Cantizans SQ-87 required extracting the done block in every lesson route across two commits, while its dispatch prompt limited wiring to intervals as a reference. The executor correctly bounced rather than silently shrinking the contract, costing another round-trip.
- **Executors bounce back, they don't grind.** An executor that hits ambiguity, growing scope, or two
  failed attempts should release + report fast so you can re-scope or re-route — that's built into
  the executor agents.
- **Batch small same model tickets into ONE executor.** When a wave holds several small tickets all
  stamped with the *same* model+effort, spawn one executor with the whole list of refs; it claims →
  works → dones them in sequence. One spawn's overhead amortized over N tickets. Different stamped
  models don't batch — split per model.
- **Parallel fan-out — one executor per ticket, spawned in a single message** — when `ready` shows a
  wave of genuinely independent tickets big enough to justify a spawn each. Atomic claiming is what
  makes this safe. Keep dependent or same-file work serial (that's what `depends-on` links and
  `--file` scopes are for).

A ticket is **ready** when it's unclaimed, unblocked, not done, not archived — `sidequest ready
--json --brief` lists exactly this set, partitioned into **parallel-safe waves** by declared file
scope. Fan out one wave at a time: read the wave, assess fixed ports, domains, shared databases, existing
servers, and files outside the declared scopes, then spawn only tickets with no shared runtime resource.
Worktrees isolate files, not those resources, so serialize collisions even when `ready` puts them in the
same wave. State who owns coordination and each worker's ticket before launch. Workers report conflicts,
server lifecycle, files changed, blockers, cleanup, and verification output. Wait, re-run `ready`, repeat.
Before a large
fan-out, check `sidequest list --status doing --brief --json` — claims under a `--by` you don't
recognize mean another session may be working the board; flag it to the user first.

The main thread's job is decompose, score, spec, spawn, integrate. Larger orchestration shapes
(workflows — opt-in, you propose rather than launch — and agent-teams caveats):
[references/orchestration.md](references/orchestration.md).

**A substantive investigation belongs on a ticket.** A root-cause hunt or "figure out how X works"
spike gets filed, claimed, and its findings written back as a comment — that's the deliverable; an
uncommented investigation gets redone by the next agent. A quick ephemeral scout doesn't need a
ticket.

## Category-first routing (ENFORCED)

The live board taxonomy is the routing authority. Read `list` or `ready` JSON, match the requested
work against each returned category's `description`, choose the narrowest category, and persist its ID
when filing. The returned category route resolves model and effort, so you never hand-pick either.
Category descriptions and contracts are live board data: do not hardcode category IDs, names, tables,
or route assumptions in prompts.

**Legacy complexity stays available.** Use `--complexity 1-10` with a concrete `--why` only for an
existing complexity-only ticket or when category classification is genuinely ambiguous after reading
the taxonomy. Read-time mapping sends 1–3 to `coding.easy`, 4–6 to `coding.normal`, and 7–10 to
`coding.hard`; it does not persist a category. The model and effort come from that category's route
and fallback chain, documented in [references/routing-details.md](references/routing-details.md).

**Rules for working the board:**

1. **Classify before claim.** A ticket with `category: null` must be classified from the taxonomy in a
   fresh `list`/`ready` read, then stamped with `update --category <selected-id>` **before** claim or
   spawn. Re-read it after the update. Reads must not silently persist a classification. An invalid or
   disabled category falls back to the returned general projection with a warning; repair the stored ID
   through an explicit update.
2. **Trust the category projection.** The ticket includes the selected category's contract plus its
   resolved `model`/`effort` and `exec` object. Inject the category contract text verbatim into the
   executor spawn prompt alongside the ticket's full contract. Do not narrow, rewrite, or invent
   instructions around it.
3. **The ticket read tells you exactly what to spawn.** Each ticket carries a resolved `category`,
   `runsLabel`, concrete `model`, `backend`, `effort`, and exact `executor` from a fresh
   `ready`/`list --json --brief` read of the current wave. Before every spawn, print `SQ-n · category ·
   Model · effort`. Claude Code's native suffix is external metadata; the Sidequest route line and
   executor name are authoritative. **All routed work dispatches through the native Agent tool**
   (`exec.dispatch` is `native-agent` on every route). For a ticket, `dispatch <ref>` (CLI) or the
   matching MCP tool is **instant by default**: it returns the stable per-model `agent`, a complete
   `briefing` to use as the spawn prompt, and the token-gated claim details. Spawn that exact stable
   `agent` immediately from the returned `spawn` object. There is no registration announcement or
   watcher-lag wait. Use `dispatch <ref> --ephemeral` (or `{ephemeral:true}` in MCP) only when a
   cross-session handoff needs a self-contained temporary executor; that path still waits for the
   generated type to register, and any session may adopt it.
   - **Claude (`exec.model` non-null):** spawn `exec.agent` through the Agent tool with
     `model: exec.model`, `mode: "bypassPermissions"`, and a unique `name`. Sidequest executors are
     unattended workers; never omit bypass or their ordinary Bash calls prompt into the lead session.
     **Never spawn a Claude-route executor without `model:`** — an omitted model inherits the session
     model (usually the priciest route), silently defeating routing; the bundled PreToolUse hook
     injects or blocks as a backstop, but the spawn call must carry it.
   - **Codex (`exec.model` null):** spawn the EXACT generated backend-specific executor named by
     `exec.agent` (e.g. `sidequest-exec-codex-gpt-5-6-terra-high`) through the Agent tool with
     `mode: "bypassPermissions"`, a unique `name`, and **the `model` parameter OMITTED entirely** —
     `exec.model` is null precisely so you leave it out. The real model id is pinned in the generated
     agent's frontmatter (with bypass), and omitting `model` runs that pin for real: the spawned
     agent self-reports the GPT backend and the gateway's codex counter advances. Passing ANY
     `model` value (`fable|opus|sonnet|haiku`) overrides the pin and silently runs Anthropic
     instead. Never substitute a generic `sidequest-exec-<effort>` agent for a Codex route — the
     board refuses its claim.
   `<effort>` is the ticket's `effort` **verbatim from that read**, never a level you judge fits
   better. The executor claims with `--effort <baked level>` and the board **refuses the claim on a
   mismatch**, bouncing the ticket back. A haiku ticket has no effort: `exec.agent` is null, spawn a
   plain Agent with `model: haiku` (still named).
   **Concrete Codex route:** a category route resolves through its category fallback, then the global
   fallback, then the hardwired safety net when a selected model is unavailable. `exec` already tells
   you what runs it. Spawn the exact generated executor with `model` omitted. If reads show a degraded
   route, do nothing special: trust the `exec` object from the fresh read.
4. **Claim by resolved route:** `next --model X` / `ready --model X` filter tickets by their resolved
   route, including category-routed tickets.

## Comments & questions

```bash
sidequest comment SQ-3 -m "Reused the SQ-1 fixtures here."   # note-to-self: keep working, no pause
sidequest ask     SQ-3 -m "Cover the v2 API too?"            # addressed to the USER: needs a reply
sidequest comments SQ-3                                       # read the thread
```

- **Write findings back as a comment after any investigation or substantive change** — root cause
  with evidence (`file:line`), what you ruled out, the fix, how you verified. The orchestrator report
  dies with its context; the comment is the durable record.
- **An `ask` posts the question but does not itself pause** — follow it with `sidequest await SQ-3`
  (blocks up to 120s; `--timeout 900 --poll 10` for longer). `await` exits 0 with the reply text, 1 on
  timeout. **Never continue past your own unanswered question** — on timeout, `await` again or tell
  the user you're blocked. Your own interim comments don't count as an answer.
- A "❓ awaiting reply" marker in `list`/`comments` flags a still-unanswered question, including from
  earlier sessions.

## Link tickets

```bash
sidequest link SQ-4 depends-on SQ-3   # SQ-4 blocked by SQ-3 (stored on both sides)
sidequest link SQ-1 blocks SQ-2
sidequest link SQ-5 related SQ-6      # non-blocking association
sidequest unlink SQ-4 SQ-3
```

A ticket blocked by an unfinished one is skipped by `next` and excluded from `ready`.

## Guidelines

- **Act, then report** — run the command, tell the user the result (ref, status, or URL). Default to
  the current project's board.
- **Keep titles tight**; detail goes in `-d`.
- **The dashboard is live** — CLI changes appear on an open board within seconds.
- **Don't invent tickets** — only file what the user actually raised.
- Reminders (`sidequest remind SQ-3 --in 1h`) and human assignment (`sidequest assign SQ-3`):
  [references/board-features.md](references/board-features.md).
