---
title: Modular toolshed architecture
description: The small integration points that let Toolshed plugins work together.
---

Each plugin owns its behavior and can run alone. Cooperation uses explicit local boundaries.

- Workbench sets up and maintains a workspace and records nothing. Observability hooks write metadata-only lifecycle observations; its observer and Collector stay on loopback, and Grafana reads the local store. Workbench heals a stale statusline pin only when Observability is installed, and it resolves that plugin from the install registry rather than importing it, so neither plugin needs the other.
- Model Gateway keeps the API boundary in one place. Its shim selects the local proxy for `claude-gpt-*` and `claude-grok-*` ids and leaves other model ids on their normal API path.
- Sidequest owns tickets, stories, comments, and links, and nothing else. It tracks work; it does not run it. Routing profiles, categories, dispatch, and executor evidence were removed in 4.0.0.
- Plugins can advertise small registry records under `~/.claude/toolshed/registry/`. Consumers validate the shape instead of walking plugin caches.
