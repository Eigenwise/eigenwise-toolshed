---
name: sidequest
description: >-
  Open the sidequest board (a live, self-hosted Kanban of tickets) or manage tickets from the CLI.
  Use for "show me the dashboard", "open the board/kanban", "what's on my board", or to file, list,
  update, move, close, prioritize, label, or delete tickets — e.g. "add a bug ticket", "close
  SQ-3", "bump SQ-5 to urgent". Use when the user wants to WORK the board — "grab the next task",
  "pick up SQ-3" — which requires atomically CLAIMING a ticket first so shared boards stay safe
  across agents. Use when the user hands you substantial or multi-part work — decompose it into
  linked tickets BEFORE implementing, then work them one at a time. Use to comment on a ticket, ask
  the user something on it, or await a reply — a question means pause-and-wait, unlike a plain
  note-to-self comment. Use to relate tickets (depends-on/blocks). Tickets carry a complexity score
  that drives model/effort routing. For a mid-task side issue, prefer the ticket-filer agent
  instead of derailing.
---

# sidequest

## Plan substantial work on the board first

When the user gives you a task that is **more than a single small change** — a feature with several
parts, a request with multiple deliverables, or an explicit "split this into tickets" / "make tickets
for this" — do this **before writing any code**:

**Scout before you decompose — in parallel.** For anything non-trivial, build a quick map of the
surface first, but fan a couple of read-only explorers out **at once** (one per subsystem or open
question) instead of reading file-by-file yourself. That short parallel scout is exactly what lets you
cut the work into pieces that are genuinely *independent* in the next step — guessing the boundaries
without it produces tickets that collide. Keep it proportional: a small task needs no scout, a big one
needs a few explorers, not twenty.

0. **First decide the shape: a user story, or a standalone ticket.** Judge the request:
   - **Standalone ticket** — one cohesive change, a single bug, a small task. File one ticket
     (`sidequest add ...`) and stop deciding; no story needed. Most requests are this.
   - **User story** — a feature that naturally breaks into several tickets that share a goal (a "backend
     + API + dashboard + docs" build, an epic, anything you'd otherwise decompose into many tickets).
     Create a **story** first (`sidequest story add -t "..."`), then file each piece into it with
     `sidequest add ... --story US-n`. The board color-codes every ticket by its story, so the whole
     arc stays visually grouped. This is your call — the user shouldn't have to say "make a story";
     infer it from the scope.
1. **Decompose** the work into one ticket per distinct piece (`sidequest add ...`, adding `--story US-n`
   when it belongs to a story from step 0). Cut along file boundaries, declare each piece's scope with
   `--file`, and size pieces so a cheaper tier can execute them — see "Decompose for parallelism" below.
2. **Link dependencies** so the order is explicit: `sidequest link SQ-4 depends-on SQ-3`,
   `sidequest link SQ-2 blocks SQ-8`. (See "Link tickets" below.)
3. **Route each ticket to its executor subagent** — don't execute in the main thread. `claim`, spawn the
   ticket's `sidequest-exec-<effort>` at its derived model, let it do the work and `done`, repeat — the
   board stays the source of truth for what's left. See "Execute in a routed subagent by default" and
   "Complexity-driven routing" below for why.

This is the point of having the board: the plan is visible, survives context loss, and other agents can
pick up unblocked pieces. Don't skip it for anything non-trivial. For a genuinely trivial one-step
change, just do it — no need to ticket everything (and no story).

sidequest is a Trello-light quest log. Tickets live in a central store under `~/.claude/sidequest`
(keyed by project path), and a bundled dashboard shows them as a live Kanban board — every project at
once. Everything is driven by one CLI: `bin/sidequest.js`.

## Works alongside an external tracker (Jira / Linear / GitHub Issues)

A repo already using Jira (or Linear, or GitHub Issues) does **not** make sidequest redundant — they
track different things, so use both. Don't skip the board just because the work is "already tracked"
somewhere; that reflex is exactly how the decompose-and-fan-out discipline gets dropped.

- **The external tracker owns the deliverable.** It's the system-of-record humans read: the story, the
  acceptance criteria, the status the team reports on. You don't replace it, and you usually don't file
  there on the model's behalf.
- **sidequest owns your local execution.** It's the agent's working ledger for *this* session: how you
  cut the Jira item into parallel-safe pieces, fan subagents out over them, coordinate claims across
  agents so nothing collides, and write spike findings back as comments that outlive your context.
  None of that belongs in Jira, and none of it happens on its own.

**How to run both, in practice:**

1. Take the external item (e.g. `CTR-13316`) and, if it's more than a trivial change, **decompose it
   into local sidequest tickets** — one per independent piece, `--file`-scoped, same as any other plan.
   Mirror the external ref in the title so the link is obvious: `sidequest add -t "CTR-13316: guard
   ILIKE against <3-char variants" ...`.
2. **Scout in parallel, then fan out** over the independent pieces exactly as you would without Jira
   (see "Decompose for parallelism" and "Fan out over independent tickets"). The presence of a Jira
   ticket changes nothing about how you parallelize the work.
3. **Record findings on the sidequest ticket**, not just in the PR — root cause, `file:line`, what you
   ruled out — so a later agent (or you, post-compaction) can pick it up.
4. When the work lands, update the **external** tracker/PR as the team expects; the sidequest tickets
   were your scaffolding and can just be marked `done`.

The short version: **Jira says *what* to build; sidequest is *how you execute it* here.** One doesn't
substitute for the other.

## Finding the CLI

You do **not** need to hard-code the path. When the user mentions the board or a ticket, the sidequest
capture hook injects the **resolved absolute command** into your context, shown as:

```
node "<absolute path>/bin/sidequest.js"
```

Use exactly that. Run it with the **Bash tool**. (If for some reason it isn't in your context, the CLI
is `bin/sidequest.js` inside the installed `sidequest` plugin directory; invoke it with `node`.) In the
commands below, `sidequest` is shorthand for that `node "…/bin/sidequest.js"` prefix.

The board a command acts on defaults to `$CLAUDE_PROJECT_DIR` (the current project), so you rarely pass
a project. Add `--project "<path-or-slug>"` to target another board.

## Where things live on disk (never scan from root to find them)

- **The CLI**: `plugins/sidequest/bin/sidequest.js` under the sidequest plugin — invoke it as
  `node "<path>/plugins/sidequest/bin/sidequest.js"` (see "Finding the CLI" above; the capture hook
  already hands you the resolved path).
- **Ticket data**: a central store outside any repo — root `~/.claude/sidequest` by default, overridable
  with the `SIDEQUEST_HOME` env var. Under it: `projects/<slug>/tickets/<id>.json` (one file per
  ticket) and `projects/<slug>/meta.json`.
- **Attachment images**: `projects/<slug>/assets/<ticket-id>/<filename>` under that same root. To
  resolve one from a ref like `SQ-12`, run `sidequest list --json` (or `--json` on any listing
  command), find the ticket, and read its `project` slug plus the ticket's internal `id` and its
  `assets` array — then join `<root>/projects/<slug>/assets/<id>/<filename>`. Don't guess the filename
  or its location.
- **Never run a full-disk scan** (`find /`, `find / -iname ...`, or similar) to locate the CLI, the
  data dir, or an attachment. All three live at the fixed, known locations above — go straight there.

## Open the dashboard

When the user asks to see the board/dashboard/kanban:

```bash
sidequest dashboard
```

This starts the local server if it isn't already running (it's idempotent — it reuses a running one),
opens the user's default browser to the board, and prints the URL. **Report the URL** it prints in case
the browser didn't pop up. The server binds to `127.0.0.1` only; it's a private, local tool.

## File a ticket

```bash
sidequest add -t "Contact form does not send" -d "Submit does nothing; no email arrives." -p high -l bug -l frontend \
  --complexity 4 --why "one form handler + its endpoint; reproduce, fix, verify the mail path"
```

- `-t` title (required) · `-d` description · `-p` priority `low|normal|high|urgent` (default `normal`)
- `--complexity 1-10` + `--why "<motivation>"` (BOTH required — routing is derived from the score; see
  "Complexity-driven routing" below for the rubric; `--model`/`--effort` are not accepted)
- `-l` label (repeat for several) · `-s` status `todo|doing|done` (default `todo`)
- `-i` image path (repeat for several) — attach a pasted screenshot by its file path

**Descriptions are developer-to-developer technical specs — write them as one developer handing work
to another, never as a project manager summarizing.** "Improve the checkout flow" is not a ticket; a
ticket says *which* files and functions, *what* behavior changes (inputs → outputs, edge cases), and
*how to verify*. Concretely, a description must carry:
- **Where**: the exact files/functions/anchors the work lands in (you often know — say so).
- **The contract**: what changes at a code level — inputs → outputs, edge cases, error behavior.
- **Bounds**: constraints, known out-of-scope, what must NOT change.
- **Verification**: the command, test, or reproduction that proves it done.
- **Bug tickets** additionally need the reproduction (what you did / what happened / what you
  expected); **spikes** state what's actually unknown and why it matters.

**Scale the spec to the executor, inversely.** The lower the tier that will work the ticket (its
derived routing), the *more* complete the description must be — a cheap executor supplies less
judgment, so the spec substitutes for tier. Work routed far below the filer should read near
patch-level: exact anchors, exact expected strings, the precise verification commands. This is the
flip side of decompose-for-parallelism: a well-shrunk ticket *is* mostly its spec.

If you don't have enough of that detail, ask a quick clarifying question rather than filing a vague
ticket — a thin ticket just costs the next reader (you, another agent, or the user) another round trip.

**Descriptions and comments render full markdown** in the dashboard — headings, ordered/unordered
lists, fenced code blocks, blockquotes, `[links](url)`, and inline `**bold**`/`*italic*`/`` `code` ``.
Structure the spec with it: a short lead line, then headings or a list for Where / Contract / Bounds /
Verify, bullets for enumerations, fenced blocks for commands or expected output, backticks for file
paths and identifiers. It should aid the reader, not be decoration — reach for structure because the
spec needs it, not to fill every line.

**CRITICAL — use real newlines, never a literal `\n`.** A multi-line `-d`/`-m` value needs actual line
breaks: a shell heredoc, or `$'...\n...'` quoting. The two literal characters backslash-n render as
text in the dashboard, not a line break — that exact bug is why this guidance exists. For example:

```bash
sidequest add -t "Contact form does not send" --complexity 4 --why "one handler + its endpoint" -d "$(cat <<'EOF'
## Where
`src/routes/contact.ts` — the `POST /contact` handler

## Contract
- Submit currently no-ops; it should call the mail service and return 200 on success, 4xx on validation failure.

## Verify
`curl -X POST localhost:3000/contact -d '...'` and confirm an email arrives.
EOF
)"
```

For a side issue the user tosses out **while you're mid-task** ("oh, and the footer link is broken"),
don't stop your current work: spawn the **`ticket-filer`** subagent (ideally `run_in_background: true`)
with the issue text, any pasted image path, and the CLI command. It files the ticket while you keep
going. The capture hook reminds you of this and hands you the image path.

## User stories

A **user story** groups several tickets that share a goal and color-codes them together on the board.
Reach for one when a request breaks into multiple tickets (see "Plan substantial work" above); skip it
for a lone ticket.

```bash
sidequest story add -t "Checkout revamp" [-d "..."] [--color teal]   # prints its US-n ref
sidequest story list                                                  # stories + color + ticket count
sidequest story show US-1                                             # the story and its tickets
sidequest story update US-1 -t "New title" [--color "#7a5ba8"]        # rename / recolor
sidequest story rm US-1                                               # delete (member tickets detached)
```

- **Attach a ticket to a story**, at creation or later:
  `sidequest add -t "..." --story US-1` · `sidequest update SQ-3 --story US-1` ·
  `sidequest update SQ-3 --story none` (to clear it).
- **Color** is optional — a distinct one is auto-assigned per story. Override with a hex (`#7a5ba8`) or a
  name: `terracotta, teal, violet, olive, rose, steel, amber, green`.
- On the dashboard each card wears its story's color (a top rail + a chip), a **Story** filter in the
  toolbar narrows the board to one story, and the ticket editor has a **Story** field (pick, clear, or
  create one inline).

## List tickets

```bash
sidequest list                 # this project, grouped by column
sidequest list --status todo   # only one column
sidequest projects             # every board with open counts
```

Add `--json` to any of these when you want to read the data rather than show it.

## Update / move / close a ticket

Reference a ticket by its ref (`SQ-3`) or id:

```bash
sidequest update SQ-3 --status done                 # move across columns (todo|doing|done)
sidequest update SQ-3 -p urgent                      # change priority
sidequest update SQ-3 -t "New title" -d "New body"   # edit text
sidequest update SQ-3 -l bug -l regression           # replace labels
sidequest rm SQ-3                                     # delete
```

"Close", "mark done", "ship it", "resolve" → `--status done`. "Start", "in progress", "working on it"
→ `--status doing`.

## Work a ticket (safe with other agents)

The board may be shared — other Claude sessions, other tabs, or teammates can be working it too. So a
ticket must be **claimed** before you touch it, and claiming is **atomic**: two workers can never both
win the same ticket.

**Never start work on a ticket you haven't successfully claimed.** The claim is the check that it's
still there and still free — don't skip it just because you filed the ticket yourself a moment ago.

```bash
sidequest next --by <you>              # atomically claim the top-priority available ticket
sidequest claim SQ-3 --by <you>        # or claim a specific one
#   ... spawn the ticket's routed executor to do the work (default; see "Execute in a routed subagent") ...
sidequest done SQ-3 --by <you> --model <tier> --effort <level>   # mark done + stamp who/what worked it
sidequest release SQ-3 --by <you>      # or drop it unfinished (optionally --status todo)
```

- **`--by` must be genuinely unique to this session — never a short descriptive label.** A claim only
  fails when `held.by !== by`; re-claiming under the **same** `by` that already holds it is treated as
  the same worker resuming and silently succeeds. If two *independent* sessions both pick a generic
  label like `"claude"` or `"claude-orchestrator"`, the atomic-claim guarantee never trips — each
  session believes it alone owns the ticket, and you get two workers silently editing the same feature.
  Generate a random per-session token once (e.g. `claude-<8 random hex chars>`) and reuse *that exact
  string* for every claim/done/release in the session — don't hand-pick a plain name.
- **If a claim fails**, the CLI says why (`already claimed by X`, `already done`, `no longer exists`) and
  exits non-zero. **Do not work that ticket** — pick another, or stop. This is the whole safety
  guarantee: it never hurts if another agent grabbed it first — but only when identities don't collide.
- **Before a large fan-out** ("fix everything on the board"), run `sidequest list --status doing` first.
  Tickets already `doing` under a `--by` you don't recognize as your own subagents are a sign another
  session is already working the board — tell the user and confirm before also diving in, rather than
  silently duplicating their work.
- **Delegate by default.** After claiming, spawn the ticket's routed executor to do the work while you
  orchestrate; mark it `done` once it reports back. Doing it in the main thread instead is the exception
  (trivial changes only) — see "Execute in a routed subagent by default".
- **Stale claims** (a worker that crashed or wandered off) are reclaimable after a timeout
  (`SIDEQUEST_CLAIM_TTL_MIN`, default 60 min); `--force` overrides a live claim only when you're sure.

## Decompose for parallelism (lower the difficulty on purpose)

When you plan a story (see "Plan substantial work"), don't just split by topic — split so the pieces
are **small, file-disjoint, and cheap to execute**. The goal is twofold: pieces that can run **in
parallel without touching each other**, and pieces simple enough that the required tier **drops** —
one big scary ticket an opus must grind through becomes N precise tickets a sonnet (or lower) can
knock out simultaneously. The thinking stays at the top; the labor gets cheap and wide.

1. **Cut along file/module boundaries**, not conceptual ones. "CLI part", "dashboard part", "store
   part" parallelize; "first half / second half of the feature" doesn't.
2. **Declare each ticket's file scope** when filing: `sidequest add ... --file bin/cli.js --file lib/`
   (repeatable; a directory prefix covers everything under it). This is what makes independence
   *mechanical* instead of guesswork.
3. **Shrink until the complexity drops.** If a piece still scores 7+, it's usually two pieces — a
   small design/contract decision (high score) and a mechanical application of it (low score). The
   score is what routes each piece to the right tier, so shrinking scores is shrinking cost.
4. **Shape the story as: design → wave(s) → integrate.** A top-tier design/contract ticket blocks the
   wave; the parallel executor tickets form the wave(s); an integration/verify ticket depends on all
   of them. Encode that with `depends-on` links so `ready` naturally serializes the phases.

## Fan out over independent tickets (do this by default)

**Fan out at more than the ticket stage — but size it to the task.** This is the other half of running
subagent workflows: independent tickets worked at once, as teams of sub-agents, instead of grinding
through them one at a time. Parallelism isn't a one-time move reserved for independent tickets. Wherever
a stage has genuinely independent work, prefer concurrent
subagents over a long serial grind: a couple of read-only explorers mapping different parts of a
codebase, parallel reproductions of a bug across inputs, parallel verification of separate changes. The
instinct to catch is "I'm about to do a dozen sequential reads/edits that don't depend on each other" —
that's a fan-out. Stay proportional though: parallelism costs tokens and orchestration overhead, so
don't spawn a subagent for trivial, dependent, or same-file work. A bit of parallel investigation and
some parallel execution — not a swarm for everything.

**A substantive investigation belongs on a ticket, not in an ad-hoc agent.** A cheap read-only scout
(a couple of explorers building a quick map) is ephemeral — its output feeds your next decision and
that's fine. But when an investigation is real work whose *result matters later* — a root-cause hunt, a
spike, a "figure out how X works before we touch it" — file it as a **spike ticket** and let the
investigator claim it, dig, and **write its findings back as a detailed comment** (see "Comments &
questions"). Two parallel investigators become two spike tickets, each commenting what it found. The
result then lives on the board — inspectable, and readable by every other agent — instead of evaporating
with the orchestrator's context the moment the run ends.

When several tickets are **ready and independent**, **work them in parallel** — do not grind through
them one at a time. This is safe precisely because claiming is atomic: each subagent claims a different
ticket, and any race just sends the loser to the next one.

A ticket is **ready** when it's not done, not archived, not already claimed, and **not blocked** by an
unfinished ticket (`sidequest ready` lists exactly this set). `ready` also groups the set into
**parallel-safe waves** by declared file scope — no two tickets in a wave overlap — so fan out **one
wave at a time**: spawn one executor per ticket in wave 1, wait for the wave, re-run `ready`, repeat.
Tickets with **no declared scope** never mechanically conflict, so for those the old rule still
applies: eyeball whether they'd edit the same files before parallelizing them.

**How to fan out:**

1. `sidequest list --status doing` — if tickets are already `doing` under a `--by` you don't recognize,
   another session may be actively working this board; flag it to the user before proceeding.
2. `sidequest ready --json` to see the fan-out-able set.
3. Spawn **one subagent per ticket**, in a single batch (parallel), each told to:
   `sidequest claim <ref> --by <unique-id>` → if the claim succeeds, do the work, then
   `sidequest done <ref> --by <same-id> --model <its tier> --effort <its effort>` (stamp who/what
   worked it); if it fails, stop (someone else has it).
   Give each a **genuinely random, session-scoped `--by`** — not just the ticket ref or a fixed label,
   since a second independent session fanning out over the same board would derive the identical value
   and silently coexist as the same worker (see the note on identity collisions above).
4. When a batch finishes, the dependents it unblocked become ready — fan out over the next wave.

**Keep sequential** (don't parallelize) tickets that **depend on each other** or that **touch the same
files** — parallel edits to one file collide. Link such tickets with `depends-on` so `ready`/`next`
naturally serialize them. For a large fan-out you may use a subagent workflow; otherwise a batch of
background subagents is enough.

## Execute in a routed subagent by default (~95% of the time)

The main thread is a single fixed model. sidequest scores every ticket and routes it to the **best
model×effort tier for that specific task** — so the moment you execute a ticket in the main thread, you
throw that routing away: you run laborer work at orchestrator prices, or an underpowered model on
something hard. Don't.

**Default: the main thread orchestrates, a routed subagent executes.** In practice, this is what running
subagent workflows looks like: the main thread stays the orchestrator, and the tickets it spawns out
become teams of sub-agents doing the actual labor. Plan and score on the board, then for each ticket
spawn its executor (`sidequest-exec-<effort>` at the ticket's derived model) to claim → do → verify →
done. Keep ~95% of real execution in routed subagents; the main thread's job is decompose, score, spawn,
and integrate.

**The ~5% you still do yourself:** genuinely trivial one-step changes (complexity 1–2) where spawning
costs more than the work, plus the orchestration itself. "It's easier to just do it here" is exactly the
reflex this rule exists to catch.

This is a **separate reason from parallelism**. Even a single, serial ticket belongs in a routed
subagent — routing is about running each task on the *right* model, not only about running many at once.

## Complexity-driven routing (ENFORCED)

You never pick a model or effort directly. **You score the task's COMPLEXITY (1–10) with a mandatory
motivation, and sidequest derives which tier works it and how hard it thinks** — by mapping the score
onto **one capability-ranked ladder** of model×effort rungs built from the tiers the user enabled in
the model picker. The ladder is a single merged sequence, not per-tier bands: tiers overlap and cross
over (`sonnet·xhigh` outranks `opus·low` — capability orders the rungs, not tier), and adjacent scores
may share a rung. **Max effort is held out of the normal spread**: only complexity 10 on the top
enabled tier gets `·max` (and 9 only at bias +5) — deliberately rare, per Anthropic's "use max
sparingly for the hardest tasks." The derivation is live: toggling a tier instantly re-routes every
open ticket. `sidequest models` prints the current ladder.

**Bias is the user's dial, not yours.** You always score complexity honestly against the absolute
anchored scale below — bias tunes only HOW eagerly those scores escalate to pricier rungs, never what
you score. The user sets it with `sidequest bias <n>` (or the dashboard slider): `-5` Frugal … `0`
neutral (default) … `+5` Generous, gamma-curving the score→rung map. Extremes stay invariant:
complexity 1 always hits the cheapest rung and 10 the top rung at any bias.

**Every ticket MUST be filed with `--complexity 1-10` AND `--why "<motivation>"` — sidequest errors
without them, and `--model`/`--effort` are rejected as direct inputs.** The motivation must reference
the actual work (files, moving parts, unknowns), not restate the number — writing it is what forces
you to look at the task properly. The scale is **absolute** — anchored to concrete reference points,
not to "hard for me right now":

- **1** — trivial: summarizing a README, a one-line lookup, skimming logs for a fact.
- **2–3** — routine: a single-file edit or script, a rename, a dedup, a config bump.
- **4–5** — everyday build: one area, a known pattern, a few edge cases; **~5 anchors to simple HTML
  work** — a static page, a form, a plain component.
- **6–7** — hard: a multi-file feature or cross-cutting refactor — several coordinated edits, a
  contract multiple consumers must respect, real edge cases.
- **8** — gnarly: novel debugging with an unknown root cause, or designing an algorithm/architecture
  under real constraints.
- **9–10** — frontier: developing new AI models, RL training, research-grade problems with no
  established solution. **10 is the extreme end**, not "a hard day."

Normal day-to-day coding legitimately lands **1–7**. Scores of **9–10 firing rarely is intended** —
the top rung (·max effort) is reserved for genuinely extreme work, same spirit as Anthropic's own
guidance to use max effort "sparingly for the hardest tasks." If you're unsure, score lower.

```bash
sidequest add -t "Apply the codemod" --complexity 2 --why "single mechanical transform over bin/cli.js, verified by node -c"
sidequest add -t "Design the migration" --complexity 8 --why "reshapes the store contract; every consumer (CLI, server, dashboard) must stay compatible mid-rollout"
sidequest update SQ-8 --complexity 5 --why "wider than scored: it also rewires the reader path"   # rescore needs a fresh why
sidequest models        # the live ladder: which score routes to which tier·effort right now
```

**Rules for working the board — the same register as "never work a ticket you haven't claimed":**

0. **Routing master switch first.** `sidequest models --json` → if `routing` is `false` the rules
   below stand down: work any ticket yourself; derived tags are informational.
1. **Route, don't self-execute — ~95% of the time.** Every non-trivial ticket runs in an executor
   subagent, not the main thread: you cannot change your own model mid-run, so the spawn is the only way
   each task lands on the model×effort scored for it. This holds even for a single serial ticket and even
   when the derived tier equals yours (it still isolates context and composes the effort level). Only
   genuinely trivial one-step changes stay in the main thread. Decompose, score, fan out; don't quietly
   do laborer work at orchestrator prices.
2. **The ticket's derived `model`/`effort` ARE the routing** — they come stamped on every read
   (`list`/`ready --json`), already shaped by the user's allowlist, so there is nothing to re-derive.
   Cap at your own tier if the ladder tops out above you (`fable > opus > sonnet > haiku`), and only
   spawn models that actually exist in your environment.
3. **Map effort via the bundled executors:** spawn `subagent_type: sidequest-exec-<derived effort>`
   **with** `model: <derived tier>` (effort lives in the agent definition, model in the spawn — they
   compose). A haiku-derived ticket has no effort: use a plain agent with `model: haiku`.
   **`<derived effort>` is the ticket's stamped `effort` verbatim, never a level you judge fits better** —
   picking a different one (a disabled rung, or just hotter/cooler than stamped) is drift, and the executor
   now guards against it: it claims with `--effort <its baked level>`, and the board REFUSES the claim if
   that doesn't match the derived effort, bouncing the ticket back for the correct-tier agent.
4. **Claim by tier:** `next --model X` / `ready --model X` hand out only tickets whose derived tier
   is X — an executor never grabs work priced for another tier.

**Decision procedure:** routing on? → read the ticket's derived `model`/`effort` → cap at your tier →
spawn `sidequest-exec-<effort>` (or plain agent for haiku) with `model: <tier>` → executor claims →
works → verifies → dones.

*Worked example:* main session = fable, haiku disabled; ticket `SQ-12 ⚙C3→sonnet·max`.
`Agent(subagent_type: "sidequest-exec-max", model: "sonnet", prompt: claim SQ-12 → fix → verify →
done)`. The user re-enables haiku later → the same open ticket re-reads as `C3→sonnet·low` or lower —
always spawn from the freshest read.

A ticket shows `⚙C<score>→tier·effort` on its card and in `list`/`ready`; the user shapes the ladder
in the dashboard settings (gear → Available models), where the live mapping is displayed.
Effort exclusion is per model, not global — a model×effort grid, so opus·medium can be off while
sonnet·medium stays on. An excluded model×effort pair never appears in the derived ladder for that
model.

## Comments & questions

Every ticket has a comment thread. Post one with `sidequest comment` or `sidequest ask` — the two
have **different follow-up behavior**, so pick deliberately:

```bash
sidequest comment SQ-3 -m "Reused the SQ-1 fixtures here."   # a note-to-self: keep working, no pause
sidequest ask     SQ-3 -m "Cover the v2 API too?"            # addressed to the user: needs a reply
sidequest comments SQ-3                                       # read the thread
```

- **Write your findings back as a comment after any investigation or substantive change.** The report
  you hand back to the orchestrator is ephemeral — it dies with that context. The durable, shareable
  record is a ticket comment: what you examined, what you found, the **root cause with evidence**
  (`file:line`), what you **ruled out**, and the fix or recommended next step. An investigation whose
  result never got commented has to be redone by the next agent — so for a spike or a root-cause hunt,
  the comment is the actual deliverable, not an afterthought.
- **Read the thread before you work a ticket** (`sidequest comments <ref>`), and skim any linked or
  related tickets' threads too. A prior or parallel agent may have already mapped the code, hit the dead
  ends, or left the exact context you need — reading it first is far cheaper than rediscovering it.
- **A plain `comment`** is a log entry for continuity (progress note, decision record, a thought for
  later). It never blocks anything — post it and keep going.
- **An `ask`** (or `comment --kind question`) is addressed to the user and means you need their
  input before continuing. **`ask` only posts the question — it does not itself pause.** Follow it
  with `sidequest await`:

  ```bash
  sidequest await SQ-3                          # blocks up to 120s (poll every 5s) for a reply
  sidequest await SQ-3 --timeout 900 --poll 10  # a longer wait, polling less often
  ```

  `await` exits `0` with the new reply text once the user answers (through the dashboard), or exits
  `1` on timeout if they haven't yet. **Do not just continue past your own question as if it were
  answered.** On timeout, either `await` again (loop it, or use a longer `--timeout`) or tell the
  user you're blocked on their reply and stop — don't guess and proceed. An ordinary follow-up
  `comment` you leave yourself in between (e.g. a progress note) does not count as an answer; only
  the user's own reply clears it.
- Check `sidequest list` or `sidequest comments <ref>` for a "❓ awaiting reply" marker — that flags a
  question of yours still unanswered, including ones asked earlier in a different session.
- Comment bodies render full markdown, same as descriptions — reach for it when it aids scanning (a
  ticket ref, a file path, a command, a short code block), not as a rule to follow everywhere. Use
  real newlines for anything multi-line, never a literal `\n`.

## Assign a ticket to the human

Separate from an agent **claim** (atomic, TTL-bound, gates `ready`/`next`), a ticket can also carry a
persistent **assignee** — normally the human user. Use this when the user says "assign this to me" or
wants to track who owns a ticket, not who's actively working it:

```bash
sidequest assign SQ-3               # assign to "you" (the default human identity)
sidequest assign SQ-3 --to Kenny    # or a specific name
sidequest unassign SQ-3             # clear it
```

The dashboard shows an assignee chip on each card and has a filter (Everyone / Mine / Agents /
Unassigned) in the board toolbar — "Agents" means a live claim (or a non-"you" assignee), "Unassigned"
means neither. Assignment never expires and never blocks `claim`/`ready`/`next` — an agent can still
claim and work a ticket that's assigned to the human.

## Notifications & reminders

The dashboard has an in-app notification inbox (the bell icon, top-right), backed by a persistent
server-side queue:

- **Background events** — Claude/CLI creating, moving, commenting on, or asking a question about a
  ticket enqueues a notification automatically (subject to per-kind opt-in/out in the settings
  popover). These show up in the bell inbox with an unread badge, even if the dashboard tab was closed
  when the event happened. Nothing to do here — this is automatic. The inbox splits them into
  **Needs you** (questions + reminders) and **Activity** (new tickets, moves, comments) so a question
  never gets buried; a question also turns the bell badge red.
- **Per-project mute.** A whole board's notifications can be turned off from the dashboard's settings
  popover (on by default). A muted board queues **nothing** — no questions, comments, or status —
  regardless of the per-kind settings, and its rail row shows a muted-bell mark. Useful to silence a
  noisy background project without losing notifications everywhere.
- **Reminders** — a time-based nudge on a ticket that later fires into the same inbox. Set one with the
  CLI:

  ```bash
  sidequest remind SQ-3 --in 1h              # presets: 1h | 3h | tomorrow (9am)
  sidequest remind SQ-3 --at "2026-07-05T09:00"   # or a specific date/time
  sidequest unremind SQ-3                    # cancel a pending one
  ```

  (The dashboard's ticket editor offers the same presets as a "Remind me" control, plus a cancellable
  chip, for the human doing it by hand.) The reminder fires into the live queue once its time passes —
  the running dashboard server (`sidequest dashboard`/`serve`) needs to be up for the fire to be
  noticed promptly, and it survives a server restart (one due while the server was down shows up on
  the next tick after it's back).
- Desktop toasts are a separate, independent opt-in (toggle in the settings popover, next to the bell) —
  they fire alongside the same events but aren't required for the inbox itself to work.

Use `remind` when the user says "remind me about this in an hour" / "ping me on this tomorrow" on a
specific ticket — don't just leave a comment for that, since a comment doesn't fire anything at a later
time.

## Link tickets

Relate tickets so the order of work is explicit — a link is stored on both tickets, so set it once
from either side:

```bash
sidequest link SQ-4 depends-on SQ-3   # SQ-4 is blocked-by SQ-3 (and SQ-3 blocks SQ-4)
sidequest link SQ-1 blocks SQ-2       # the other direction
sidequest link SQ-5 related SQ-6      # a non-blocking association
sidequest unlink SQ-4 SQ-3            # remove it
```

A ticket that's `blocked-by` an unfinished one is skipped by `sidequest next` and shown as blocked in
`sidequest list`, so an agent grabbing top-priority work never picks up something that isn't ready yet.

## Guidelines

- **Filing a ticket is not a request to work it.** "Make a ticket for X" / "add a bug for Y" means file
  it and stop — don't claim or start solving it unless the user separately asks you to work the board
  (or explicitly asks for both in the same breath, e.g. "file it and fix it now"). This applies doubly
  to the `ticket-filer` subagent, which never touches code by design, but also to you: a freshly created
  ticket sitting in `todo` is not an invitation to immediately `claim`/`next` it.
- **Act, then report.** Run the command and tell the user the result (the ref, the new status, or the
  URL). Don't ask which board unless it's genuinely ambiguous — default to the current project.
- **Keep titles tight and concrete.** One line; put detail in `-d`.
- **The dashboard is live.** It polls, so tickets you add from the CLI appear on an open board within a
  couple of seconds — no refresh needed. New arrivals animate in.
- **Don't invent tickets.** Only file what the user actually raised.
