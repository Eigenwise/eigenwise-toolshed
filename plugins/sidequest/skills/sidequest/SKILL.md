---
name: sidequest
description: >-
  Open the sidequest board (a live, self-hosted Kanban of tickets) in the browser, or manage tickets
  from the CLI. Use when the user says "show me the dashboard", "open the board", "open the sidequest /
  ticket board", "open the kanban", "show my tickets", "what's on my board", or wants to file, list,
  update, move, close, prioritize, label, or delete tickets — e.g. "make a ticket for X", "add a bug
  ticket", "close SQ-3", "move SQ-2 to done", "bump SQ-5 to urgent", "what tickets are open". Also use
  when the user wants to WORK the board — "work on the tickets", "grab the next task", "pick up SQ-3",
  "start on the backlog" — which requires atomically CLAIMING a ticket before working it so shared
  boards stay safe across agents. Tickets are stored centrally, so one dashboard shows every project's
  board at once. For capturing a side issue mentioned mid-task, prefer the ticket-filer agent (the
  capture hook nudges you to it). ALSO use this when the user hands you a substantial or multi-part
  task, a feature with several pieces, or says "split this into tickets" / "plan this out" — decompose
  it into linked tickets on the board BEFORE implementing, then work them one at a time.
---

# sidequest

## Plan substantial work on the board first

When the user gives you a task that is **more than a single small change** — a feature with several
parts, a request with multiple deliverables, or an explicit "split this into tickets" / "make tickets
for this" — do this **before writing any code**:

1. **Decompose** it into one ticket per distinct piece of work (`sidequest add ...`).
2. **Link dependencies** so the order is explicit: `sidequest link SQ-4 depends-on SQ-3`,
   `sidequest link SQ-2 blocks SQ-8`. (See "Link tickets" below.)
3. **Work them one at a time**: `claim` a ticket, do it (yourself or via a subagent), `done`, repeat —
   letting the board be the source of truth for what's left, instead of holding the whole plan in your
   head or an ad-hoc todo list.

This is the point of having the board: the plan is visible, survives context loss, and other agents can
pick up unblocked pieces. Don't skip it for anything non-trivial. For a genuinely trivial one-step
change, just do it — no need to ticket everything.

sidequest is a Trello-light quest log. Tickets live in a central store under `~/.claude/sidequest`
(keyed by project path), and a bundled dashboard shows them as a live Kanban board — every project at
once. Everything is driven by one CLI: `bin/sidequest.js`.

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
sidequest add -t "Contact form does not send" -d "Submit does nothing; no email arrives." -p high -l bug -l frontend
```

- `-t` title (required) · `-d` description · `-p` priority `low|normal|high|urgent` (default `normal`)
- `-l` label (repeat for several) · `-s` status `todo|doing|done` (default `todo`)
- `-i` image path (repeat for several) — attach a pasted screenshot by its file path

For a side issue the user tosses out **while you're mid-task** ("oh, and the footer link is broken"),
don't stop your current work: spawn the **`ticket-filer`** subagent (ideally `run_in_background: true`)
with the issue text, any pasted image path, and the CLI command. It files the ticket while you keep
going. The capture hook reminds you of this and hands you the image path.

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
#   ... do the work (yourself, or spawn a subagent for it — see below) ...
sidequest done SQ-3 --by <you>         # mark done + release the claim
sidequest release SQ-3 --by <you>      # or drop it unfinished (optionally --status todo)
```

- **`--by`** identifies you as the worker; use a stable id (your session id, or a short label) so you
  can release/finish what you claimed. Distinct concurrent workers must use distinct `--by` values.
- **If a claim fails**, the CLI says why (`already claimed by X`, `already done`, `no longer exists`) and
  exits non-zero. **Do not work that ticket** — pick another, or stop. This is the whole safety
  guarantee: it never hurts if another agent grabbed it first.
- **Small enough to delegate?** After you've claimed the ticket, you may spawn a subagent to actually do
  the work while you orchestrate — just claim first, and mark it `done` once the subagent reports back.
- **Stale claims** (a worker that crashed or wandered off) are reclaimable after a timeout
  (`SIDEQUEST_CLAIM_TTL_MIN`, default 60 min); `--force` overrides a live claim only when you're sure.

## Guidelines

- **Act, then report.** Run the command and tell the user the result (the ref, the new status, or the
  URL). Don't ask which board unless it's genuinely ambiguous — default to the current project.
- **Keep titles tight and concrete.** One line; put detail in `-d`.
- **The dashboard is live.** It polls, so tickets you add from the CLI appear on an open board within a
  couple of seconds — no refresh needed. New arrivals animate in.
- **Don't invent tickets.** Only file what the user actually raised.
