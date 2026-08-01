# sidequest

[![Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FEigenwise%2Feigenwise-toolshed%2Fmain%2Fplugins%2Fsidequest%2F.claude-plugin%2Fplugin.json&query=%24.version&label=version&color=blue)](.claude-plugin/plugin.json)
[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-D97757?logo=claude&logoColor=white)](https://claude.com/claude-code)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](../../LICENSE)

Sidequest is a local Kanban board and work router for Claude Code. It keeps tickets in one central SQLite store, shows every project in one dashboard, and routes ticketed work to concrete models and effort through category policy.

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

A board is anchored to a repository path. The CLI walks up to the nearest `.git`; `--project <path-or-slug>` targets another registered board. Tickets have `SQ-n` refs and statuses `todo`, `doing`, and `done`. Stories group related tickets under `US-n` refs. Tickets can also have priority, labels, images, comments, reminders, links, persistent assignees, declared files, contract edges, a category, and a high-stakes flag. Do not recreate a standalone
Switchboard.

The store is central, so one dashboard can switch among all projects and an **All boards** view. A loaded MCP server or old session can still write the old store, so restart stale sessions after a migration. Board display names can change without changing the stable board ID or repository path.

```bash
sidequest add -t "Safari checkout error" -d "Reproduction and expected behavior" \
  --category debugging --priority high --file src/checkout.ts --verify "npm test -- checkout"
sidequest story add -t "Checkout revamp" --color teal
sidequest update SQ-7 --story US-1
sidequest link SQ-7 depends-on SQ-3
sidequest remind SQ-7 --in 1h
sidequest assign SQ-7 --to you
```

Claims are separate from assignees. A claim says an executor is actively working; it is atomic and must succeed before work starts. An assignee is persistent human or agent ownership and never expires. Routed work uses an exact stable executor identity. Native `Explore` is reserved for read-only reconnaissance. Other generic/custom implementation Agent launches are denied.

## Categories and routing

Categories describe the work and select a concrete model plus reasoning effort. The shipped taxonomy covers coding, debugging, review, testing, research, documentation, UI work, and a required `general` fallback. The live category catalog is the authority. Choose a category by its description and persist its ID on the ticket. Do not hand-pick `--model` or `--effort` when filing a ticket.

A board selects a routing profile and can add, override, pin, detach, or disable local category rows. A category has a primary route and may have a fallback. If the primary route is unavailable, Sidequest tries the category fallback and then the global fallback, recording warnings instead of silently changing providers. Provider-specific quota recovery can prepare a configured fallback with a fresh dispatch token. Generic executor failures do not change the route.

```bash
sidequest category list
sidequest category add release-check --name "Release checks" \
  --description "Focused release verification" \
  --route-model sonnet --route-effort medium
sidequest category edit coding.normal --profile default \
  --route-model codex-gpt-5-6-terra --route-effort high
sidequest category reset coding.normal --project .
sidequest global-fallback --model sonnet --effort medium
sidequest models
sidequest route debugging --json
```

Profiles are managed with `profile list`, `show`, `create`, `edit`, `retire`, `use`, `repoint`, `promote`, and `new-board`. Category mutations require an explicit `--profile` or `--project` scope. Read-only categories dispatch restricted executors and close with `done` rather than a repository submission.

Legacy `--complexity` plus `--why` remains accepted for existing intake and maps to a category at read time. New tickets should use `--category`.

## MCP tools

The plugin registers one Sidequest MCP server. MCP and CLI use the same store and policy. Routed executors use MCP lifecycle tools, including `commit` and `submit`, with their absolute worktree path.

Routine reads are brief by default. Use the opt-in full/detail fields when you need large payloads. Paged responses include `nextCursor`; follow it until it is `null`.

### Read tools

- `list`: active tickets by default, compact rows, paging. `detail: true` returns full ticket bodies and comment threads; `status: "done"` or `all: true` includes completed tickets.
- `pulse`: compact liveness read. `full: true` includes submission, git, and dispatch lifecycle.
- `changes`: compact polling delta with `serverTime`; use that value as the next `since` value.
- `ready`: ready tickets grouped into safe waves. Default output is count plus ref/title rows; `full: true` returns ticket records.
- `story`: add, list, show, update, or remove stories.
- `story_contract`: read or set a story execution contract.
- `story_log`: read, append, or clear a story decision log.

`comments` is brief/newest-first for routine orchestration and supports `full: true` for exact chronological bodies. `category_list` is compact by default and supports `full: true` for complete category rows.

### Ticket and collaboration tools

- `add`, `update`, `remove`, `archive`, `unarchive`
- `comment`, `comments`, `plan`
- `link`, `unlink`, `assign`
- `dispatch`, executor cleanup tools

### Lifecycle and delivery tools

- `claim`, `checkpoint`, `next`, `done`, `release`, `verdict`
- `scopeRequest`, `commit`, `submit`, `integrate`, `groomClose`
- `sweepClaims`

Repository executors normally follow `dispatch → token claim → scoped commit → submit → orchestrator integration`. **Routed repo lifecycle:** dispatch → token claim → scoped commit → submit →
  orchestrator publish. The orchestrator owns publish, versioning, and pushing. Direct claim/done is reserved for deliberate inline-safe work, non-repository work, or read-only/artifact contracts that explicitly allow it.

### Routing and board administration tools

- Profiles: `profile_list`, `profile_get`, `profile_create`, `profile_edit`, `profile_retire`, `profile_use`, `profile_repoint`, `profile_promote`, `new_board_profile`
- Routes and categories: `route_recipe`, `category_list`, `category_add`, `category_edit`, `category_detach`, `category_relink`, `category_rm`, `global_fallback`
- Board and project administration: `board_config`, `models`, `projects`, `archive_board`, `unarchive_board`

## Dashboard

The dashboard is a self-contained local page. It polls about every 2.5 seconds, pauses in a background tab, and refreshes when you return. It supports board switching, search, priority/status/category/story/assignee filters, drag-and-drop status changes, ticket editing, comments, links, reminders, attachments, archive views, board archive/restore, and permanent board deletion.

The notification bell is a persistent server-side inbox for Claude-originated comments, new tickets, status changes, and reminders. Dashboard-originated edits do not notify. The gear menu controls event preferences, desktop notifications, and per-project muting.

## Working tickets and parallel waves

A ticket description is the executor's specification. Include exact files, anchors, behavior, edge cases, dependencies, and a runnable verify command. Declare every affected surface and scope work by affected
surfaces with `--file`; directory scopes cover descendants.

```bash
sidequest ready --json --brief
sidequest dispatch SQ-7
```

`ready` excludes claimed, blocked, done, and archived tickets, then groups the rest into waves whose declared file scopes do not overlap. Independent tickets can run in parallel. Shared runtime resources such as ports, servers, and databases still need serialization.

Worktree isolation is enabled by default for declared-file dispatches. A board can disable it with `board-config --no-worktree-isolation`, or an explicit shared-tree/artifact dispatch can opt out. Worktree setup is configured per board and shown verbatim to the executor; Sidequest does not execute or shell-escape that command.

Claims are released on observed executor death, then by activity-based backstops when no live executor is associated. They do not expire merely because a long-running executor has been working. `pulse` reports whether a claim is reclaimable. Preserve a dead executor's worktree and commit before redispatching.

## Publish lock and delivery

The orchestrator integrates submitted work. Delivery can merge, replay, or apply, configured by the board with `board-config --delivery`. Integration rechecks scope and the recorded verify command. A publish lock protects release operations and pushes to the published/default branch. Keep matching versions in both
  `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` when publishing.

```bash
sidequest publish lock --by <who>
sidequest integrate SQ-7 --by <who> --mode replay
sidequest publish queue
sidequest publish unlock --by <who>
```

Executors do not push, bump manifests, or assign release versions. Partial submissions with unscoped paths are rejected until scope is approved and the commit is complete.

## Hooks

The shipped hook registry covers the full Claude Code session and executor lifecycle:

- `UserPromptSubmit`: board-first reminder.
- `PreToolUse`: near-turn-cap warning, inline-work nudge, executor identity enforcement, task-output and peer-message guards, home-delete protection, repeated-command warning, Windows-path protection, destructive-git protection, shared-tree commit protection, and worktree-isolation protection.
- `PostToolUseFailure` for `Agent`: quota-fallback preparation.
- `Stop`: compaction suggestion and board-reconciliation reminder.
- `PreCompact`: compaction policy.
- `PostCompact`: post-compaction recovery guidance.
- `SessionStart`: registry write and session setup.
- `SessionEnd`: release/reconcile the session's claims.
- `SubagentStart` and `SubagentStop`: executor registration, lifecycle reporting, and claim/worktree cleanup.
- `TeammateIdle`: teammate liveness handling.

### Compaction policy

`SIDEQUEST_COMPACTION_POLICY` controls the `PreCompact` hook:

- `pin` is the default. For an automatic compaction, it injects a bounded summary of active doing tickets, active stories, and a held publish lock so those facts survive compaction.
- `veto` is opt-in. When fresh claims or a publish lock make automatic compaction unsafe, it blocks at most two automatic attempts, then allows compaction with the pinned summary. Manual compaction is never vetoed.
- `off` disables the policy.

The hook only acts on automatic `PreCompact` events. Its injected instruction is capped at 1500 bytes. Veto counters are persisted under `SIDEQUEST_HOME/compaction-policy/` per session.

## Token diet and read conventions

Use `list --brief` and `ready --brief` for routine orchestration. Use `changes` for polling and `pulse` for one-ticket liveness. Avoid repeating broad reads while an executor is running. Request `detail: true` or `full: true` only for audit, handoff, integration, or troubleshooting. Comments keep metadata while eliding old bodies in large threads; use full comments when exact text matters.

Ticket and story decision logs are handoffs, not diaries. Record decisions, constraints, discoveries, verification evidence, and integration risks. Keep story log entries short and promote durable findings into the story contract.

Story decision logs keep the full active history. Executor briefings carry a recent window inside a 4 KiB briefing budget, with omitted entries called out. Use `sidequest story log US-n --full` to read the complete history, including entries moved to the archive by `--clear`. Clearing a log empties the active window and preserves the entries and their sequence numbers for later reads. Each entry is limited to 280 bytes. The story execution contract has its own separate 4 KiB limit.

## CLI reference

The CLI entry point is `bin/sidequest.js`. Common commands are:

```text
add, list, update, rm
story add|list|show|contract|log|update|rm
profile hygiene|list|show|create|edit|retire|use|repoint|promote|new-board
category list|add|edit|rm|disable|enable|pin|reset
global-fallback, models, route, routing
ready, next, claim, checkpoint, dispatch, briefing, native-agent
commit, submit, integrate, done, release, groom-close, verdict, scope-request
reconcile, claims sweep, worktrees sweep, recover-shared
comment, comments, plan, link, unlink
assign, unassign, remind, unremind
archive, unarchive, archive-board, unarchive-board
projects, board-config, merge
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
| `SIDEQUEST_AGENTS_DIR` | derived from `SIDEQUEST_HOME` | Explicit generated executor-agent directory. |
| `SIDEQUEST_PORT` | `41730` | Preferred dashboard port; Sidequest chooses the next free port if occupied. |
| `SIDEQUEST_CLAIM_IDLE_MIN` | `60` | Activity-based reclaim window with no live executor. |
| `SIDEQUEST_CLAIM_ABANDON_MIN` | `1440` | Backstop when no death was observed. |
| `SIDEQUEST_CLAIM_TTL_MIN` | legacy alias | Alias for `SIDEQUEST_CLAIM_IDLE_MIN`. |
| `SIDEQUEST_NUDGE` | `on` | Set `off` to silence the SessionStart routing reminder. |
| `SIDEQUEST_COMPACTION_POLICY` | `pin` | `pin`, `veto`, or `off` for automatic compaction. |

When the local Workbench observer is available on `127.0.0.1:14319`, Sidequest sends lifecycle metadata only: routing, IDs, claim worker, submission state, and status. It does not send ticket text, comments, prompts, attachments, tokens, credentials, or errors.

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
