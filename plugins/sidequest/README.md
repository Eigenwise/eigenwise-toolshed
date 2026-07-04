# sidequest

**A Trello-light quest log for Claude Code.** The stray issues you mention while Claude is busy with
something else — *"oh, and the contact form doesn't send"* — get captured as **tickets** on the spot,
with any image you pasted attached, and land on a **live, self-hosted Kanban dashboard** that spans
every project you work in.

You stay on your main quest; the side quests get written down.

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

### Notifications and unread badges

When **Claude** changes the board while you're working elsewhere, sidequest tells you — but it never
nags you about your own edits:

- **Sidebar unread badge.** Each project shows a small gold badge counting the tickets Claude
  created or moved between columns since you last opened that board. Open the board and the badge
  clears. Changes *you* make in the dashboard (in any tab) never raise a badge.
- **Desktop notification.** When Claude does something in the background — and you're *not* looking at
  the dashboard — you get a native desktop toast ("❓ Question · SQ-6", "💬 Comment · SQ-3", "New side
  quest · SQ-7", "SQ-3 → done"). Click it to jump straight to that board. Click the **bell** in the top
  bar to turn notifications on (the browser asks once for permission). With several dashboard tabs open,
  a change only pops one notification, not one per tab.
- **Choose what pings you.** The **gear** menu next to the bell lets you pick which events notify (and
  badge): **questions**, **comments**, **new tickets**, **status changes** — each a toggle. A question
  from Claude is the one you'll usually want on, since it means Claude is waiting on your answer.

The distinction is by origin: a change made through the dashboard is *you*; a change made by the CLI or
a subagent is *Claude*. Only the latter notifies or badges. (While a board's tab is fully backgrounded,
the browser throttles its timers, so a notification can lag a little; it catches up the moment you
focus the tab.)

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
`next`** — an agent grabbing the top task never picks up work that isn't ready. Once the blocker is
`done`, it unblocks automatically. On the dashboard, links (and an unlink ✕) live in the ticket detail.

## CLI

Every action is a thin wrapper over one script, usable directly too:

```bash
node <plugin>/bin/sidequest.js add -t "Title" -d "Details" -p high -l bug -l ui -i /path/to/shot.png
node <plugin>/bin/sidequest.js list [--status todo|doing|done] [--json]
node <plugin>/bin/sidequest.js update SQ-3 --status done      # -t -d -p -s -l -i
node <plugin>/bin/sidequest.js rm SQ-3
node <plugin>/bin/sidequest.js claim SQ-3 --by <you>          # take a ticket to work (atomic; --force to steal)
node <plugin>/bin/sidequest.js next --by <you>                # claim the top-priority available ticket
node <plugin>/bin/sidequest.js done SQ-3 --by <you>           # finish + release  (release = drop unfinished)
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
      meta.json                   # project path, name, ticket counter
      tickets/<id>.json           # one file per ticket
      assets/<id>/<image>         # attached screenshots
```

Each ticket gets a short human ref (`SQ-1`, `SQ-2`, …) per project.

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
