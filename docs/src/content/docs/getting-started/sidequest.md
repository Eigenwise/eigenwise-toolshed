---
title: Sidequest setup
description: Capture, route, and work the side jobs that appear mid-task.
---

Sidequest is a local Kanban board for Claude Code work.

```text
/plugin install sidequest@eigenwise-toolshed
```

Reload Claude Code, then open the board with `/sidequest:board`. The dashboard spans projects, while each ticket keeps its project path and status. You can also use the Sidequest MCP tools or CLI to add, update, and close tickets.

## Categories and dispatch

Categories describe the kind of work and carry executor guidance, a model route, and an effort. Choose one by its description, not its name. The add result repeats the category description and resolved route so a bad match is visible right away. **Default settings** are shared by every board. **Board settings** fork a category for one board, and the dashboard marks each category as inherited or customized. Resetting a customized category relinks it to the defaults.

Keep tiny lookups inline with `Read`, `Glob`, `Grep`, or `WebFetch`. Every delegated task goes through a ticket and routed dispatch, including an investigation: file a spike (usually `codebase-exploration`), dispatch it, then spawn the returned executor. Routing selects the model, so Sidequest has no unrouted delegation path.

A board can opt out of routed dispatches with `sidequest routing disabled --project <board>`. Turn routing back on with `sidequest routing enabled --project <board>` before dispatching, or use a direct claim for deliberate inline work.

When an active routed board sees five substantive main-thread actions with no board interaction, Sidequest adds one reminder to file a ticket or claim one directly for deliberate inline work. It ignores subagents, pure read-only shell commands, and boards with routing disabled.

## Work a ticket

Route delegated work with `sidequest dispatch SQ-3`, then spawn the returned executor unchanged. Dispatch requires a real ticket description, at least 80 characters, because that description is the executor's entire brief. Include **Where**, **Contract**, and **Verify**. Coding and debugging tickets without a verify command still dispatch, but return a warning. The executor claims with the returned token and executor, commits declared paths, and submits its verified commit for the orchestrator to publish.

For deliberate orchestrator-owned inline work, such as a browser reproduction or review, claim directly with `sidequest claim SQ-3 --by <unique-worker-id> --direct` (MCP: `direct:true`). Do not start either path until its claim succeeds.

Use `/sidequest:groom` to audit stale tickets and `/sidequest:sidequest` when you need board administration. Keep a ticket's file scope accurate so parallel work stays isolated. `docs/` is always in scope on boards whose repo has a root docs directory, so a required prose update ships with the implementation. View or replace that board-level list with `sidequest board-config` or `sidequest board-config --always-in-scope docs/ --always-in-scope <path>` (MCP: `board_config`).

A scoped commit commits its declared paths even when another changed file is outside the ticket. Sidequest reports those paths in the commit result, records a ticket comment, and carries them in the submission as `unscopedPaths`; make a second scoped commit after widening scope, or discard them. Missing declared paths are warnings when other declared paths can be committed.

![Sidequest kanban board](../../../assets/screenshots/sidequest-kanban.png)

![Sidequest ticket detail](../../../assets/screenshots/sidequest-ticket-detail.png)
