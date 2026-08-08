# Stale LSP diagnostics for deleted agent worktrees

The TypeScript language server retains in-memory projects for Claude Code agent worktrees after those worktrees have been deleted, then continues pushing diagnostics for their old paths into the orchestrator's turns. The resulting blocks look like ordinary TypeScript errors, even though they describe files and directories that no longer exist.

This has already caused a real error to reach our main branch. An agent's worktree carried two genuine TypeScript errors, and the diagnostics reported them correctly before the merge:

```text
✘ [7:10] Module '"../src/lib/suite-resolver.ts"' declares 'resolveSuite' locally, but it is not exported. [2459]
✘ [7:30] An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. [5097]
```

Those were skipped, because by then every diagnostic arriving from an `agent-*` worktree had been false. The merge landed and the typecheck failed. The distinction cannot be made reliably by reading an individual diagnostic block: a stale one and a real one are identical in form.

## Reproduction

1. Start an orchestrator session in a repository with TypeScript diagnostics enabled.
2. Spawn several agents with `isolation: worktree`.
3. Let the agents finish and allow Claude Code to remove their worktrees under `<project>/.claude/worktrees/agent-<taskid>/`.
4. Continue taking turns in the parent session and watch the injected diagnostics. Blocks for the completed agents continue to arrive, naming their removed worktree paths, files, line numbers, and columns.
5. Compare the reported paths with `git worktree list` and `ls .claude/worktrees`. The stale paths are absent.

The agent worktrees in this report are created by Claude Code's `isolation: worktree`. They are not Sidequest worktrees, and nothing in this repository controls their location.

## Measurement

On 2026-08-08, `git worktree list` showed the main worktree, two agent worktrees on disk, and a separate `eigenwise-toolshed-ts-rewrite` worktree. `ls .claude/worktrees` showed exactly these two agent directories:

```text
agent-a336dc6ae0c2239f3
agent-ad1c91f54659d6ca5
```

During the same observation window, the LSP pushed diagnostics naming ten other agent worktrees: `a98a797f876f6203d`, `abaf33db21f635903`, `acdec8359318fdd21`, `a06087ace55cf5cfc`, `a2ea9a95197607002`, `ab833209808c517cb`, `a436ed7b34bb6e900`, `abfe9f1bcd77040fd`, `a6e26dece25243a30`, and `a33f2555865185a13`. None of those directories existed. A file that does not exist cannot have a real TypeScript error, so all ten diagnostic blocks were false positives.

## Impact

While agents are running, the false positives add roughly 1,000 to 2,000 tokens to each orchestrator turn. Context is resent on every turn, so an injected block is paid for once per remaining turn in the session, rather than once. The larger risk is correctness: these blocks carry the same file paths, line numbers, columns, and error presentation as real findings, and they cause valid diagnostics to be discounted.

## Workarounds considered

The documented TypeScript LSP `diagnostics: false` setting is user-scoped and disables diagnostics for every project on the machine. It suppresses real diagnostics along with the stale ones, so it is not an acceptable workaround.

Push diagnostics also ignore `tsconfig` scoping. A path filter on the project side is therefore unavailable. We cannot selectively suppress diagnostics for deleted agent worktrees while retaining the diagnostics needed for the active worktree.

## Requested fixes

1. **Highest priority:** stop pushing diagnostics for paths that no longer exist, or drop the in-memory TypeScript project when its worktree root is removed. This would remove both the false findings and the repeated context cost without disabling valid diagnostics.
2. **Lower priority:** provide a way to relocate the Claude Code agent worktree root, or provide a path-based diagnostics exclusion. Either would give projects a way to isolate or suppress these paths, though lifecycle cleanup in the language server is the preferable fix.
