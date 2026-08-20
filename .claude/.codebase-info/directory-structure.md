# Directory structure

Last Updated: 2026-08-20

- `.claude/`: project settings, live rules, and generated codebase map.
- `.claude-plugin/`: marketplace manifest and published plugin entries.
- `plugins/sidequest/`: board engine, MCP server, CLI, hooks, dashboard, tests, and committed build output. Pure lifecycle and worktree decisions live in `src/lib/kernel/`; persistence is split under `src/lib/store/`, with matching compiled modules under `lib/`. `plugins/sidequest/scripts/owned-process-tree.js` and `plugins/sidequest/scripts/owned-phase-supervisor.js` keep test and release subprocess ownership explicit through cleanup.
- `plugins/observability/`: observer, statusline, Collector setup, and sinks under `observability/sinks/`, plus the eight lifecycle hooks and the `enable-project-telemetry` skill.
- `plugins/model-gateway/`: local model gateway CLI, registry hook, skills, and tests.
- `plugins/live-rules/`: rule-management skills and prompt/edit/session hooks.
- `plugins/codebase-mapper/`: map-generation/update skills and context injection hooks.
- `plugins/quartermaster/`: workspace setup and resupply skills (`setup`, `resupply`), the `update-toolshed` and `toolshed-doctor` skills, updater and workspace-plugin installers under `bin/`, transcript miner CLI under `bin/quartermaster.js`, streaming signal collector under `lib/`, a SessionEnd tally hook, and SessionStart hooks that inject the capability-capture charter every session (skipped where setup seeded the self-improvement live rule) plus a threshold-gated offer of a user-approved optimization round, alongside freshness and billing-path checks.
- `plugins/test-support/`: JavaScript test scanner shared by Quartermaster, Observability, and Model Gateway tests.
- `docs/`: Astro/Starlight prose, generated reference source, scripts, and synthetic screenshots.
- `sandbox/windows/`: maintainer-only, gitignored Windows Sandbox launcher, guest bootstrap, and PowerShell contract test — never committed, no public docs page.
- `scripts/release/`: release note, plan, cut, guard, manifest, and release tests.
- `.github/workflows/`: test, release guard, release cut, and docs deployment automation.
- `examples/`: small example projects, not production plugin runtime.

Do not map `node_modules`, build output, vendor code, caches, or local databases as source modules.
