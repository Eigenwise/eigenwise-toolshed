# Patterns

Last Updated: 2026-08-10

- Build from source, run committed output: Sidequest TypeScript under `src/` compiles to `lib/`, `bin/`, and bundled hook files. Runtime manifests point at generated files; release suite discovery is shared through `plugins/sidequest/lib/suite-resolver.js` and re-exported by `scripts/release/lib/suites.mjs`.
- Bounded context projections: Sidequest freezes dispatch contracts and pages large MCP reads with opaque revision-bound handles; callers continue through `context_page` and rerun mutable reads when a revision is stale.
- Snapshot freshness: Codegraph hashes relevant source and project configuration manifests into each graph snapshot, reports `missing`, `stale`, or `ready`, and requires an explicit re-index rather than silently serving stale data.
- Pluggable semantic providers: Codegraph's `SemanticLanguageProviderRegistry` combines each language's project discovery, freshness contributor, runtime acquisition, and extractor, while `extractors/python/pyright-adapter.ts` isolates Pyright's bundled internals from the graph extractor.
- Canonical project identity: Codegraph resolves the repository root and discovered project roots through the same real-path boundary before deriving relative paths, so junctions, symlinks, and Windows short-path aliases cannot create escaping graph or configuration paths.
- Integrity-pinned runtime cache: Codegraph validates package locks, installed-tree and module hashes, then publishes immutable runtime generations behind an ownership-checked lock and `current.json` pointer.
- Bounded graph MCP: Codegraph validates closed input schemas, caps depth, result count, and token budgets, and returns cursors plus snapshot and coverage metadata for impact, path, hierarchy, module, and context queries.
- One store, multiple transports: Sidequest CLI and MCP handlers call the same store functions. Keep lifecycle behavior in the store rather than duplicating it in transports.
- Serialize board mutations: MCP mutation handlers enqueue per-board work before touching state.
- Pull results from the owning root: Workbench's TypeScript tools require a canonical project root, keep one language server per root, and discard TS7 push diagnostics so parent and worktree results cannot bleed into one another.
- Preserve exact ownership: Sidequest reclaims claims and pre-claim dispatch bindings only after confirmed terminal process evidence, keeps unknown owners protected, and checks ownership before forced submission, release, or rejection-history mutation.
- Batch-local Stop responsibility: each plugin deduplicates only its own Stop work using stable inputs; mutable transcript metadata and prompt identifiers do not define responsibility, and stale lock cleanup is generation-bound.
- Atomic gateway updates: Model Gateway stages proxy replacements, renames atomically with rollback, compares serving versions, and defers restart when the listener cannot exit immediately; ephemeral shim ports are reported explicitly.
- Shared-tree artifacts are marker-gated and confined to an approved artifact root; dirty baselines and closeout deltas are checked.
- Hook registration is declarative: events and matchers live in `hooks/hooks.json`; source or generated hook code implements behavior. Codebase-mapper blocks an announced map update until the matching Skill invocation is recorded.
- Generated docs are disposable: `docs/scripts/generate-reference.mjs` owns `docs/src/content/docs/reference/`; edit manifests or the generator instead.
- Stream oversized inputs, never load them: Playbook's miner reads transcripts line by line into bounded detector state and emits aggregates, because one session runs to tens of megabytes. Findings are redacted in one place before anything is written, so no reporting path can forget.
- Poll local APIs: the dashboard uses HTTP JSON endpoints and a 2.5-second polling layer, with no browser-side SQLite or WebSocket dependency.
- Keep project opt-in local: Workbench writes project-local settings, and Observability writes telemetry opt-in state, rather than machine-wide configuration.
- Cross-plugin use is registry-resolved, never imported: a plugin cannot `require` across plugin roots, so Workbench finds Observability through `~/.claude/plugins/installed_plugins.json` and degrades to a no-op when it is absent. Observability uses the same registry to provision project dashboards, and Model Gateway uses it to resolve its stable updater. Small shared helpers are duplicated per plugin instead.
- The Windows Sandbox harness (`sandbox/windows/`, gitignored, maintainer-only) maps only its bootstrap directory read-only and tests isolation and feature flags before launch.
