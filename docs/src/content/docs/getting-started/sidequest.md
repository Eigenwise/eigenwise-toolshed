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

Categories describe the kind of work and carry executor guidance, a model route, and an effort. **Default settings** are shared by every board. **Board settings** fork a category for one board, and the dashboard marks each category as inherited or customized. Resetting a customized category relinks it to the defaults.

Keep tiny lookups inline with `Read`, `Glob`, `Grep`, or `WebFetch`. Every delegated task goes through a ticket and routed dispatch, including an investigation: file a spike (usually `codebase-exploration`), dispatch it, then spawn the returned executor. Routing selects the model, so Sidequest has no unrouted delegation path.

A board can opt out of routed dispatches with `sidequest routing disabled --project <board>`. Turn routing back on with `sidequest routing enabled --project <board>` before dispatching, or use a direct claim for deliberate inline work.

## Work a ticket

Route delegated work with `sidequest dispatch SQ-3`, then spawn the returned executor unchanged. It claims with the returned token and executor, commits declared paths, and submits its verified commit for the orchestrator to publish.

For deliberate orchestrator-owned inline work, such as a browser reproduction or review, claim directly with `sidequest claim SQ-3 --by <unique-worker-id> --direct` (MCP: `direct:true`). Do not start either path until its claim succeeds.

Use `/sidequest:groom` to audit stale tickets and `/sidequest:sidequest` when you need board administration. Keep a ticket's file scope accurate so parallel work stays isolated.

![Sidequest kanban board](../../../assets/screenshots/sidequest-kanban.png)

![Sidequest ticket detail](../../../assets/screenshots/sidequest-ticket-detail.png)
