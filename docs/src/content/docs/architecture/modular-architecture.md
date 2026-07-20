---
title: Modular toolshed architecture
description: The small integration points that let Toolshed plugins work together.
---

Each plugin owns its behavior and can run alone. Cooperation uses explicit local boundaries.

- Workbench hooks write metadata-only lifecycle observations. Its observer and Collector stay on loopback, and Grafana reads the local store.
- Codex Gateway keeps the API boundary in one place. Its shim selects the local proxy for `claude-codex-*` ids and leaves other model ids on their normal API path.
- Sidequest owns tickets, categories, dispatch, and executor evidence. It can read the gateway model catalog, but category policy remains in Sidequest's central store.
- Plugins can advertise small registry records under `~/.claude/toolshed/registry/`. Consumers validate the shape instead of walking plugin caches.

Sidequest category routing uses the category model and effort first, then its configured fallbacks. The CLI, MCP server, dashboard, and executor dispatch all resolve the same project-aware policy.
