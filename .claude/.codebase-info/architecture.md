# Architecture

Last Updated: 2026-08-10

## Repository shape

The repository is a plugin marketplace. Seven plugins are published: `plugins/sidequest`, `plugins/workbench`, `plugins/observability`, `plugins/model-gateway`, `plugins/live-rules`, `plugins/codebase-mapper`, and `plugins/quartermaster`, with marketplace metadata in `.claude-plugin/marketplace.json`. `plugins/test-support` is shared test support, not a plugin.

## Runtime flow

Claude Code loads runtime files declared by plugin manifests and hook manifests. Sidequest builds TypeScript from `plugins/sidequest/src/` into committed `lib/`, `bin/`, and `hooks/` output. Its MCP entry is `plugins/sidequest/bin/sidequest-mcp.js`, configured by `plugins/sidequest/.mcp.json`; hooks are registered in `plugins/sidequest/hooks/hooks.json`. CLI and MCP handlers share store operations in `plugins/sidequest/src/lib/store.ts`.

Sidequest persists board state in SQLite and serializes mutations per board. The orchestration loop covers dispatch, routing, categories, executors, claims, submissions, scope enforcement, and worktree management through typed store and lifecycle modules. Confirmed terminal process evidence can release the exact dead claim or pre-claim dispatch binding; live and unknown owners remain protected, and ownership is checked before forced submission or release mutations. `plugins/sidequest/src/lib/agentsync.ts` compiles dispatch briefings through `context-packet.ts` into bounded projections, `mcp-read.ts` exposes `context_page`, and `mcp-shared.ts` creates and resolves its revision-bound retrieval handles. The dashboard is a separate Svelte/Vite app that talks to the local server over HTTP `/api/*` and polls state.

## Dispatch lifecycle

The dispatch lifecycle freezes the story contract and briefing snapshot at preparation time, then serves omitted pages through `context_page` rather than rereading mutable state. Read-only zero-scope dispatches stay in the invoking checkout; reviewed submissions can be superseded by a later integrated repair, while retained worktree continuations carry their checkpoint into a redispatch.

Workbench bootstraps project configuration, provides pull-only TypeScript code intelligence, updates Toolshed installs through the stable Model Gateway updater launcher, and migrates legacy gateway state. Its MCP registry binds every request to an explicit canonical project root and keeps one TypeScript language server per root, so diagnostics, definitions, and references never cross worktree boundaries. It hands telemetry setup to Observability, which owns the observer, Collector, sinks, and statusline. Model Gateway's `plugins/model-gateway/bin/model-gateway.js` maintains the local proxy, shim, readiness state, catalog, and model routing for `claude-gpt-*` and `claude-grok-*` models, while retaining legacy `claude-codex-gpt-*` compatibility; it can bind an ephemeral shim port, record serving version, and defer restart. Observability provisions Grafana dashboards from the local opted-in-project registry. Live-rules injects matching developer rules at prompt and edit time. Codebase-mapper injects `.claude/.codebase-info/INDEX.md` at session start and enforces main-session map updates through PreToolUse and Stop hooks. Quartermaster's miner reads outside the repository: `plugins/quartermaster/lib/scan.js` selects transcripts from `~/.claude/projects/<slug>/`, including per-session `subagents/*.jsonl`, and `lib/signals.js` reduces them to a bounded JSON aggregate on stdout. Its per-session tallies and decision ledger live under `~/.claude/quartermaster-state/`, so nothing is written into the project.

`sandbox/windows/` is a maintainer-only, gitignored (`.gitignore`: `/sandbox/`) Windows Sandbox clean-room harness: it generates an isolated `.wsb`, maps only its bootstrap directory read-only, and validates its PowerShell scripts with `Test-ToolshedSandbox.ps1`. It has no public docs page and is never pushed to the shared repository.
