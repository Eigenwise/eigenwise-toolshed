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

Categories describe the kind of work and carry executor guidance, a model route, and an effort. A ticket is claimed before an executor touches it. The dispatch flow is: select a ready ticket, claim it, run the scoped work and verification, then submit the commit. The board records the route and verification evidence.

Use `/sidequest:groom` to audit stale tickets and `/sidequest:sidequest` when you need board administration. Keep a ticket's file scope accurate so parallel work stays isolated.

![Sidequest kanban board](../../../assets/screenshots/sidequest-kanban.png)

![Sidequest ticket detail](../../../assets/screenshots/sidequest-ticket-detail.png)
