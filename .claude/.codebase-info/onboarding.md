# Onboarding

Last Updated: 2026-08-10

1. Read `README.md`, `CLAUDE.md`, and this map index. `CLAUDE.md` contains repository rules for generated docs, prose docs, and synthetic screenshots.
2. Identify the surface: Sidequest engine/dashboard, Workbench, Observability, Model Gateway, Live-rules, Codebase Mapper, Codegraph, Playbook, shared test support, docs, the local-only Windows Sandbox harness, or release automation. Start with [entry-points](entry-points.md) and [modules](modules.md).
3. For Sidequest runtime work, read `plugins/sidequest/package.json`, `plugins/sidequest/scripts/build.mjs`, then the relevant source module. Remember manifests load committed `lib/`, `bin/`, and `hooks/` output.
4. For Sidequest dispatch lifecycle work, start with `plugins/sidequest/src/lib/agentsync.ts` and `plugins/sidequest/src/lib/context-packet.ts`; frozen briefing snapshots are continued with the `context_page` MCP tool, and zero-scope read-only dispatches omit `sharedTree`.
5. For Model Gateway work, start at `plugins/model-gateway/README.md` and `plugins/model-gateway/bin/model-gateway.js`; use `doctor` and readiness/catalog checks when verifying local setup. Setup may defer proxy restart when the listener cannot exit immediately, and reports serving state.
6. Run the narrow package check or test command documented in that package before broad suites. Sidequest scripts include `typecheck`, `build:check`, `test:files`, `test:full`, and `test:perf`; dashboard has `check`, `test`, `build`, and `e2e`; Workbench setup validates the Sidequest registry, derives routing profiles, requires an explicit worktree-isolation choice, and applies profiles/worktrees in Phase 4. Workbench's pull-only TypeScript tools require a project root and use native TypeScript 7 when available or `typescript-language-server` for TypeScript 5; its update skill uses the stable Model Gateway updater. Docs uses `npm --prefix docs run check`; the sandbox contract uses `pwsh -NoProfile -File sandbox/windows/Test-ToolshedSandbox.ps1`.
7. For Codegraph work, start at `plugins/codegraph/package.json`, `plugins/codegraph/src/lib/service.ts`, and `plugins/codegraph/src/lib/runtime.ts`; run `npm run test:full` from `plugins/codegraph/` and use `codegraph_status` before graph queries.
8. For user-facing changes, update affected prose docs in `docs/src/content/docs/` or file the linked docs-writing ticket. Never hand-edit generated reference pages.
9. For plugin changes, update both plugin manifest and marketplace version fields through the release process. See [release and publishing](release-publishing.md).

Keep `.claude/.codebase-info/.map-state.json` last when refreshing this map.
