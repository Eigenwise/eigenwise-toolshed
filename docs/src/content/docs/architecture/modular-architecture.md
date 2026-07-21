---
title: Modular toolshed architecture
description: The small integration points that let Toolshed plugins work together.
---

Each plugin owns its behavior and can run alone. Cooperation uses explicit local boundaries.

- Workbench hooks write metadata-only lifecycle observations. Its observer and Collector stay on loopback, and Grafana reads the local store.
- Codex Gateway keeps the API boundary in one place. Its shim selects the local proxy for `claude-codex-*` ids and leaves other model ids on their normal API path.
- Sidequest owns tickets, routing profiles, categories, dispatch, and executor evidence. Each board points to one complete profile, and its local ADD, OVERRIDE, DETACH, or DISABLE rows apply on top. Profile edits propagate to pointing boards; local rows preserve their provenance. The model-availability fallback remains global and is evaluated after the category route and category fallback.
- Plugins can advertise small registry records under `~/.claude/toolshed/registry/`. Consumers validate the shape instead of walking plugin caches.

## Routing profiles

A profile is a self-contained routing policy: it owns the full category rows, descriptions, contracts, routes, and fallbacks. A board stores a pointer to one profile. Resolution loads that profile, applies board-local rows, then resolves the ticket category and the global model-availability fallback. A board can move to another profile without copying profile entries.

The profile lifecycle is available through the Sidequest CLI and MCP: list or inspect profiles, create one from a starter, edit or retire it, use it for a board, preview or apply a bulk repoint, promote a board's effective taxonomy, and choose the profile for new boards. Profile revisions are audit metadata. They do not change executor identity.
