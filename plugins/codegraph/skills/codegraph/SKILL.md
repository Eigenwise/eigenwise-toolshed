---
name: codegraph
description: Set up, index, query, diagnose, refresh, or recover the Codegraph semantic graph for the current project.
---

Use Codegraph for symbol-level impact, paths, inheritance, module structure, and focused context.

1. Call `codegraph_status` first. It reports `ready`, `missing`, `stale`, `unavailable`, or `error` and always includes snapshot and coverage metadata.
2. For `missing` or `stale`, call `codegraph_index`, then call `codegraph_status` again. Indexing acquires the pinned runtime and creates a fresh snapshot.
3. Use `codegraph_impact`, `codegraph_path`, `codegraph_hierarchy`, `codegraph_modules`, or `codegraph_context` only when status is `ready`.
4. Keep `maxDepth` from 1 through 8, `tokenBudget` from 500 through 16000, and `maxResults` from 1 through 1000. Reuse `nextCursor` only with the same normalized query and snapshot.
5. For `unavailable` or `error`, report the status message. Do not retry indexing in a loop. Check the pinned runtime and project configuration, then run one explicit `codegraph_index` retry after fixing the cause.

The SessionStart hook only reads a bounded metadata pointer. It never downloads a runtime, hashes source, opens the graph database, or builds an index.
