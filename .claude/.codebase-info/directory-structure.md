# Directory structure

Last Updated: 2026-08-10

- `.claude/`: project settings, live rules, and generated codebase map.
- `.claude-plugin/`: marketplace manifest and published plugin entries.
- `plugins/sidequest/`: board engine, MCP server, CLI, hooks, dashboard, tests, and committed build output.
- `plugins/workbench/`: workspace setup, updater, doctor skills, pull-only TypeScript MCP code intelligence under `lib/code-intel/`, and freshness and billing-path hooks.
- `plugins/observability/`: observer, statusline, Collector setup, and sinks under `observability/sinks/`, plus the eight lifecycle hooks and the `enable-project-telemetry` skill.
- `plugins/model-gateway/`: local model gateway CLI, registry hook, skills, and tests.
- `plugins/live-rules/`: rule-management skills and prompt/edit/session hooks.
- `plugins/codebase-mapper/`: map-generation/update skills and context injection hooks.
- `plugins/codegraph/`: semantic graph MCP server, pluggable TypeScript/JavaScript and Python providers, pinned TypeScript and Pyright runtime manifests, extractors, graph store, bounded queries, hooks, and tests. Python discovery and freshness live under `src/lib/languages/python/`; Python semantic fixtures live under `test/fixtures/python-semantic/`.
- `plugins/quartermaster/`: workspace setup and retro skills (`setup`, `retro`), transcript miner CLI under `bin/quartermaster.js`, streaming signal collector under `lib/`, a SessionEnd tally hook, and a threshold-gated SessionStart nudge hook.
- `plugins/test-support/`: JavaScript test scanner shared by Workbench, Observability, and Model Gateway tests.
- `docs/`: Astro/Starlight prose, generated reference source, scripts, and synthetic screenshots.
- `sandbox/windows/`: maintainer-only, gitignored Windows Sandbox launcher, guest bootstrap, and PowerShell contract test — never committed, no public docs page.
- `scripts/release/`: release note, plan, cut, guard, manifest, and release tests.
- `.github/workflows/`: test, release guard, release cut, and docs deployment automation.
- `examples/`: small example projects, not production plugin runtime.

Do not map `node_modules`, build output, vendor code, caches, or local databases as source modules.
