---
title: Codegraph
description: Trace symbol relationships and focused context across a TypeScript or JavaScript project.
---

Codegraph gives Claude a semantic view of a project: symbol relationships, dependency paths, inheritance, module structure, and focused context. It complements Grep and LSP when a change crosses files or symbols.

## Install

Run these in Claude Code from the project you want to index:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install codegraph@eigenwise-toolshed --scope project
```

Reload plugins or start a new Claude Code session. Then tell Claude:

> Set up Codegraph for this project.

Claude handles runtime acquisition, project discovery, indexing, freshness checks, and repair through the bundled Codegraph skill. You do not need to manage the semantic runtime yourself.

## A useful first request

For a change that starts at an exported request handler and ends in a persistence adapter, ask:

> Use Codegraph to trace the exported request handler `saveInvoice` to the persistence adapter, then show the symbols that depend on that adapter before I change it.

Claude checks the snapshot first, follows resolved symbol relationships, and opens the relevant source with normal file tools. Grep and LSP remain useful for exact text, diagnostics, and definitions.

## Daily use

Ask Claude to use Codegraph when you need to understand impact across symbols, find a path between two parts of a project, inspect a type hierarchy, spot module structure, or gather focused context. Codegraph only answers from a ready snapshot. Missing or stale projects are indexed first, and stale facts are refused rather than presented as current.

## If something stops working

Describe the symptom:

- **The snapshot is missing or stale:** Ask Claude to refresh Codegraph for the project.
- **The runtime is unavailable:** Ask Claude to diagnose the pinned runtime and repair the setup.
- **Indexing fails:** Ask Claude to check the project configuration, then retry once after the cause is fixed.

Claude reports the status and tells you when the project cannot be indexed. It does not retry indexing in a loop.

The generated [Codegraph reference](/reference/codegraph/) records the agent-facing contract used by the skill.
