# sidequest

**A Trello-light quest log for Claude Code.** The stray issues you mention while Claude is busy with
something else — *"oh, and the contact form doesn't send"* — get captured as **tickets** on the spot,
with any image you pasted attached, and land on a **live, self-hosted Kanban dashboard** that spans
every project you work in.

You stay on your main quest; the side quests get written down.

![The sidequest dashboard showing one board across every project](docs/board.png)

*One live board across every project you work in. It's completely local: the server binds to `127.0.0.1`, nothing phones home, and there's no hosted version. Free and MIT.*

## Install

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install sidequest@eigenwise-toolshed
```

Then run `/reload-plugins` (or restart Claude Code). No dependencies, no build step — it's Node stdlib
only (Claude Code already ships Node), cross-platform.

## The idea

You're deep in a CSS fix. You say *"oh and the checkout throws on Safari."* Normally that either
derails the current task or gets forgotten three messages later. sidequest does neither:

1. A **hook** notices the side issue and, without interrupting the work in progress, nudges Claude to
   capture it.
2. Claude spins off a tiny background **`ticket-filer`** subagent that writes the ticket — title,
   description, priority, labels, and any **pasted image** — while the main task keeps moving.
3. The ticket appears on your **board**. Ask *"show me the dashboard"* and it opens in your browser,
   live-updating as new tickets land.

Nothing leaves your machine. The board server binds to `127.0.0.1` only.

## Capturing side issues

The bundled `UserPromptSubmit` hook watches for a message that raises something separate from the task
at hand — interjections (*"also…", "by the way…", "don't forget…"*), defect language (*"broken",
"doesn't work", "throws"*), or a pasted image — and reminds Claude to file it as a ticket **and keep
going**. The decision to file stays with Claude, so an ordinary on-task prompt creates no ticket.

- **Pasted images become attachments.** Paste a screenshot with your message and it's copied into the
  ticket; you'll see the thumbnail on the card and full-size in the board's lightbox.
- **It doesn't derail the current task.** Capture happens on a background subagent (or a single quick
  CLI call), then Claude continues what it was doing.
- **A quiet standing reminder.** On other prompts the hook injects one short line keeping Claude aware
  that this project uses sidequest, so it reaches for the board instead of forgetting the system exists.
  Find it too chatty? Set `SIDEQUEST_NUDGE=off` — the capture and board blocks above still fire on a
  match.

You can also just ask directly: *"make a ticket for the flaky signup test, high priority."*

## The dashboard

Ask *"show me the dashboard"*, *"open the board"*, or run **`/sidequest:board`**. Claude starts the
local server (idempotently — it reuses one that's already running) and opens your browser.

- **Live.** The board polls every ~2.5s, so tickets added from anywhere (the CLI, the capture hook,
  another window) show up on their own and animate in — no refresh. It only re-renders when something
  actually changed, pauses polling while its browser tab is in the background, and refreshes instantly
  the moment you switch back to it.
- **Every project at once.** The left rail is a switcher across all your boards, plus an **All boards**
  view. Because tickets are stored centrally (not inside each repo), one dashboard covers every folder
  you work in simultaneously.
- **Manage by hand.** Drag cards between **To do / Doing / Done**, click a card to edit title,
  description, priority, labels, and images, paste or drop new screenshots, or delete it. Filter by
  priority and search across everything.

It's a self-contained page — no CDN, no fonts, no network calls beyond its own local API.

![A ticket detail modal with priority, status, complexity score, files, and comments](docs/ticket.png)

*Click any card to open the ticket: priority, status, assignee, story, a complexity score with its derived model tier, files, comments, reminders, and links.*

### Notifications and the bell inbox

When **Claude** changes the board while you're working elsewhere, sidequest tells you — but it never
nags you about your own edits. Notifications live in a small **persistent queue on the server**, not
just in the open tab, so they survive a reload and pile up even while no dashboard is open.

- **The bell is an inbox.** Click it to open a readable list of what happened — questions, comments,
  new tickets, status changes — newest first, each linking straight to its ticket. It's split into
  **Needs you** (questions Claude is waiting on + your reminders) and **Activity** (new tickets, moves,
  comments) so a question never gets buried in routine noise. A gold badge on the bell shows the unread
  count — it turns **red** when any unread is a question waiting on your reply; click a notification (or
  **mark all read**) to clear it.
- **Sidebar unread badge.** Each project also shows a small gold badge counting the tickets Claude
  created or moved between columns since you last opened that board. Open the board and the badge
  clears. Changes *you* make in the dashboard (in any tab) never raise a badge or an inbox entry.
- **Desktop notification.** Toggle this from the **gear** menu ("Desktop notifications") — when Claude
  does something in the background and you're not looking at the dashboard, you get a native toast on
  top of the inbox entry. Click it to jump straight to that board.
- **Choose what pings you.** The gear menu lets you pick which events notify (and queue): **questions**,
  **comments**, **new tickets**, **status changes** — each a toggle, honored server-side so an opted-out
  kind never queues even with no tab open. A question from Claude is the one you'll usually want on,
  since it means Claude is waiting on your answer.
- **Mute a whole project.** The gear menu also has a per-project switch — turn a board off and it queues
  **nothing**, of any kind, regardless of the toggles above; its row in the sidebar shows a muted-bell
  mark. Handy for a chatty background project you don't want pinging you while you focus elsewhere.

The distinction is by origin: a change made through the dashboard is *you*; a change made by the CLI or
a subagent is *Claude*. Only the latter notifies, badges, or queues. (While a board's tab is fully
backgrounded, the browser throttles its timers, so a desktop toast can lag a little; the inbox itself
doesn't need the tab open at all.)

## User stories

Bigger than a single ticket? Group the pieces under a **user story**. Every ticket in a story is
**color-coded** to it on the board, so a multi-part feature reads as one arc instead of scattered cards.
Claude decides on its own whether an incoming request is a standalone ticket or a story-with-tickets
(and files it accordingly) — you can also drive it by hand.

```bash
sidequest story add -t "Checkout revamp" --color teal    # prints its US-n ref
sidequest add -t "Cart totals wrong" --story US-1 --complexity 3 --why "..."   # file a ticket straight into the story
sidequest update SQ-7 --story US-1                       # or move an existing ticket in (--story none clears)
sidequest story list                                     # stories with their color + ticket count
sidequest story show US-1                                # the story and every ticket in it
```

A distinct color is auto-assigned per story; override it with a hex (`#7a5ba8`) or a name
(`terracotta, teal, violet, olive, rose, steel, amber, green`). On the dashboard each card wears its
story's color as a top rail and a chip, a **Story** filter in the toolbar narrows the board to one
story, and the ticket editor has a **Story** field to pick, clear, or create a story inline. Deleting a
story keeps its tickets — they're just detached.

## Complexity-driven routing

Agents don't pick models — they **score the task**. Every ticket is filed with a **complexity score
(1–10)** and a **mandatory motivation** for it (writing the why is what forces an honest look at the
task), and sidequest **derives** which model tier works the ticket and at what reasoning effort from
that score. Routing is **one capability-ranked ladder** of model×effort rungs — not per-tier bands —
so tiers overlap and cross over (`sonnet·xhigh` outranks `opus·low`; capability, not tier, orders the
rungs). Its philosophy is still **exhaust effort before escalating tier**, since thinking harder on a
cheap model costs less than renting a bigger one.

```bash
sidequest add -t "Apply the codemod" --complexity 2 --why "single mechanical transform, node -c verifies"
sidequest add -t "Design the migration" --complexity 8 --why "reshapes the store contract; all three consumers must stay compatible"
sidequest update SQ-8 --complexity 5 --why "wider than scored: it also rewires the reader"   # rescoring needs a fresh why
sidequest models   # the live ladder: which score routes where right now
```

![The routing ladder mapping each complexity score to a model and effort rung](docs/routing-ladder.png)

*The live ladder. Every complexity score maps to a model and a reasoning-effort rung; max is held back for only the very top of the scale.*

Complexity 1..10 maps onto that rung sequence, so adjacent scores may share a rung. **Max effort is
held out of the normal spread** — only complexity 10 on the top enabled tier gets `·max` (and 9 too,
only at the most generous bias); it's deliberately rare, in the spirit of Anthropic's "use max
sparingly for the hardest tasks." **It scales dynamically**: derivation happens at read time, so
toggling a tier in the gear menu's *Available models* instantly re-routes every open ticket — disable
fable and your C9s drop onto the next rung down, no migration. Cards show a `⚙C7→opus·high` chip;
`ready`/`next --model <tier>` filter by the *derived* tier, so an executor never grabs work priced for
another tier. Direct `--model`/`--effort` tagging is rejected.

**Bias slider.** Agents score complexity honestly against the absolute anchored scale; *you* tune how
eagerly those scores climb the ladder with a bias dial (`sidequest bias <n>`, or the dashboard
slider): `-5` Frugal … `0` neutral (default) … `+5` Generous. It gamma-curves the score→rung mapping —
0 keeps the standard curve, higher biases escalate to pricier rungs sooner — but the extremes are
invariant: complexity 1 always lands the cheapest rung and 10 the top rung at any bias.

sidequest doesn't *force* a model (nothing can make a running model swap itself mid-task); the bundled
skill enforces the flow on Claude: derived routing is honored via bundled executor agents
(`sidequest-exec-low` … `-max`) spawned with the derived tier — effort lives in the agent definition,
model in the spawn, so the two compose. (Haiku has no effort support; haiku-derived work uses a plain
agent.) Those five files are generated from one source, `agents/_exec-template.md`, since the Agent
tool can only pin per-spawn reasoning effort via a definition's `effort:` frontmatter (unlike `model`,
which is a spawn-time argument) — run `node plugins/sidequest/scripts/gen-exec-agents.js` to
regenerate them after editing the template, rather than hand-editing the five copies. The same
*Available models* section has a master switch to turn routing off entirely — then
Claude may work any ticket itself and the chips become purely informational. Effort exclusion lives
in that same section too, but it's per model, not global: a model×effort grid lets you turn off, say,
opus·medium while sonnet·medium stays on, and that pair just drops out of opus's rungs. The guards:
at least one tier always stays enabled, and each enabled tier's row always keeps at least one effort on.

## File scopes & parallel waves

Declare which files a ticket will touch and the board can tell you **what's safe to run in parallel** —
mechanically, instead of hoping two agents don't collide.

```bash
sidequest add -t "CLI part" --file bin/cli.js --file README.md --complexity 3 --why "..."   # --file repeatable; dir prefixes cover subtrees
sidequest update SQ-7 --file none                                # clear the scope
sidequest ready                                                  # groups the ready set into waves
```

`ready` partitions unclaimed, unblocked tickets into **waves**: within a wave no two tickets' scopes
overlap (a path conflicts with an equal path or a directory prefix of it), so Claude fans out one
executor per ticket, one wave at a time. Tickets without a declared scope never mechanically conflict —
Claude falls back to judgment for those. Cards show a small 📁 count, and the ticket editor has a
comma-separated **Files** field.

This pairs with model/effort routing into a planning doctrine the skill teaches: **cut work along file
boundaries, shrink pieces until a cheaper tier can execute them, and shape stories as design → parallel
wave(s) → integrate** — the thinking stays on the top model, the labor gets cheap and wide.

## Reminders

Set a time-based nudge on any ticket — it fires into the bell inbox later, even if you've closed the
tab (as long as the dashboard server is running).

```bash
sidequest remind SQ-3 --in 1h                    # presets: 1h | 3h | tomorrow (9am)
sidequest remind SQ-3 --at "2026-07-05T09:00"    # or a specific date/time
sidequest unremind SQ-3                          # cancel a pending one
```

On the dashboard, a ticket's editor has the same presets plus a custom datetime picker, and a
cancellable "🔔 in 1h" chip shows on the card and in the modal while one's pending. A reminder due
while the server was down fires on the very next tick after it's back up — nothing is lost.

## Assigning tickets

Separate from a **claim** (atomic, expires, gates `next`/`ready`), a ticket can also carry a persistent
**assignee** — normally you, the human, tracking who owns it rather than who's actively working it.

```bash
sidequest assign SQ-3               # assign to "you"
sidequest assign SQ-3 --to Kenny    # or a specific name
sidequest unassign SQ-3             # clear it
```

The dashboard has an assignee chip on each card and a filter in the toolbar (**Everyone** / **Mine** /
**Agents** / **Unassigned**) — "Agents" means a live claim (or a non-"you" assignee), "Unassigned" means
neither. Assignment never expires and never blocks an agent from claiming and working an assigned
ticket.

## Multiple projects

Run Claude in `~/work/shop` and `~/work/api` at the same time and each gets its own board,
automatically, keyed by the folder's absolute path. The single dashboard shows both (and any others),
so you never juggle windows. Nothing is written into your repos.

## Managing tickets from chat

Ask in plain language and the `sidequest` skill maps it to the CLI:

| You say | What happens |
|---|---|
| "show me the board" / `/sidequest:board` | Opens the live dashboard in your browser |
| "make a ticket for X, high priority, label bug" | Creates a ticket on the current board |
| "list my tickets" / "what's open" | Lists tickets, grouped by column |
| "close SQ-3" / "mark SQ-3 done" | Moves SQ-3 to **Done** |
| "move SQ-2 to doing" | Moves SQ-2 to **Doing** |
| "bump SQ-5 to urgent" | Changes priority |
| "delete SQ-4" | Removes the ticket |

## Working the board (safe with multiple agents)

sidequest isn't just a place to *record* work — Claude (or several agents at once) can **work** it. The
board may be shared across sessions, browser tabs, or teammates, so a ticket must be **claimed** before
anyone touches it, and claiming is **atomic**: two workers can never both win the same ticket.

Because tickets get *executed* by agents (often smaller ones), the skill holds descriptions to a
**developer-to-developer standard**: exact files and functions, the behavioral contract, bounds, and
how to verify — never a manager's one-liner. The further down the tier ladder a ticket routes, the more
complete its spec has to be; precision substitutes for model capability.

```bash
sidequest next --by <you>          # atomically claim the top-priority available ticket
sidequest claim SQ-3 --by <you>    # or claim a specific one
sidequest done SQ-3 --by <you>     # finished: mark done + release the claim
sidequest release SQ-3 --by <you>  # drop it unfinished (optionally --status todo)
```

- **Claim before work, always.** The claim is the atomic check that the ticket is *still there and still
  free*. If it fails — already claimed by someone else, already done, or deleted — the CLI says so and
  exits non-zero, and you just don't work it. That's the whole guarantee: **it never hurts if another
  agent picked it up first.** You never re-do their work, even for a ticket you filed yourself moments
  ago.
- **`--by`** is your worker id (a session id or a short label); use a stable one so you can finish what
  you claimed. Concurrent workers must use distinct ids.
- **Delegate small tickets.** Once you've claimed a ticket, you can spawn a subagent to do the actual
  work while you orchestrate, then mark it `done` when it reports back.
- **Crash-safe.** A claim left by a worker that crashed or wandered off becomes reclaimable after a
  timeout (`SIDEQUEST_CLAIM_TTL_MIN`, default 60 min). On the dashboard, a claimed ticket shows a green
  "working" chip with the worker's id (muted once the claim goes stale).

## Fan out over independent tickets

Because claiming is atomic, Claude doesn't have to work a backlog one ticket at a time — when several
tickets are **ready and independent**, it works them **in parallel**, one subagent per ticket.

![Claude filing tickets then launching three parallel executor agents by tier](docs/fan-out.png)

*Claude scores a batch of tickets, notices two of them touch the same file so they can't run together, and fans the rest out as parallel executors, each on the model tier its complexity earned.*

```bash
sidequest ready [--json]   # the fan-out set: unclaimed, unblocked, not done, not archived
```

Each subagent `claim`s a different ticket (distinct `--by`) → does the work → `done`; if a claim loses
a race it just moves on, so two agents never collide. Only **independent** tickets are parallelized —
anything that shares files or has a `depends-on` link stays sequential (blocked tickets aren't even in
`ready`). The bundled hook and skill make this the default behavior, not an afterthought.

## Comments & questions

Every ticket has a comment thread. Claude leaves a **comment** as a note-to-self, or a **question**
when it needs your input — and a question is the signal to *pause and wait for your reply*, not guess.

```bash
sidequest comment SQ-3 -m "Reusing the SQ-1 examples here."          # a note
sidequest ask     SQ-3 -m "Should this cover the v2 API too?"        # a question (pauses; waits for you)
sidequest comments SQ-3                                              # show the thread
```

On the dashboard, open a ticket to read the thread and reply; a ticket whose latest comment is an
unanswered question shows a gold **❓ needs reply** chip on its card. A question from Claude notifies you
(see below) so you can answer without watching the board.

## Links & dependencies

Relate tickets so the order of work is explicit. Links are stored on both tickets — set one side and
the inverse is written automatically.

```bash
sidequest link SQ-4 depends-on SQ-3     # SQ-4 is blocked-by SQ-3 (and SQ-3 blocks SQ-4)
sidequest link SQ-1 blocks SQ-2         # the other direction
sidequest link SQ-5 related SQ-6        # a non-blocking association
sidequest unlink SQ-4 SQ-3              # remove it
```

A ticket that is **blocked by an unfinished ticket** is shown as **⛔ blocked** and is **skipped by
`next`/`ready`** — an agent grabbing the top task never picks up work that isn't ready. Once the blocker
is `done`, it unblocks automatically. On the dashboard, links (and an unlink ✕) live in the ticket detail.

## Archive

Finished work piles up in **Done**. Archive it to tuck it away — kept and fully restorable, just out of
the board's way (hidden from the columns, the counts, `next`, and `ready`).

```bash
sidequest archive --done       # archive every done ticket (the usual "clear out Done")
sidequest archive SQ-3         # archive one
sidequest unarchive SQ-3       # restore it
sidequest list --archived      # see what's archived
```

On the dashboard, the **Done** column header has an **Archive all** button, each ticket has an
**Archive** action in its detail, and a quiet **Archive** entry at the bottom of the sidebar opens a
separate, list-style archive view (with **Restore** on every row) — deliberately plain and off to the
side, so it never competes with the live board.

## CLI

Every action is a thin wrapper over one script, usable directly too:

```bash
node <plugin>/bin/sidequest.js add -t "Title" -d "Details" -p high -l bug -l ui -i /path/to/shot.png --complexity 4 --why "..."
node <plugin>/bin/sidequest.js list [--status todo|doing|done] [--json]
node <plugin>/bin/sidequest.js update SQ-3 --status done      # -t -d -p -s -l -i  ·  --story US-1|none
node <plugin>/bin/sidequest.js rm SQ-3
node <plugin>/bin/sidequest.js story add -t "Epic" [--color teal]   # group tickets; file into it with --story US-n
node <plugin>/bin/sidequest.js story list|show US-1|update US-1|rm US-1
node <plugin>/bin/sidequest.js add -t "Task" --complexity 5 --why "..."   # score 1-10 + motivation — BOTH required; routing derived
node <plugin>/bin/sidequest.js models                               # the live complexity -> tier·effort ladder
node <plugin>/bin/sidequest.js next --model sonnet --by <you>       # claim only work whose DERIVED tier is sonnet
node <plugin>/bin/sidequest.js models [--json]                      # the tiers you allow + each tier's enabled efforts
node <plugin>/bin/sidequest.js ready [--json]                 # the fan-out set (unclaimed, unblocked)
node <plugin>/bin/sidequest.js claim SQ-3 --by <you>          # take a ticket to work (atomic; --force to steal)
node <plugin>/bin/sidequest.js next --by <you>                # claim the top-priority available ticket
node <plugin>/bin/sidequest.js done SQ-3 --by <you>           # finish + release  (release = drop unfinished)
node <plugin>/bin/sidequest.js link SQ-4 depends-on SQ-3      # dependencies (blocks | depends-on | related)
node <plugin>/bin/sidequest.js comment SQ-3 -m "note"         # ask = question (pause + await the reply)
node <plugin>/bin/sidequest.js archive --done                # tuck away all done  ·  unarchive <ref> restores
node <plugin>/bin/sidequest.js assign SQ-3 [--to who=you]     # persistent owner  ·  unassign SQ-3 clears it
node <plugin>/bin/sidequest.js remind SQ-3 --in 1h            # or --at "<date/time>"  ·  unremind SQ-3 cancels
node <plugin>/bin/sidequest.js projects [--json]
node <plugin>/bin/sidequest.js dashboard [--port N] [--no-open]
node <plugin>/bin/sidequest.js serve [--port N]               # run the server in the foreground
node <plugin>/bin/sidequest.js stop                           # stop the running server
```

The target board defaults to `$CLAUDE_PROJECT_DIR` (or the current directory); pass
`--project <path-or-slug>` to point elsewhere.

## Where things live

Tickets and images are stored centrally, so they never clutter a repo and one dashboard can aggregate
them:

```
~/.claude/sidequest/
  server.json                     # the running dashboard's port + pid
  projects/
    <folder>-<hash>/
      meta.json                   # project path, name, ticket + story counters, notify switch
      tickets/<id>.json           # one file per ticket
      stories/<id>.json           # one file per user story
      assets/<id>/<image>         # attached screenshots
```

Each ticket gets a short human ref (`SQ-1`, `SQ-2`, …) and each story a `US-1`, `US-2`, … per project.

### Configuration

Two optional environment variables (set them in `.claude/settings.json` under `env`, or your shell):

| Variable | Default | Purpose |
|---|---|---|
| `SIDEQUEST_HOME` | `~/.claude/sidequest` | Where the central store lives. Point several machines at a synced folder to share boards. |
| `SIDEQUEST_PORT` | `41730` | Preferred dashboard port. If taken, the next free port is used. |
| `SIDEQUEST_CLAIM_TTL_MIN` | `60` | Minutes before an unrefreshed claim is treated as stale and another worker may take it over. |
| `SIDEQUEST_NUDGE` | `on` | Set to `off` to silence the small per-prompt "use sidequest" reminder (the marker-triggered capture and board blocks still fire). |

## Troubleshooting

- **The board didn't open.** The launcher prints the URL — open it manually. Check the server is up
  with `node <plugin>/bin/sidequest.js projects` (it prints the board URL when the server is running),
  or restart it with `stop` then `dashboard`.
- **A ticket didn't get filed.** The hook only *nudges*; Claude decides. If it was mid-task and busy,
  just say "file that as a ticket". Nothing is ever auto-created for an on-task prompt.
- **Wrong board.** Tickets go to `$CLAUDE_PROJECT_DIR`. If you started Claude from a different folder
  than you expected, pass `--project` or move the ticket on the dashboard.
- **Port already in use.** sidequest picks the next free port automatically and records it in
  `server.json`; the dashboard command always opens the right one.
- **It's safe by design.** The hook fails soft — any error produces no output and never blocks a
  prompt. The server is local-only (`127.0.0.1`).

## Clean up

- Tickets for one project: delete its folder under `~/.claude/sidequest/projects/`.
- Everything: delete `~/.claude/sidequest/` (stop the server first with `… stop`).
- Plugin: `/plugin uninstall sidequest@eigenwise-toolshed`.

## License

MIT (c) Eigenwise
