# Directory structure

Last Updated: 2026-10-18

- `.claude/`: project settings, live rules, and generated codebase map.
- `.claude-plugin/`: marketplace manifest and published plugin entries.
- `plugins/sidequest/`: board engine, MCP server, CLI, hooks, dashboard, tests, committed build output, and bundled stable executor agents under `agents/`. Pure lifecycle and worktree decisions live in `src/lib/kernel/`; persistence is split under `src/lib/store/`, with matching compiled modules under `lib/`. `scripts/generate-bundled-agents.mjs` derives the packaged agent markdown from `lib/agentsync.js`. `plugins/sidequest/scripts/owned-process-tree.js` and `plugins/sidequest/scripts/owned-phase-supervisor.js` keep test and release subprocess ownership explicit through cleanup.
- `plugins/observability/`: the hooks module (`hooks/register.ts`, `hooks/ledger.ts`, `types/index.d.ts`), the board generator `lib/board.mjs`, the `track` skill, and node tests plus `*.test.ts` for `claude plugin test`.
- `plugins/model-gateway/`: local model gateway CLI, registry hook, skills, and tests; `lib/` holds the shim/worker runtime, the per-model policy table, process supervision, the Windows detached launcher, lifecycle diagnostics, cache-sibling identity checks, bounded owner resolution, and full-width POSIX process probes.
- `plugins/live-rules/`: rule-management skills and prompt/edit/session hooks.
- `plugins/codebase-mapper/`: map-generation/update skills and context injection hooks.
- `plugins/quartermaster/`: workspace setup and resupply skills, updater and health-check skills, transcript miner CLI, and project settings support. Quality scoring delegates to Quality Gate; setup no longer seeds a clean-code baseline.
- `plugins/quality-gate/`: complexity and coverage CLI with `provision`, `turn`, and `inventory` commands, hook modules for persona and turn measurement, skills, shared TypeScript AST core, LCOV/source-hash validation, Python adapter, and regression fixtures/tests. Parser setup is self-provisioned; receipts and measurement configuration are project-local.
- `plugins/test-support/`: JavaScript test scanner shared by Quartermaster, Observability, and Model Gateway tests.
- `docs/`: Astro/Starlight prose, generated reference source, scripts, and synthetic screenshots.
- `sandbox/windows/`: maintainer-only, gitignored Windows Sandbox launcher, guest bootstrap, and PowerShell contract test — never committed, no public docs page.
- `scripts/release/`: release note, plan, cut, finalize, guard, manifest, promotion/publication helpers, and release tests. Protected publication prepares an unprotected release branch, promotes it to `main` through a reviewed PR, then tags the exact merged commit and prints a `main`-to-`develop` sync PR.
- `scripts/quality/`: repository CRAP runner and tests. `crap.mjs --base <revision>` calls the shared Quality Gate AST/V8 core for changed JS/TS bodies, including tests and scripts; explicit `--coverage` reuses supplied V8 data. Built-source matching currently includes function-name and proportional-range projection, so its score report alone does not establish exact compiler/source-map/capture-byte identity. Older Quartermaster re-export files remain compatibility paths; Q3 delegation is unfinished.
- `.github/workflows/`: test, release guard, release cut, and docs deployment automation.
- `examples/`: small example projects, not production plugin runtime.

Do not map `node_modules`, build output, vendor code, caches, or local databases as source modules.
