# Codegraph

Codegraph gives Claude a semantic view of a TypeScript or JavaScript project: symbol relationships, dependency paths, inheritance, module structure, and focused context. It complements Grep and LSP when you need to understand how a change travels through the codebase.

[Setup guide](https://eigenwise.github.io/eigenwise-toolshed/getting-started/codegraph/) · [Generated reference](https://eigenwise.github.io/eigenwise-toolshed/reference/codegraph/) · [Toolshed marketplace](../../README.md)

## Install

Run these in Claude Code from the project you want to index:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install codegraph@eigenwise-toolshed --scope project
```

Reload plugins or start a new Claude Code session, then tell Claude:

> Set up Codegraph for this project.

Claude handles runtime acquisition, project discovery, indexing, freshness checks, and repair through the bundled skill. You do not need to manage the semantic runtime yourself.

## Use it

Ask Claude for a relationship instead of a file search:

> Use Codegraph to trace the exported request handler `saveInvoice` to the persistence adapter, then show the symbols that depend on that adapter before I change it.

Claude checks the snapshot first, follows resolved symbol relationships, and opens the relevant source with normal file tools. Codegraph is useful for impact, paths, hierarchies, module structure, and focused context. Grep and LSP remain useful for exact text, diagnostics, and definitions.

For daily work, ask Claude to use Codegraph when a change crosses files or symbols. Codegraph only answers from a ready snapshot. It indexes missing or stale projects before querying and refuses stale facts instead of presenting an old graph as current.

## If something stops working

Tell Claude the symptom:

> Codegraph says the snapshot is missing or stale. Refresh it for this project.

> Codegraph is unavailable. Diagnose the pinned runtime and repair the setup.

Claude reports the status, checks the project configuration and pinned runtime, and performs one explicit retry after fixing a problem. It will tell you when the project cannot be indexed.

## License

MIT
