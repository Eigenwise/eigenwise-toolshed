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
  it into linked tickets on the board BEFORE implementing, then work them one at a time. ALSO use when
  you need to leave a note or ask the user something on a ticket ("comment on SQ-3", "ask on the ticket
  whether..."), or check for/wait on a reply to a question you asked — a question needs a pause-and-
  wait via `sidequest await`, unlike a plain note-to-self comment. ALSO use for relating tickets
  ("SQ-4 depends on SQ-3", "what's blocking this ticket").
---

# sidequest

## Plan substantial work on the board first

When the user gives you a task that is **more than a single small change** — a feature with several
parts, a request with multiple deliverables, or an explicit "split this into tickets" / "make tickets
for this" — do this **before writing any code**:

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
   when it belongs to a story from step 0).
2. **Link dependencies** so the order is explicit: `sidequest link SQ-4 depends-on SQ-3`,
   `sidequest link SQ-2 blocks SQ-8`. (See "Link tickets" below.)
3. **Work them one at a time**: `claim` a ticket, do it (yourself or via a subagent), `done`, repeat —
   letting the board be the source of truth for what's left, instead of holding the whole plan in your
   head or an ad-hoc todo list.

This is the point of having the board: the plan is visible, survives context loss, and other agents can
pick up unblocked pieces. Don't skip it for anything non-trivial. For a genuinely trivial one-step
change, just do it — no need to ticket everything (and no story).

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

**Write a description that lets someone else pick up the ticket cold** — what it needs depends on the
kind of ticket:
- **Bug** → clear steps to reproduce (what you did, what happened, what you expected). "Doesn't work"
  is not a description.
- **Feature / task** → the requirements — what "done" looks like, any constraints, and known
  out-of-scope. Enough to start without re-asking the user.
- **Question / spike** → what's actually unknown and why it matters.

If you don't have enough of that detail, ask a quick clarifying question rather than filing a vague
ticket — a thin ticket just costs the next reader (you, another agent, or the user) another round trip.

**Descriptions and comments render a light markdown subset** in the dashboard — `**bold**`, `*italic*`,
and `` `code` ``. Use it where it actually improves scanability (e.g. `` `functionName` `` or a file
path in code font, **bold** for the one thing that matters most) — don't force it into every line.

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
#   ... do the work (yourself, or spawn a subagent for it — see below) ...
sidequest done SQ-3 --by <you>         # mark done + release the claim
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
- **Small enough to delegate?** After you've claimed the ticket, you may spawn a subagent to actually do
  the work while you orchestrate — just claim first, and mark it `done` once the subagent reports back.
- **Stale claims** (a worker that crashed or wandered off) are reclaimable after a timeout
  (`SIDEQUEST_CLAIM_TTL_MIN`, default 60 min); `--force` overrides a live claim only when you're sure.

## Fan out over independent tickets (do this by default)

When several tickets are **ready and independent**, **work them in parallel** — do not grind through
them one at a time. This is safe precisely because claiming is atomic: each subagent claims a different
ticket, and any race just sends the loser to the next one.

A ticket is **ready** when it's not done, not archived, not already claimed, and **not blocked** by an
unfinished ticket (`sidequest ready` lists exactly this set). Two ready tickets are **independent** when
neither depends on the other **and** they don't edit the same files.

**How to fan out:**

1. `sidequest list --status doing` — if tickets are already `doing` under a `--by` you don't recognize,
   another session may be actively working this board; flag it to the user before proceeding.
2. `sidequest ready --json` to see the fan-out-able set.
3. Spawn **one subagent per ticket**, in a single batch (parallel), each told to:
   `sidequest claim <ref> --by <unique-id>` → if the claim succeeds, do the work, then
   `sidequest done <ref> --by <same-id>`; if it fails, stop (someone else has it).
   Give each a **genuinely random, session-scoped `--by`** — not just the ticket ref or a fixed label,
   since a second independent session fanning out over the same board would derive the identical value
   and silently coexist as the same worker (see the note on identity collisions above).
4. When a batch finishes, the dependents it unblocked become ready — fan out over the next wave.

**Keep sequential** (don't parallelize) tickets that **depend on each other** or that **touch the same
files** — parallel edits to one file collide. Link such tickets with `depends-on` so `ready`/`next`
naturally serialize them. For a large fan-out you may use a subagent workflow; otherwise a batch of
background subagents is enough.

## Comments & questions

Every ticket has a comment thread. Post one with `sidequest comment` or `sidequest ask` — the two
have **different follow-up behavior**, so pick deliberately:

```bash
sidequest comment SQ-3 -m "Reused the SQ-1 fixtures here."   # a note-to-self: keep working, no pause
sidequest ask     SQ-3 -m "Cover the v2 API too?"            # addressed to the user: needs a reply
sidequest comments SQ-3                                       # read the thread
```

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
- Comment bodies render the same light markdown as descriptions (`**bold**`, `*italic*`, `` `code` ``) —
  reach for it when it aids scanning (a ticket ref, a file path, a command), not as a rule to follow
  everywhere.

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
