---
title: Codebase Mapper setup
description: Create and maintain a codebase map for Claude Code.
---

Codebase Mapper creates a navigable map of a project for future Claude sessions.

```text
/plugin install codebase-mapper@eigenwise-toolshed
```

1. From the project directory, run `/codebase-mapper:map-codebase` for a new or existing project. The skill creates the applicable documents under `.claude/.codebase-info/`, including `INDEX.md`, and records the map state.
2. Review the generated map, then commit `.claude/.codebase-info/` so your team and future sessions share it.
3. After structural or other documented project changes, run `/codebase-mapper:update-codebase-map`. It refreshes only the affected documents, and requires an existing `.claude/.codebase-info/INDEX.md`; use `map-codebase` first if the map does not exist.

The plugin injects `.claude/.codebase-info/INDEX.md` at session start and when work-executing subagents start, so they begin with the map's navigation hub in context. Focused lookup agents are excluded to avoid adding map context where it would only add tokens.
