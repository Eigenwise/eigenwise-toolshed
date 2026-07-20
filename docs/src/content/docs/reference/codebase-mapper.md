---
title: codebase-mapper
description: "A self-maintaining codebase map: atomic docs Claude loads at the start of each session and keeps in sync as the code changes. Any stack; greenfield or existing."
---

<!-- AUTO-GENERATED — do not edit; run npm run generate -->
# codebase-mapper

A self-maintaining codebase map: atomic docs Claude loads at the start of each session and keeps in sync as the code changes. Any stack; greenfield or existing.

**Version:** `2.10.0`

## Skills

- - `map-codebase`: Generate a structured, self-maintaining codebase map: a set of atomic Markdown docs in .claude/.codebase-info/ that ground every future Claude session in how the project is built. Use when the user asks to "map the codebase", "document the codebase", "create codebase documentation", "generate architecture docs", "onboard me to this project", "what does this codebase do", "bootstrap codebase docs", "set up codebase-mapper", or "analyze the project structure". Works for any language/stack and for both existing projects and brand-new or empty ones. To refresh an existing map after code changes, use update-codebase-map instead.
- - `update-codebase-map`: Refresh an existing codebase map in .claude/.codebase-info/ so it reflects the current code. Detects what changed since the map was last written, updates only the affected atomic docs, and re-records state. Use when the user asks to "update the codebase map", "refresh codebase docs", "sync documentation", "the docs are stale", "update architecture docs", or after a change that affects architecture, structure, dependencies, the data model, entry points, APIs/events, or conventions. If there's no .claude/.codebase-info/ yet, use map-codebase instead.

## Hooks

- **SessionStart**: `node "${CLAUDE_PLUGIN_ROOT}/hooks/inject-context.js"`
- **UserPromptSubmit**: `node "${CLAUDE_PLUGIN_ROOT}/hooks/remind.js"`

## Bin entrypoints

- None

[Source on GitHub](https://github.com/Eigenwise/eigenwise-toolshed/tree/main/plugins/codebase-mapper)
