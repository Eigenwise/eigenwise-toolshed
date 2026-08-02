---
title: Sidequest setup
description: A local Kanban board for the side jobs that appear mid-task.
---

Sidequest is a local Kanban board for Claude Code work. You mention a bug while Claude is doing
something else, it files a ticket, and the idea outlives the context window.

```text
/plugin install sidequest@eigenwise-toolshed
```

Reload Claude Code, then open the board with `/sidequest:board`. The dashboard spans every project
you work in, while each ticket keeps its own project path and status. The MCP tools and the CLI act
on the same store.

## It tracks work, it does not run it

Sidequest used to orchestrate: it classified each ticket into a category, resolved that category to a
concrete model and reasoning effort, and dispatched the work to token-gated executor subagents in
isolated git worktrees, with claims, submissions, scope enforcement, and an integration transaction
on top.

That is gone as of 4.0.0. The board is a tracker. There is no dispatch, no routing, no executors, no
claims, no submissions, no worktree management.

The short version of why: parallel orchestration cost roughly 1.2 to 1.4 times as much and five to
six times the requests for identical benchmark scores, and subagents that lacked context produced
locally-correct changes that contradicted each other. The orchestration knowledge did not get thrown
away, it moved to [Playbook](/eigenwise-toolshed/getting-started/playbook/), where `fan-out` and
`pick-model` describe how to split work and which model to suggest. The difference is that you make
the call now, in the conversation, instead of a routing table making it silently.

If you want that behavior back, the last release with it is 3.335.0.

## Capturing tickets

The point of the board is that filing is cheap enough to do mid-sentence. Claude files what you
mention in passing without stopping to ask, then keeps going with what it was doing.

```bash
sidequest add -t "Login redirect loops on expired session" -d "auth/session.ts:88 clears the cookie before the redirect" --priority high
sidequest list
sidequest update SQ-4 --status doing
sidequest comment SQ-4 --by me --body "reproduced on staging"
sidequest done SQ-4 --by me --body "fixed the ordering, added a regression test"
```

`--body-file <path>` works anywhere `--body` does, which is how multi-line text gets in without
shell escaping. Reads are active-only by default: done tickets appear when you ask for them with
`--status done`, so a long board's history stays out of the way.

A ticket is a title, a description, a priority, labels, optional declared files, and optionally a
story. Nothing about models, effort, or verification commands.

## Claude will not start work on its own

The board is readable at any time, but Claude does not open it, pick the top item, and start
editing. It works a ticket when you ask for that ticket. If it thinks two tickets belong together it
says so and waits.

That is deliberate. An agent that quietly assigns itself work is how a session ends up somewhere you
did not ask it to go.

## Stories

A story groups tickets that share a goal and colors them together on the board.

```bash
sidequest story add -t "Checkout revamp" --color teal   # prints its US-n ref
sidequest story list
sidequest story show US-1
sidequest add -t "Cart totals" --story US-1
sidequest update SQ-3 --story none                       # unfile
```

Colors are auto-assigned and can be overridden with a hex value or one of `terracotta, teal, violet,
olive, rose, steel, amber, green`.

## The dashboard

`sidequest dashboard` starts a local server and prints its URL. It shows every project's tickets
live, with a story filter, an in-app notification inbox, reminders, human assignment, and image
attachments on tickets.

## Compaction

Sidequest can preserve board state through auto-compaction. `SIDEQUEST_COMPACTION_POLICY` is a
per-project setting in the project `env` block:

- `pin` (the default, and what an unset value does) adds the tickets currently in `doing` to the
  compaction summary, bounded to 1500 bytes.
- `off` disables it.

The experimental `veto` mode, which could delay compaction, was removed in 4.0.0. Nothing blocks
compaction now.

## Settings

`SIDEQUEST_HOME` sets the central SQLite store (default `~/.claude/sidequest`), `SIDEQUEST_PORT` the
dashboard port, and `SIDEQUEST_NUDGE=off` silences the SessionStart board reminder. When the
[Observability](/eigenwise-toolshed/observability/) plugin is enabled, Sidequest sends lifecycle
metadata only, never ticket text, comments, prompts, attachments, or credentials.
