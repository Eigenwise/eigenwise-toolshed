---
title: Sidequest setup
description: Capture, route, and work the side jobs that appear mid-task.
---

Sidequest is a local Kanban board for Claude Code work.

```text
/plugin install sidequest@eigenwise-toolshed
```

Reload Claude Code, then open the board with `/sidequest:board`. The dashboard spans projects, while each ticket keeps its project path and status. You can also use the Sidequest MCP tools or CLI to add, update, and close tickets.

## CLI basics

Check the installed CLI version with `sidequest --version` (also `sidequest -V` or `sidequest version`). Add `--help` to a command for its usage, for example `sidequest add --help`; use `sidequest help` for the full command list.

Preview a ticket before writing it with `sidequest add -t "title" --category <id> --dry-run`. The preview validates the input and shows what would be created without changing the board. The flag also appears in the profile and merge command forms where those commands support a preview.

## Board display names

A board has a stable board ID and an editable display name. The display name is for people and can change; the board ID, repository path, ticket refs, claims, and links stay the same. Use the CLI to set or view the name:

```text
sidequest board-config --name "Client work" --project <path-or-slug>
```

The MCP equivalent is `board_config` with `name: "Client work"` and the board's project or path. Use the board ID or path when you need to target a board reliably; renaming it does not create or move a board.

## Categories and dispatch

Routing profiles hold a complete category set and keep each board's policy independent. Every board points at one profile, then applies its own local rows as overrides, additions, pins, or disabled entries. A profile edit propagates to every board pointing at it; local changes stay local and the dashboard shows their provenance.

Starter profiles include `coding`, `creative-music`, `research`, and `writing`. The init-workspace interview proposes one after scanning the repository. Accept it, pick another, or create a project profile from a starter. Shared starters are never changed by setup.

Manage profiles with the CLI:

```text
sidequest profile list [--retired] [--json]
sidequest profile show <profile> [--json]
sidequest profile create <profile> [--from <profile>] [--name ...] [--description ...]
sidequest profile edit <profile> [--name ...] [--description ...]
sidequest profile retire <profile>
sidequest profile use <profile> --project <board>
sidequest profile repoint <from> <to> [--dry-run] [--json]
sidequest profile promote <new> --from-project <board> --project <board>...
sidequest profile new-board [<profile>] [--json]
```

`repoint --dry-run` previews changed, added, and missing categories plus local drift. `promote` copies a board's effective taxonomy into a new profile and repoints the selected boards when their taxonomies match. `new-board` reads or sets the profile used for future boards. Profiles can also be managed through the matching Sidequest MCP tools.

Category commands require an explicit scope. Use `--profile <profile>` for profile entries and `--project <board>` for board-local changes. A mutation with neither scope fails. `global-fallback` remains the availability fallback used after category routes and category fallbacks.

Categories describe the kind of work and carry executor guidance, a model route, and an effort. Choose one by its description, not its name. The add result repeats the category description and resolved route so a bad match is visible right away. The board applies local overrides on top of the selected profile, and the dashboard marks each row as profile, override, pinned, board-only, or disabled.

Compact MCP reads for `category_list` and `comments` return `total`, `returned`, and `nextCursor`. Follow `nextCursor` until it is null. Compact category descriptions and comment bodies mark excerpts explicitly; `full:true` returns exact text. Compact comments are newest-first for orchestration, while full comments stay chronological. `full:true` without a cursor or limit keeps the one-call complete response. The CLI JSON shapes do not use this pagination and remain unchanged.

For tickets with more than 10 comments, default CLI and MCP comment reads keep all metadata but elide the oldest comment bodies, with an explicit omitted-count marker. Long orchestrator sessions can re-bill tool results, so this keeps routine reads smaller. Use `sidequest comments SQ-n --full` or the MCP `comments` tool with `full:true` to restore every body. Tickets with 10 or fewer comments are unchanged. Dashboard and REST reads are unaffected.

Use read-only tools or native `Explore` to gather enough evidence for precise tickets, then route implementation by default. Use informed inline judgment when it fits. Routed implementation work goes through a ticket and dispatch. `Explore`, `claude-code-guide`, and `statusline-setup` are narrow harness utilities; other delegated implementation, investigation, research, review, or domain analysis needs a ticketed route.

A board can opt out of routed dispatches with `sidequest routing disabled --project <board>`. Turn routing back on with `sidequest routing enabled --project <board>` before dispatching, or use a direct claim for deliberate inline work.

On the first prompt in each session, an active routed board adds one advisory reminder: gather enough read-only evidence or use `Explore`, then write precise tickets and route implementation by default. It leaves informed inline judgment to the orchestrator. The inline hook records activity counters without blocking or injecting repeat reminders. Both skip subagents, automation prompts, and boards with routing disabled.

## Work a ticket

Route delegated work with `sidequest dispatch SQ-3`, then spawn the returned executor unchanged. Dispatch requires a real ticket description, at least 80 characters, because that description is the executor's entire brief. Include **Where**, **Contract**, and **Verify**. Coding and debugging tickets without a verify command still dispatch, but return a warning. The executor claims with the returned token and executor, commits declared paths, and submits its verified commit for the orchestrator to publish.

When dependent submissions share a main branch, Sidequest automatically trims the submitted range through the newest reachable ancestor that was already submitted. Use an explicit base when you need a different boundary: the CLI accepts `--base <commit>`, and MCP submit accepts `base`. The explicit base must be an ancestor of the submitted tip. Genuine ownership overlap and out-of-scope paths still fail submission.

For deliberate orchestrator-owned inline work, such as a browser reproduction or review, the user must first grant the exception on the ticket, then claim it with a concrete reason: `sidequest update SQ-3 -l direct-ok`, followed by `sidequest claim SQ-3 --by <unique-worker-id> --direct --reason "No routed executor is available for this user-approved inline review"` (MCP: `direct:true` with `reason`, after the user applies the `direct-ok` label). The reason must be at least 20 characters. Do not start either path until its claim succeeds.

Use `/sidequest:groom` to audit stale tickets and `/sidequest:sidequest` when you need board administration. Keep a ticket's file scope accurate so parallel work stays isolated. `docs/` is always in scope on boards whose repo has a root docs directory, so a required prose update ships with the implementation. View or replace that board-level list with `sidequest board-config` or `sidequest board-config --always-in-scope docs/ --always-in-scope <path>` (MCP: `board_config`).

### Board integration and worktree setup

`board-config` also controls how the publish flow integrates submissions and how isolated executor worktrees are prepared:

```text
sidequest board-config --integration-mode auto|local|remote
sidequest board-config --worktree-setup "cd plugins/sidequest && npm ci"
```

`auto` uses local integration when the repository has no `origin` remote, so local-only repos integrate against local `main` without a push. `local` forces that same no-push path. `remote` uses the repository's `origin/main` integration path. The MCP form is `board_config` with `integrationMode: "auto" | "local" | "remote"` and `worktreeSetup: "<one-line command>" | null`.

`worktreeSetup` is per-project. A nonblank command is retained verbatim and shown in a fresh isolated executor briefing as `Worktree setup (run before verify): ...`; shared-tree dispatches and unset configuration omit it. Sidequest does not execute or shell-escape the command. The value must be one line and no longer than 1000 characters. Pass `null` through MCP to clear it.

A scoped commit commits its declared paths even when another changed file is outside the ticket. Sidequest reports those paths in the commit result, records a ticket comment, and carries them in the submission as `unscopedPaths`; make a second scoped commit after widening scope, or discard them. Missing declared paths are warnings when other declared paths can be committed.

Run `sidequest worktrees --sweep` from a board repo to inspect stale executor worktrees. It only plans removals by default. `--yes` removes finished, integrated, or already-merged clean `agent-*` worktrees, then prunes Git's worktree registry. Dirty, ahead, locked, and current worktrees stay put.

![Sidequest kanban board](../../../assets/screenshots/sidequest-kanban.png)

![Sidequest ticket detail](../../../assets/screenshots/sidequest-ticket-detail.png)
