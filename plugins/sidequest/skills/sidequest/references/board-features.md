# Board features: stories, notifications, reminders, assignment, attachments

Read this for the exact commands behind stories, reminders, notifications, human assignment, or
attachment-path resolution.

## User stories

A **story** groups several tickets that share a goal and color-codes them together on the board.
Reach for one when a request breaks into multiple tickets; skip it for a lone ticket.

```bash
sidequest story add -t "Checkout revamp" [-d "..."] [--color teal]   # prints its US-n ref
sidequest story list                                                  # stories + color + ticket count
sidequest story show US-1                                             # the story and its tickets
sidequest story update US-1 -t "New title" [--color "#7a5ba8"]        # rename / recolor
sidequest story rm US-1                                               # delete (member tickets detached)
```

- Attach a ticket at creation (`sidequest add ... --story US-1`) or later
  (`sidequest update SQ-3 --story US-1`; `--story none` clears it).
- **Color** is optional — a distinct one is auto-assigned per story. Override with a hex or a name:
  `terracotta, teal, violet, olive, rose, steel, amber, green`.
- The dashboard shows each card with its story's color (top rail + chip), a **Story** filter in the
  toolbar, and a Story field in the ticket editor.

## Notifications

The dashboard has an in-app notification inbox (the bell, top-right), backed by a persistent
server-side queue:

- **Background events** — Claude/CLI creating, moving, commenting on, or asking a question about a
  ticket enqueues a notification automatically (per-kind opt-in/out in the settings popover), even if
  the dashboard tab was closed at the time. The inbox splits **Needs you** (questions + reminders)
  from **Activity** (new tickets, moves, comments); a question turns the bell badge red. Nothing for
  you to do — this is automatic.
- **Per-project mute** — a muted board queues nothing, regardless of per-kind settings; its rail row
  shows a muted-bell mark.
- **Desktop toasts** are a separate opt-in (settings popover), alongside the inbox.

## Reminders

```bash
sidequest remind SQ-3 --in 1h                    # presets: 1h | 3h | tomorrow (9am)
sidequest remind SQ-3 --at "2026-07-05T09:00"    # or a specific date/time
sidequest unremind SQ-3                          # cancel a pending one
```

Use `remind` when the user says "remind me about this in an hour" — a comment doesn't fire anything
later. The reminder fires into the live queue once its time passes; the dashboard server needs to be
up for the fire to be noticed promptly, and it survives a server restart. The ticket editor offers
the same presets as a "Remind me" control.

## Assign a ticket to the human

Separate from an agent **claim** (atomic, TTL-bound, gates `ready`/`next`), a ticket can carry a
persistent **assignee** — normally the human. Use when the user says "assign this to me":

```bash
sidequest assign SQ-3               # assign to "you" (the default human identity)
sidequest assign SQ-3 --to Kenny    # or a specific name
sidequest unassign SQ-3             # clear it
```

The dashboard shows an assignee chip and a filter (Everyone / Mine / Agents / Unassigned).
Assignment never expires and never blocks `claim`/`ready`/`next`.

## Attachment images

Stored under `<root>/projects/<slug>/assets/<ticket-id>/<filename>`, where `<root>` is
`~/.claude/sidequest` (or `SIDEQUEST_HOME`). To resolve one from a ref like `SQ-12`: run
`sidequest list --json`, find the ticket, read its `project` slug + internal `id` + `assets` array,
then join the path. Don't guess the filename or scan the disk for it.
