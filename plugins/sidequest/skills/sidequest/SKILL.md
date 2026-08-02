---
name: sidequest
description: >-
  File, find, update, or close tickets on the Sidequest board, and open the dashboard. Use when
  capturing an idea for later, tracking work in progress, or reviewing what is still open.
---

# sidequest

A quest log for the ideas you throw out mid-task. Tickets live in a central store under
`~/.claude/sidequest`, shared across every project, with a live Kanban dashboard, one CLI
(`bin/sidequest.js`), and matching MCP tools.

It tracks work. It does not run it. There is no dispatch, no routing, no executors, no claims. You
and the user decide what gets worked on and when.

## Capture is the point

The board exists because good ideas arrive at bad times. When the user mentions a bug, a cleanup, a
"we should probably…" while you are in the middle of something else, **file it and keep going**.
That is the whole job. An idea that stays in the conversation dies with the context window.

File it without asking. A ticket is cheap and reversible; interrupting the user to ask whether their
aside was worth writing down is not.

## Do not pick work off the board on your own

Reading the board is free. Starting a ticket is not. Work a ticket when the user asks for that
ticket, or when they ask you to pick something and you have said which one you are taking. Do not
open the board, choose the top item, and start editing.

Suggest, then wait. "SQ-14 and SQ-22 both touch that file, want me to take them together?" is right.
Silently taking them is not.

## The commands

MCP tools first when they are loaded (`mcp__plugin_sidequest_board__*`); the CLI is the fallback and
the two act on the same store. If the MCP tools are absent rather than erroring, ask the user to run
`/reload-plugins`.

```bash
sidequest add -t "Title" [-d "description"] [--priority high] [--label x] [--file src/a.ts] [--story US-1]
sidequest list [--status todo|doing|done] [--brief]
sidequest update SQ-4 [--status doing] [--priority low] [--title "…"] [--story none]
sidequest comment SQ-4 --by me --body "what I found"
sidequest done SQ-4 --by me --body "what shipped"
sidequest link SQ-4 SQ-9        # SQ-4 is blocked by SQ-9
sidequest archive SQ-4          # or --done to archive every closed ticket
sidequest rm SQ-4               # permanent
sidequest dashboard             # live board, every project
```

`--body-file <path>` works anywhere `--body` does, which is how you pass anything with newlines
without fighting shell escaping.

Default reads are active-only. Done tickets show up when you ask for them (`--status done`), not
before, because a long board's history is noise when you want to know what is left.

## Writing a ticket someone can act on later

The reader is you, in three weeks, with none of this context loaded. Write for them.

- **Title**: the problem, not the fix. "Login redirect loops on expired session" beats "fix auth".
- **Description**: what you saw, where it lives (`file:line` if you know it), and what "done" means.
  Two sentences is often enough. Nothing is worse than a ticket that only makes sense to the person
  who filed it.
- **`--file`**: the paths it touches, when you already know them. A hint for later, not a contract.
- **Priority**: leave it at normal unless there is a reason. Everything-is-high is the same as
  everything-is-normal.

## Stories

A story groups tickets that share a goal and color-codes them on the board. Use one when a request
naturally breaks into several tickets; skip it for a lone ticket.

```bash
sidequest story add -t "Checkout revamp" [--color teal]   # prints its US-n ref
sidequest story list
sidequest story show US-1
sidequest story rm US-1                                    # members are detached, not deleted
```

## Reference files

Read these only when the situation calls for it:

- `references/board-features.md` — stories, notifications, reminders, assignment, attachments.
- `references/external-trackers.md` — using Sidequest alongside Jira, Linear, or GitHub Issues.
