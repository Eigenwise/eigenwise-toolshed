# Onboarding

Last Updated: 2026-08-20

1. Read `README.md`, `CLAUDE.md`, and this map index. `CLAUDE.md` contains repository rules for generated docs, prose docs, and synthetic screenshots.
2. Identify the surface: Sidequest engine/dashboard, Quartermaster, Observability, Model Gateway, Live-rules, Codebase Mapper, shared test support, docs, the local-only Windows Sandbox harness, or release automation. Start with [entry-points](entry-points.md) and [modules](modules.md).
3. For Sidequest runtime work, read `plugins/sidequest/package.json`, `plugins/sidequest/scripts/build.mjs`, then the relevant source module. Remember manifests load committed `lib/`, `bin/`, and `hooks/` output.
4. For Sidequest lifecycle work, start with `plugins/sidequest/src/lib/kernel/`, including `kernel/review-binding.ts`, then follow the adapter into `store/dispatch.ts`, `store/submissions.ts`, or `worktrees.ts`. `prepared-dispatch.ts` canonicalizes prepared executor identity, and `source-revision-capability.ts` binds immutable non-Git candidates to their dispatch baseline. Frozen briefing snapshots are continued with the `context_page` MCP tool.
5. For Model Gateway work, start at `plugins/model-gateway/README.md` and `plugins/model-gateway/bin/model-gateway.js`; use `doctor` and readiness/catalog checks when verifying local setup. Sidequest consumes only fresh schema-4 catalogs whose provider readiness is true. Shared-proxy recovery belongs in `lib/process-supervision.js` and `lib/request-worker.js`, not in project-specific startup hooks.
6. Run the narrow package check or test command documented in that package before broad suites. Sidequest scripts include `typecheck`, `build:check`, `test:files`, `test:full`, and `test:perf`; dashboard has `check`, `test`, `build`, and `e2e`; Quartermaster setup validates the Sidequest registry, derives routing profiles, requires an explicit worktree-isolation choice, and applies profiles/worktrees in Phase 4, and its update skill uses the stable Model Gateway updater. Docs uses `npm --prefix docs run check`, and `npm --prefix docs run build` on top of it whenever a page or sidebar entry is added, renamed, or removed, because `check` passes on a sidebar slug whose page no longer exists; the sandbox contract uses `pwsh -NoProfile -File sandbox/windows/Test-ToolshedSandbox.ps1`.
8. For user-facing changes, update affected prose docs in `docs/src/content/docs/` or file the linked docs-writing ticket. Never hand-edit generated reference pages.
9. For plugin changes, update both plugin manifest and marketplace version fields through the release process. See [release and publishing](release-publishing.md).

Keep `.claude/.codebase-info/.map-state.json` last when refreshing this map.
