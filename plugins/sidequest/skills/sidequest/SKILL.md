---
name: sidequest
description: >-
  Open the sidequest board (a live, self-hosted Kanban of tickets) in the browser, or manage tickets
  from the CLI. Use when the user says "show me the dashboard", "open the board", "open the sidequest /
  ticket board", "open the kanban", "show my tickets", "what's on my board", or wants to file, list,
  update, move, close, prioritize, label, or delete tickets — e.g. "make a ticket for X", "add a bug
  ticket", "close SQ-3", "move SQ-2 to done", "bump SQ-5 to urgent", "what tickets are open". Tickets
  are stored centrally, so one dashboard shows every project's board at once. For capturing a side
  issue mentioned mid-task, prefer the ticket-filer agent (the capture hook nudges you to it).
---

# sidequest

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

## Guidelines

- **Act, then report.** Run the command and tell the user the result (the ref, the new status, or the
  URL). Don't ask which board unless it's genuinely ambiguous — default to the current project.
- **Keep titles tight and concrete.** One line; put detail in `-d`.
- **The dashboard is live.** It polls, so tickets you add from the CLI appear on an open board within a
  couple of seconds — no refresh needed. New arrivals animate in.
- **Don't invent tickets.** Only file what the user actually raised.
