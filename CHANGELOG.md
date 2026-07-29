# Changelog

One section per release window. Each window is a single commit on `main` that moves every
changed plugin at once, tagged `v<marketplace version>`, with matching per-plugin changelogs
under `plugins/<name>/CHANGELOG.md`.

Releases before v3.208.0 predate this file and are not backfilled; `git log` is the record for
those. Entries are generated from `.release/unreleased/*.md` by `scripts/release/cut.mjs`, so
nothing here is hand-written.

## v3.283.0 (2026-07-29)

### sidequest 3.40.0 → 3.40.1

#### Fixes

- Files-only ticket updates no longer emit stale unknown-ref warnings (SQ-1018) [`fb4387e`](https://github.com/Eigenwise/eigenwise-toolshed/commit/fb4387ecc03becef7fbee9d4ee40a7b82c4c46b9)
  Reference warnings are derived only from the fields an update actually changed, so approving scope no longer resurfaces unknown refs quoted in older ticket text.

## v3.282.0 (2026-07-29)

### sidequest 3.39.1 → 3.40.0

#### Features

- Dispatch refuses GPT-routed tickets when Codex is down (SQ-1025) [`c3c66b8`](https://github.com/Eigenwise/eigenwise-toolshed/commit/c3c66b8bec14ed1072c238616fe2a83cee8f234c)
  prepareDispatch requires live provider readiness before preparing a token: a dead Codex backend refuses the dispatch with recovery steps, same-provider fallback records fallbackReason, and silent cross-provider substitution to a Claude model is no longer possible.

## v3.281.0 (2026-07-29)

### workbench 0.70.1 → 0.70.2

#### Fixes

- Updater migrates installed codex-gateway after the rename (SQ-1022) [`dd430c5`](https://github.com/Eigenwise/eigenwise-toolshed/commit/dd430c56ed29731e16586919e81fe0e8d7e782c0)
  update-toolshed recognizes a recorded codex-gateway install, migrates it to model-gateway at the same scope, and documents the manual path.

## v3.280.0 (2026-07-29)

### sidequest 3.39.0 → 3.39.1

#### Fixes

- Stop-time board reminder now reaches the agent (SQ-1031) [`8f22a2d`](https://github.com/Eigenwise/eigenwise-toolshed/commit/8f22a2d04c17064e76d273e80a9451720b6ab4ab)
  The reconciliation reminder emits Stop additionalContext the model acts on, guarded by stop_hook_active and a per-state ceiling, alongside the user-visible line.
- Helpers no longer cite the ticket's own strings as evidence (SQ-1032) [`1b77c02`](https://github.com/Eigenwise/eigenwise-toolshed/commit/1b77c024faa9bb980556bf06a0a7d9d8e9cd3135)
  Helper searches resolving into the current session's own transcripts are reported as self-reference, and executor guidance names the quoted-evidence trap.

## v3.279.0 (2026-07-29)

### sidequest 3.38.8 → 3.39.0

#### Features

- Integrate runs the recorded verify command and refuses done on failure (SQ-1035) [`46c7191`](https://github.com/Eigenwise/eigenwise-toolshed/commit/46c7191d65dded23b5f7e3e92d269ea6367749d3)
  Integration now machine-checks the submission's verify command against the delivered result: failure or timeout delivers but refuses done with exit code and output tail; skipping requires an explicit recorded flag.

## v3.278.0 (2026-07-29)

### sidequest 3.38.7 → 3.38.8

#### Fixes

- Dispatch worktrees honor integrationBranch (SQ-1034) [`4e68f71`](https://github.com/Eigenwise/eigenwise-toolshed/commit/4e68f71e41fe5a9e0945dacbba78f59843ade144)
  An explicit integrationBranch now sets the executor worktree base and the delivery target; an unresolvable branch refuses the dispatch with the ref named instead of silently substituting the default base.

## v3.277.0 (2026-07-29)

### sidequest 3.38.6 → 3.38.7

#### Fixes

- Shared-tree gate no longer blocks done over unrelated dirty files (SQ-1033) [`a3b276b`](https://github.com/Eigenwise/eigenwise-toolshed/commit/a3b276ba731085dd40938854bcd93b9f7ade06af)
  The done-path dirty check is scoped to the ticket's own files; bystander changes elsewhere in a shared checkout no longer strand finished, committed work in doing.

## v3.276.0 (2026-07-29)

### sidequest 3.38.5 → 3.38.6

#### Fixes

- Terminal executors cannot write after resurrection (SQ-1030) [`172817d`](https://github.com/Eigenwise/eigenwise-toolshed/commit/172817dcc7057d3213ed3f9a0a42095db046aace)
  The worktree-isolation guard used to drop its record on submit/release, so a resumed executor fell through to the shared checkout. It now fails closed: a terminal ticket, a missing dispatch record, or a cross-project target all refuse the write.

## v3.275.0 (2026-07-29)

### sidequest 3.38.4 → 3.38.5

#### Fixes

- Constrain executor sub-delegation (SQ-1029) [`661f473`](https://github.com/Eigenwise/eigenwise-toolshed/commit/661f473538e358f1079caa53dec2bee380294d17)
  Executor helper spawns are limited to an allowlist, forced into the background so they stay steerable, denied a default model, and no longer isolated into a worktree that cannot see the parent's work.

## v3.274.0 (2026-07-29)

### model-gateway 0.39.0 → 0.40.0

#### Features

- Gateway: one Codex readiness predicate shared by ensure, doctor, and consumers (SQ-1024) [`d636ec5`](https://github.com/Eigenwise/eigenwise-toolshed/commit/d636ec5d2d554403ae48ac22b941ddad1eb45939)
  Adds an event-driven readiness signal covering binary, proxy, auth, shim, serving version, and a retained upstream-blocked state; ensure and doctor now read one predicate instead of re-deriving liveness.

## v3.273.0 (2026-07-29)

### sidequest 3.38.3 → 3.38.4

#### Fixes

- Sidequest blocks sub-delegation from generic subagents (SQ-1027) [`2ce5843`](https://github.com/Eigenwise/eigenwise-toolshed/commit/2ce5843c92664e6f64e5dc203d216ead06f9fa24)
  The generic-Agent guard now keys on spawn depth, so an already-running subagent can sub-delegate; the main-loop deny is unchanged.

## v3.272.0 (2026-07-29)

### model-gateway 0.38.1 → 0.39.0

#### Features

- Streamline gateway model IDs (SQ-1004) [`e675027`](https://github.com/Eigenwise/eigenwise-toolshed/commit/e675027)
  Advertises claude-gpt-* and claude-grok-4.5 while preserving legacy IDs and existing Sidequest catalog slugs.

### sidequest 3.38.2 → 3.38.3

#### Fixes

- Streamline gateway model IDs (SQ-1004) [`e675027`](https://github.com/Eigenwise/eigenwise-toolshed/commit/e675027)
  Advertises claude-gpt-* and claude-grok-4.5 while preserving legacy IDs and existing Sidequest catalog slugs.

### workbench 0.70.0 → 0.70.1

#### Fixes

- Streamline gateway model IDs (SQ-1004) [`e675027`](https://github.com/Eigenwise/eigenwise-toolshed/commit/e675027)
  Advertises claude-gpt-* and claude-grok-4.5 while preserving legacy IDs and existing Sidequest catalog slugs.

## v3.271.0 (2026-07-29)

### sidequest 3.38.1 → 3.38.2

#### Fixes

- Warn when a write-scope ticket is filed with no declared files (SQ-1009) [`8ae8f5d`](https://github.com/Eigenwise/eigenwise-toolshed/commit/8ae8f5d757b6f1bc7e07cb289c3c9a9a67378a29)
- Releasing a ticket must clear its submission so redispatch works (SQ-1010) [`c778141`](https://github.com/Eigenwise/eigenwise-toolshed/commit/c778141508f317a72530b3b0fd7945cbaaa4e553)
- Give tickets a plan document: large storage, on-demand read, never inlined (SQ-1015) [`2dc8ae5`](https://github.com/Eigenwise/eigenwise-toolshed/commit/2dc8ae5ea45bb7221f6e6e0a3372f6bdc6378914)
- Dispatch must refuse before spawning when the target project has no Sidequest MCP install (SQ-1017) [`641ceb3`](https://github.com/Eigenwise/eigenwise-toolshed/commit/641ceb36600bf92c32ed127b2667d3ff5b195c78)

## v3.270.0 (2026-07-29)

### sidequest 3.38.0 → 3.38.1

#### Fixes

- Executor stops after Monitor timeout while its required background job keeps running (SQ-1016) [`41459b5`](https://github.com/Eigenwise/eigenwise-toolshed/commit/41459b5b2504e302db3b917c51f874bc3e0722d4)

## v3.269.0 (2026-07-28)

### sidequest 3.37.1 → 3.38.0

#### Features

- Partial submissions can no longer report themselves ready for integration (SQ-1008) [`0b2605d`](https://github.com/Eigenwise/eigenwise-toolshed/commit/0b2605d3d81e9f9b39fbcc47114af512c20bb8ea)

#### Fixes

- Hook byte-budget tests no longer measure the repo's own path (SQ-1011) [`7c1bdc0`](https://github.com/Eigenwise/eigenwise-toolshed/commit/7c1bdc0c23b515d087366b40d4c1755e67a522c9)
- The pinned test plugin root is per-checkout, so concurrent worktrees stop sharing one junction (SQ-1013) [`e98b876`](https://github.com/Eigenwise/eigenwise-toolshed/commit/e98b876ef10210a99e83cf22f60f5e1683b6a401)

## v3.268.0 (2026-07-28)

### model-gateway 0.38.0 → 0.38.1

#### Fixes

- Docs moved to the model-gateway name, with redirects for the old slugs (SQ-1002) [`2cc5824`](https://github.com/Eigenwise/eigenwise-toolshed/commit/2cc5824c3b69835343df94d285949014b7ce47c7)
- The CLI no longer tells users to run a slash command that was renamed away (SQ-1007) [`d021499`](https://github.com/Eigenwise/eigenwise-toolshed/commit/d0214990710a76e0844bc3d38e6f30e06f133edd)

## v3.267.0 (2026-07-28)

### model-gateway 0.37.0 → 0.38.0

#### Features

- Renamed the codex-gateway plugin to model-gateway (SQ-1001) [`19e36c0`](https://github.com/Eigenwise/eigenwise-toolshed/commit/19e36c0987cad1b1b341eb5d5f2cfa154de68885)

## v3.266.0 (2026-07-28)

### codex-gateway 0.36.3 → 0.37.0

#### Features

- WebSearch works on Grok via its native server-side web_search tool (SQ-1000) [`6e004bd`](https://github.com/Eigenwise/eigenwise-toolshed/commit/6e004bdddf741b5be8e902cc45e9d4e0e3f1242a)

## v3.265.0 (2026-07-28)

### codex-gateway 0.36.2 → 0.36.3

#### Fixes

- Grok Build no longer sends reasoning effort it cannot accept (SQ-998) [`e7babd4`](https://github.com/Eigenwise/eigenwise-toolshed/commit/e7babd409150f3a5f3d00eea00bdc04b92adbb25)

## v3.264.0 (2026-07-28)

### codex-gateway 0.36.1 → 0.36.2

#### Fixes

- Fix Grok streaming tool calls losing their name and call id (SQ-995) [`679c65b`](https://github.com/Eigenwise/eigenwise-toolshed/commit/679c65bc3d20f5679d1d4c7b0e448612dc0f78e2)
- Enforce a single gateway supervisor and report the serving version (SQ-996) [`52e6b8f`](https://github.com/Eigenwise/eigenwise-toolshed/commit/52e6b8f8be8e89a657eb2960f2b8826dc927ee48)
- Stop gateway-usage temp-dir teardown flaking on Windows (SQ-997) [`1b838a9`](https://github.com/Eigenwise/eigenwise-toolshed/commit/1b838a9be70ff5c945e108b30838083ee3f5920e)

## v3.263.0 (2026-07-28)

### codex-gateway 0.36.0 → 0.36.1

#### Fixes

- Fix Grok 422 on transcripts containing tool calls (SQ-994) [`29afd90`](https://github.com/Eigenwise/eigenwise-toolshed/commit/29afd9017ef22ef2bbf6e4da43aa1f0fa5018861)

## v3.262.0 (2026-07-28)

### codex-gateway 0.35.1 → 0.36.0

#### Features

- Grok subscription backend via cli-chat-proxy.grok.com (SQ-992) [`41e98e5`](https://github.com/Eigenwise/eigenwise-toolshed/commit/41e98e57dee92ef2ed550d3e815eb4ff880e5bab)

## v3.261.0 (2026-07-28)

### sidequest 3.37.0 → 3.37.1

#### Fixes

- Worktree sweep bounds its orphan-branch scan (SQ-990) [`cf04a72`](https://github.com/Eigenwise/eigenwise-toolshed/commit/cf04a72)

## v3.260.0 (2026-07-28)

### sidequest 3.36.0 → 3.37.0

#### Features

- SessionStart no longer blocks on worktree sweep (SQ-988) [`ebf9c7a`](https://github.com/Eigenwise/eigenwise-toolshed/commit/ebf9c7a)

## v3.259.0 (2026-07-28)

### sidequest 3.35.1 → 3.36.0

#### Features

- Integrator delivery modes: merge, replay, apply (SQ-980) [`dcbe1a7`](https://github.com/Eigenwise/eigenwise-toolshed/commit/dcbe1a7)

### workbench 0.69.2 → 0.70.0

#### Features

- Honest dispatch cost: codex-auto exclusion and gateway cost panel (SQ-984) [`dcbe1a7`](https://github.com/Eigenwise/eigenwise-toolshed/commit/dcbe1a7)

## v3.258.0 (2026-07-28)

### workbench 0.69.1 → 0.69.2

#### Fixes

- otel-collector sample config includes gateway logs (SQ-985) [`4b030a9`](https://github.com/Eigenwise/eigenwise-toolshed/commit/4b030a9)

## v3.257.0 (2026-07-28)

### workbench 0.69.0 → 0.69.1

#### Fixes

- Haiku 4.5 priced in the usage dashboard (SQ-981) [`9f763e6`](https://github.com/Eigenwise/eigenwise-toolshed/commit/9f763e6)

## v3.256.0 (2026-07-28)

### sidequest 3.35.0 → 3.35.1

#### Fixes

- Stronger agent-teams usage directive (SQ-979) [`7b99395`](https://github.com/Eigenwise/eigenwise-toolshed/commit/7b99395)

## v3.255.0 (2026-07-28)

### sidequest 3.34.0 → 3.35.0

#### Features

- Direct-ok ceremony replaced by inline-safe allowlist (SQ-976) [`02bd413`](https://github.com/Eigenwise/eigenwise-toolshed/commit/02bd413)

## v3.254.0 (2026-07-28)

### sidequest 3.33.0 → 3.34.0

#### Features

- Submission rejection preserves verified work: quarantine ref + needs-rebase recovery; parent-history merge commits no longer invalidate ranges (dispatch baseline) (SQ-971) [`3448b9e`](https://github.com/Eigenwise/eigenwise-toolshed/commit/3448b9ee9c16a6be001557005edec3dea6d67915)

## v3.253.0 (2026-07-28)

### sidequest 3.32.0 → 3.33.0

#### Features

- Parallel-first orchestration: maximize the ready set; same-file overlap is assessed, never auto-serialized; teammate shape preferred when agent teams is on (SQ-973) [`c39e1f1`](https://github.com/Eigenwise/eigenwise-toolshed/commit/c39e1f1f19c464f99697a857ff7b2c72c6cef6cf)

### workbench 0.68.1 → 0.69.0

#### Features

- init-workspace enables the agent-teams flag per project; workbench-doctor flags global-env masking (SQ-972) [`c39e1f1`](https://github.com/Eigenwise/eigenwise-toolshed/commit/c39e1f1f19c464f99697a857ff7b2c72c6cef6cf)

## v3.252.0 (2026-07-28)

### sidequest 3.31.0 → 3.32.0

#### Features

- Guard refusals and guidance close the reroute: blocked steps gate dependent actions (PR/merge/ship) (SQ-968) [`34c20c7`](https://github.com/Eigenwise/eigenwise-toolshed/commit/34c20c79a5c7f89f685394fb7c1064d3a81c5666)

## v3.251.0 (2026-07-28)

### sidequest 3.30.0 → 3.31.0

#### Features

- Shared-tree artifact dispatches work again: artifact-mode briefing and executor shape reconciled with scope hardening (SQ-966) [`c5e4479`](https://github.com/Eigenwise/eigenwise-toolshed/commit/c5e4479732a4cb1456953a1c8c7acb4285d62c8c)

## v3.250.0 (2026-07-28)

### sidequest 3.29.0 → 3.30.0

#### Features

- Board-config generatedPairs: declared sources auto-pair their tracked compiled outputs across all scope gates (SQ-958) [`190684d`](https://github.com/Eigenwise/eigenwise-toolshed/commit/190684dfa9eb964d67a9dd7eef9e18c1ac926c3c)

## v3.249.0 (2026-07-28)

### sidequest 3.28.0 → 3.29.0

#### Features

- Done closures inspect the full dispatch-base delta; PreToolUse guard blocks raw git commit in shared-tree dispatches (US-28 part C) (SQ-956) [`5826e26`](https://github.com/Eigenwise/eigenwise-toolshed/commit/5826e26456d5af444dbcb671b3ef209fa94fb508)
- Helper subagent writes bound to the parent ticket's scope (US-28 part D) (SQ-957) [`7742fb5`](https://github.com/Eigenwise/eigenwise-toolshed/commit/7742fb54b0ab1bcb3a29f254bedcaf967c22aee0)

#### Fixes

- Story log: orchestrator no-ref append works; refusal messages carry real refs (SQ-964) [`7742fb5`](https://github.com/Eigenwise/eigenwise-toolshed/commit/7742fb54b0ab1bcb3a29f254bedcaf967c22aee0)

## v3.248.0 (2026-07-28)

### sidequest 3.27.0 → 3.28.0

#### Features

- Fail-closed scope validation at queue admission and integration closure (US-28 scope hardening, part B) (SQ-955) [`915c7e1`](https://github.com/Eigenwise/eigenwise-toolshed/commit/915c7e10e9c2d9d6136ce48fd6d8db0e654dd3fa)
- End-of-turn board reconciliation reminder hook, silent on quiet boards (SQ-963) [`915c7e1`](https://github.com/Eigenwise/eigenwise-toolshed/commit/915c7e10e9c2d9d6136ce48fd6d8db0e654dd3fa)

## v3.247.0 (2026-07-28)

### sidequest 3.26.5 → 3.27.0

#### Features

- Story decision log: executor-appendable shared memory per story, story-first wave orchestration, scope-expansion control-plane gate (US-27) [`619e96b`](https://github.com/Eigenwise/eigenwise-toolshed/commit/619e96bd149c8f1ce517ba5cd29aa8531cee7f91)

### workbench 0.68.0 → 0.68.1

#### Fixes

- retro files an improvement story instead of applying fix lists inline when a board is active (SQ-951) [`619e96b`](https://github.com/Eigenwise/eigenwise-toolshed/commit/619e96bd149c8f1ce517ba5cd29aa8531cee7f91)

## v3.246.0 (2026-07-27)

### sidequest 3.26.4 → 3.26.5

#### Fixes

- Executor briefings: mid-task cheap sub-work goes to explicitly cheap subagents, never gateway web research (SQ-945) [`678da44`](https://github.com/Eigenwise/eigenwise-toolshed/commit/678da440f729c2dd3906a00e75f910da4ef90347)

## v3.245.0 (2026-07-27)

### workbench 0.67.0 → 0.68.0

#### Features

- Managed LGTM container supports telemetry deletes: Prometheus admin API and Loki delete endpoint enabled (SQ-942) [`b24b5a7`](https://github.com/Eigenwise/eigenwise-toolshed/commit/b24b5a75108293aa2b9c3ffc0a778d9346bf40a5)

## v3.244.0 (2026-07-27)

### sidequest 3.26.3 → 3.26.4

#### Fixes

- Bookend supervision: two touches per ticket, integrate by oracle, never by reading the diff (SQ-944) [`9992e18`](https://github.com/Eigenwise/eigenwise-toolshed/commit/9992e18c9a48d6b9fad9a2272bc76c003433a1df)

## v3.243.0 (2026-07-27)

### sidequest 3.26.2 → 3.26.3

#### Fixes

- Upfront backlog before first dispatch; evidence-gated unpinnable-contract branch (SQ-943) [`0b598be`](https://github.com/Eigenwise/eigenwise-toolshed/commit/0b598be477a6619a87cbb539ed90f384c2a02064)

## v3.242.0 (2026-07-27)

### sidequest 3.26.1 → 3.26.2

#### Fixes

- Solo-fit gate v2: never-inline invariant, contract-first parallel waves, restored economy guards (SQ-941) [`1849c79`](https://github.com/Eigenwise/eigenwise-toolshed/commit/1849c7952febb11daf75bbe78b236c5c36c9e9ef)

## v3.241.0 (2026-07-27)

### sidequest 3.26.0 → 3.26.1

#### Fixes

- Right-size ticket decomposition: solo-fit gate, deterministic-verify audit skip, wave-batched integration (SQ-938) [`d0ca9d9`](https://github.com/Eigenwise/eigenwise-toolshed/commit/d0ca9d958c556debc49eff898a95a3947e615908)
