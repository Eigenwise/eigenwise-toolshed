# Main-branch reconciliation for the TypeScript rewrite

Base: `3e337f8` (Sidequest 2.55.0). The rewrite reconciles every runtime change from main through `f7b71ba` (Sidequest 2.63.0) before the merge. Version assignment remains orchestrator-owned.

The authoritative editing surfaces are `src/lib/*.ts`, `src/bin/*.ts`, `src/hooks/*.ts`, `test/*.test.ts`, and the related skill/docs sources. Generated `lib/*.js`, `bin/*.js`, and `hooks/*.js` are rebuilt outputs.

## Final decisions

| Main change | Final resolution | Primary evidence |
| --- | --- | --- |
| `ask`, `await`, and `needsResponse` | Intentionally removed. Legacy `question` rows remain readable as ordinary comments; the removed CLI commands and MCP tools stay absent. | `test/compatibility.test.ts`, CLI goldens, MCP descriptor fixture |
| 2.56 board-first enforcement and 2.58 distinct-read gate | Ported, then superseded by the approved advisory policy. The first human prompt gets one advisory reminder; inline activity is recorded without tool denial or repeat reminders. Subagents, automation prompts, and routing-disabled boards remain exempt. | `src/hooks/board-first-reminder.ts`, `src/hooks/inline-work-nudge.ts`, `test/hooks.test.ts` |
| 2.57 workforce briefing, direct reasons, and utility allowlist | Ported. SessionStart carries bounded executor guidance. `Explore`, `claude-code-guide`, and `statusline-setup` are the narrow unrouted utility agents. | `src/hooks/session-start.ts`, `src/hooks/force-exec-bypass.ts`, hook byte-budget tests |
| 2.59 direct-claim authority | Ported and tightened. Routed direct claims require the user-granted `direct-ok` label and a meaningful 20-character reason. CLI, MCP, store, and `claimNext` return targeted refusals. | `src/lib/store.ts`, `src/lib/mcp.ts`, `src/lib/refusal-guidance.ts`, `test/claim-effort-guard.test.ts` |
| 2.60 catalog framing | Ported. The manifest, root README, plugin README, and CLI help describe Sidequest as the Toolshed work board and orchestration loop. | plugin/marketplace manifests, `README.md`, `src/bin/sidequest.ts` |
| 2.60/2.61 executor hook matrix | Ported from the corrected final state. Caller identity accepts snake/camel agent id and type fields. Home-delete, near-turn-cap, and terminal-target protection remain bound where safety requires it. | `src/hooks/*.ts`, `test/hooks.test.ts` |
| 2.62 schema 5 and shared-tree artifacts | Ported, then hardened in schema 6. Artifact completion requires structured category `artifactRoots`, one approved path, dispatch-pinned authority and fingerprints, and direct real-path checks. Marker text alone grants nothing. | `src/lib/db.ts`, `src/lib/store.ts`, `src/lib/category-defaults.ts`, `test/artifact-lifecycle.test.ts` |
| 2.63 MCP payload diet | Ported and bounded further. Compact reads are the default; `full:true` restores detail. Category and comment reads expose `total`, `returned`, and `nextCursor`, with compact excerpts marked explicitly. | `src/lib/mcp.ts`, descriptor fixture, `test/mcp.test.ts` |

## Merge resolution contract

1. Keep TypeScript and configuration as the source of truth. Resolve generated JavaScript by rebuilding, never by hand-porting runtime logic into output files.
2. Keep the deleted JavaScript test twins deleted. Tests run from `test/*.test.ts` against committed generated runtime files.
3. Keep `dashboard/index.html` deleted. The Svelte production artifact is `dashboard/dist`.
4. Keep the reconciled README, executor template, skill, orchestration references, category defaults, TypeScript contract, and getting-started prose when main carries an older form of the same behavior.
5. Accept unrelated main changes that do not conflict with the rewrite, including Workbench and codebase-mapper releases.
6. Do not assign the Sidequest 3.0.0 version during the merge ticket. The orchestrator owns the release bump and publication.

## Acceptance

- No unmerged paths or conflict markers.
- Generated runtime matches the authoritative TypeScript sources.
- `npm --prefix plugins/sidequest run test:full` passes, including the isolated performance suite.
- Dashboard check, unit tests, production build, and Playwright suite pass.
- The merge commit descends from the fetched `origin/main` and preserves the ordered rewrite history.
