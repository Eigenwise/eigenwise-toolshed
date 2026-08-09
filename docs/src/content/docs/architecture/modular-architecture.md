---
title: Modular Toolshed architecture
description: Maintainer notes on the local boundaries between Toolshed plugins.
---

## Maintainer overview

Each plugin can run by itself. Integration uses explicit local files and registry records so a plugin can discover another plugin without importing its code.

- **Workspace setup:** Workbench prepares and maintains a project. It resolves optional integrations from the install registry, so it can cooperate with Observability without making either plugin a dependency of the other.
- **Local observations:** Observability hooks write metadata-only lifecycle observations. Its observer and collector stay on loopback, and the dashboard reads the local store.
- **Model selection:** Model Gateway owns the API boundary. Its shim sends supported gateway model ids to the local proxy and leaves other ids on their normal path.
- **Project context:** Codebase Mapper and Live Rules own their project files and update flows. Other plugins consume their outputs as context instead of reaching into their implementation.
- **Work delivery:** Sidequest owns tickets, stories, categories, routing profiles, dispatch, and executor evidence.

Plugins can publish small registry records under `~/.claude/toolshed/registry/`. Consumers validate the record shape rather than walking another plugin's cache.

## Sidequest routing profiles

A profile is a complete routing policy with category rows, descriptions, contracts, routes, and fallbacks. A board points to one profile and can add local rows on top. Resolution applies the board rows, selects the ticket category, then applies the global model-availability fallback.

Profile revisions are audit metadata and do not change executor identity. The Sidequest CLI and MCP expose the profile lifecycle, while the board keeps its profile choice as a pointer instead of copying the profile entries.

User setup and daily workflows belong in the [plugin guides](../getting-started/). The [generated reference](/reference/) remains the source for agent-facing command and configuration detail.
