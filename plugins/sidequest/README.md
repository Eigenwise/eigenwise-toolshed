# sidequest

[![Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FEigenwise%2Feigenwise-toolshed%2Fmain%2Fplugins%2Fsidequest%2F.claude-plugin%2Fplugin.json&query=%24.version&label=version&color=blue)](.claude-plugin/plugin.json)
[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-D97757?logo=claude&logoColor=white)](https://claude.com/claude-code)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](../../LICENSE)

Sidequest is a local Kanban board for Claude Code. It keeps tickets in one central SQLite store and shows every project in one dashboard.

It tracks work; it does not run it. Dispatch, routing, executors, and claims were removed in 4.0.0 — see the guide for why, and where that knowledge went.

The board is local-only. The server binds to `127.0.0.1`, ticket content stays on disk, and the plugin has no hosted service.

> Start with the [sidequest guide](https://eigenwise.github.io/eigenwise-toolshed/getting-started/sidequest/), then see the [full docs site](https://eigenwise.github.io/eigenwise-toolshed/).

## Install

Install Sidequest at project scope by default, so its config travels with the repo.

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install sidequest@eigenwise-toolshed --scope project
```

`/workbench:init-workspace` installs and configures Sidequest for a project for you, so manual installation is the fallback.

Reload Claude Code after installing or upgrading. The installed plugin runs committed CommonJS files and has no runtime or frontend install step. Development requires Node 22.5+.

Open the dashboard with `/sidequest:board`, `sidequest dashboard`, or a natural-language request such as “show me the board”.

## Board model

A board is anchored to a repository path. The CLI walks up to the nearest `.git`; `--project <path-or-slug>` targets another registered board. Tickets have `SQ-n` refs and statuses `todo`, `doing`, and `done`. Stories group related tickets under `US-n` refs. Tickets can also have priority, labels, images, comments, reminders, links, persistent assignees, and declared files.

The store is central, so one dashboard can switch among all projects and an **All boards** view. A loaded MCP server or old session can still write the old store, so restart stale sessions after a migration. Board display names can change without changing the stable board ID or repository path.

```bash
sidequest add -t "Safari checkout error" -d "Reproduction and expected behavior" \
  --priority high --file src/checkout.ts
sidequest story add -t "Checkout revamp" --color teal
sidequest update SQ-7 --story US-1
sidequest link SQ-7 SQ-3
sidequest remind SQ-7 --in 1h
sidequest assign SQ-7 --to you
```

An assignee is persistent human or agent ownership and never expires. Nothing about it gates who may edit a ticket.

## MCP tools

The plugin registers one Sidequest MCP server. MCP and CLI act on the same store. Sixteen tools, all of them about tracking tickets.

Routine reads are brief by default. Use the opt-in full/detail fields when you need large payloads. Paged responses include `nextCursor`; follow it until it is `null`.

### Read tools

- `list`: active tickets by default, compact rows, paging. `detail: true` returns full ticket bodies and comment threads; `status: "done"` or `all: true` includes completed tickets.
- `changes`: compact polling delta with `serverTime`; use that value as the next `since` value.
- `story`: add, list, show, update, or remove stories.

`comments` is brief and newest-first by default, and supports `full: true` for exact chronological bodies.

### Ticket and collaboration tools

- `add`, `update`, `remove`, `archive`, `unarchive`
- `comment`, `comments`, `plan`
- `link`, `unlink`, `assign`

### Closing tools

- `done` closes a ticket with a final comment.
- `groomClose` closes an inactive one and records why.

## Dashboard

The dashboard is a self-contained local page. It polls about every 2.5 seconds, pauses in a background tab, and refreshes when you return. It supports board switching, search, priority/status/story/assignee filters, drag-and-drop status changes, ticket editing, comments, links, reminders, attachments, archive views, board archive/restore, and permanent board deletion.

The notification bell is a persistent server-side inbox for Claude-originated comments, new tickets, status changes, and reminders. Dashboard-originated edits do not notify. The gear menu controls event preferences, desktop notifications, and per-project muting.

## Hooks

Five events, down from thirteen. The orchestration hooks went with the engine:

- `PreToolUse`: oversized-skill guard, home-delete protection, repeated-command warning, Windows-path protection, and destructive-git protection. These are general safety, not board policy.
- `Stop`: compaction suggestion.
- `PreCompact`: compaction policy.
- `PostCompact`: post-compaction recovery guidance.
- `SessionStart`: registry write, plus a short note saying what the board is and how many tickets are open.

### Compaction policy

`SIDEQUEST_COMPACTION_POLICY` controls the `PreCompact` hook:

- `pin` is the default, and an unset value behaves the same. For an automatic compaction, it injects a bounded summary of the tickets currently in `doing` so they survive compaction.
- `off` disables the policy.

The experimental `veto` mode, which could delay compaction, was removed in 4.0.0. Nothing blocks compaction now. The hook only acts on automatic `PreCompact` events, and its injected instruction is capped at 1500 bytes.

## CLI reference

The CLI entry point is `bin/sidequest.js`. Common commands are:

```text
add, list, changes, update, rm
story add|list|show|update|rm
done, groom-close
comment, comments, plan, link, unlink
assign, unassign, remind, unremind
archive, unarchive, archive-board, unarchive-board
projects, board-config, publish
temp cleanup
dashboard, serve, stop
publish lock|unlock|status|queue
```

Run `sidequest <command> --help` for options. The target board defaults to `$CLAUDE_PROJECT_DIR` or the current repository. Use `--project` to target another board.

## Storage and configuration

By default:

```text
~/.claude/sidequest/
  sidequest.db
  server.json
  projects/<board-slug>/assets/<id>/<image>
```

SQLite uses Node's built-in `node:sqlite` with WAL mode. Older JSON stores migrate non-destructively on first open.

| Variable | Default | Purpose |
|---|---|---|
| `SIDEQUEST_HOME` | `~/.claude/sidequest` | Central board store and isolated-test home. |
| `SIDEQUEST_PORT` | `41730` | Preferred dashboard port; Sidequest chooses the next free port if occupied. |
| `SIDEQUEST_CLAIM_ABANDON_MIN` | `1440` | Backstop when no death was observed. |
| `SIDEQUEST_CLAIM_TTL_MIN` | legacy alias | Alias for `SIDEQUEST_CLAIM_IDLE_MIN`. |
| `SIDEQUEST_NUDGE` | `on` | Set `off` to silence the SessionStart board reminder. |
| `SIDEQUEST_COMPACTION_POLICY` | `pin` | `pin`, `veto`, or `off` for automatic compaction. |

When the local Workbench observer is available on `127.0.0.1:14319`, Sidequest sends lifecycle metadata only: IDs and status. It does not send ticket text, comments, prompts, attachments, tokens, credentials, or errors.

## Development

From `plugins/sidequest/`:

```bash
npm ci
npm run typecheck
npm run build
npm run build:check
npm run test:full
npm run test:perf
```

The installed plugin serves committed generated CommonJS files from `bin/`, `lib/`, and `hooks/`. Dashboard source is under `dashboard/`; its committed production build is under `dashboard/dist/`. Never use a live board for tests or screenshots.

## License

MIT (c) Eigenwise
