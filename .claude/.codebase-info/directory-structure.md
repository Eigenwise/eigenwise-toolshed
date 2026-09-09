# Directory structure

Last Updated: 2026-09-09

- `.claude/`: project settings, live rules, and generated codebase map.
- `.claude-plugin/`: marketplace manifest and published plugin entries.
- `plugins/sidequest/`: board engine, MCP server, CLI, hooks, dashboard, tests, committed build output, and bundled stable executor agents under `agents/`. Pure lifecycle and worktree decisions live in `src/lib/kernel/`; persistence is split under `src/lib/store/`, with matching compiled modules under `lib/`. `scripts/generate-bundled-agents.mjs` derives the packaged agent markdown from `lib/agentsync.js`. `plugins/sidequest/scripts/owned-process-tree.js` and `plugins/sidequest/scripts/owned-phase-supervisor.js` keep test and release subprocess ownership explicit through cleanup.
- `plugins/observability/`: observer, statusline, Collector setup, and sinks under `observability/sinks/`, including Grafana model pricing and generated dashboard templates, plus the eight lifecycle hooks and the `enable-project-telemetry` skill.
- `plugins/model-gateway/`: local model gateway CLI, registry hook, skills, and tests; `lib/` holds the shim/worker runtime, the per-model policy table, process supervision, the Windows detached launcher, lifecycle diagnostics, cache-sibling identity checks, bounded owner resolution, and full-width POSIX process probes.
- `plugins/live-rules/`: rule-management skills and prompt/edit/session hooks.
- `plugins/codebase-mapper/`: map-generation/update skills and context injection hooks.
- `plugins/whittle/`: unregistered optional style-mode core with Node.js hooks, project/session state, status command, host command definition, skill policy, and runtime tests; it is not a published plugin or marketplace entry.
- `plugins/quartermaster/`: workspace setup and resupply skills (`setup`, `resupply`), the `update-toolshed` and `toolshed-doctor` skills, updater and workspace-plugin installers under `bin/`, transcript miner CLI under `bin/quartermaster.js`, streaming signal collector under `lib/`, a SessionEnd tally hook, and SessionStart hooks that inject the capability-capture charter every session (skipped where setup seeded the self-improvement live rule) plus a threshold-gated offer of a user-approved optimization round, a Stop hook that re-raises an overdue offer once per session at turn end, and a separate Stop freshness/update check plus compaction-window diagnostics and billing-path checks. Setup seeds an adapted reuse-first implementation baseline and self-improvement rule into each approved workspace.
- `plugins/test-support/`: JavaScript test scanner shared by Quartermaster, Observability, and Model Gateway tests.
- `docs/`: Astro/Starlight prose, generated reference source, scripts, and synthetic screenshots.
- `sandbox/windows/`: maintainer-only, gitignored Windows Sandbox launcher, guest bootstrap, and PowerShell contract test — never committed, no public docs page.
- `scripts/release/`: release note, plan, cut, guard, manifest, and release tests.
- `.github/workflows/`: test, release guard, release cut, and docs deployment automation.
- `examples/`: small example projects, not production plugin runtime.

Do not map `node_modules`, build output, vendor code, caches, or local databases as source modules.
