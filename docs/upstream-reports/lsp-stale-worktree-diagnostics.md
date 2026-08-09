# Foreign and stale LSP diagnostics enter the parent model context

Claude Code retains language-server diagnostics for subagent worktrees and injects them into the parent session as native `attachment.type: "diagnostics"` payloads. The payloads include live foreign worktrees and deleted worktrees. They reach the model before any project hook can inspect or filter them.

This has already caused a real error to reach our main branch. An agent's live worktree carried two genuine TypeScript errors before integration:

```text
✘ [7:10] Module '"../src/lib/suite-resolver.ts"' declares 'resolveSuite' locally, but it is not exported. [2459]
✘ [7:30] An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled. [5097]
```

Those errors were discounted after repeated stale worktree diagnostics trained the parent to treat the whole channel as noise.

## Native owner and earliest filter seam

Claude Code 2.1.225 owns the full delivery path. Inspection of `claude.exe` found these version-specific byte offsets:

- `263917479`: the `textDocument/publishDiagnostics` handler normalizes the URI with `x2_(u)` and calls the diagnostic registry `QNd`.
- `263840033`: registry delivery caps output at 10 diagnostics per file and 30 total.
- `270352391`: `JlS` converts pending registry sets into `{ type: "diagnostics", files, ... }` attachments.
- `269963639`: the attachment renderer calls `sanitizeDiagnosticFiles` and `formatDiagnosticsBlock`, then injects the result as meta content.
- `263834156`: rendered diagnostic text is capped at 4,000 JavaScript characters.

The earliest correct filter is in the native `textDocument/publishDiagnostics` handler, after URI normalization and before `QNd`. The receiving agent's checkout root must be the identity boundary. Repository root is too broad because every linked worktree shares it.

No Claude Code hook runs at this boundary. Sidequest cannot read or rewrite the pending attachment, remove a language-server registry entry, or alter the model request. Its `SessionStart` and `SubagentStart` hooks run before the later diagnostics exist. Mutating another tool's output or patching Claude Code requests would be an unsupported downstream workaround.

## Reproduction

1. Start a parent Claude Code session in a TypeScript repository with diagnostics enabled.
2. Spawn at least two subagents with `isolation: "worktree"`.
3. In one subagent, open an inferred-project TypeScript file outside the repository's `tsconfig.json` include set containing:

   ```ts
   const filesystem = require("node:fs");
   ```

   With TypeScript 5.9.3 this reproduced diagnostics 2591, 6133, and 80005 when the inferred project lacked the repository's Node types and module configuration.
4. Keep one agent worktree live. Let another agent finish so Claude Code removes its worktree.
5. Continue taking parent turns. Inspect the transcript JSONL for nested objects whose `type` is `diagnostics`.
6. Compare every diagnostic file path with `git worktree list` and the filesystem. The parent receives diagnostics for both the live foreign checkout and removed paths.
7. Repeat an otherwise identical turn. Individual stale diagnostics recur even when the complete attachment differs.

The same result occurs with Sidequest's `WorktreeCreate` hook, which places worktrees under `~/.claude/sidequest/worktrees/` instead of `<project>/.claude/worktrees/`. External placement is therefore a negative control, not a fix.

## Measurements

The parent transcript measured through 2026-08-09T06:46:49Z contained:

| Measure | Foreign embedded worktrees |
| --- | ---: |
| Native diagnostic attachments | 454 |
| Unique following model requests | 451 |
| Diagnostics | 9,927 |
| Unique referenced paths | 454 |
| Referenced paths absent at measurement time | 454 |
| Raw attachment bytes | 2,564,387 |
| Reconstructed rendered UTF-8 bytes | 1,340,466 |
| Approximate rendered tokens at 4 bytes/token | 335,117 |
| Reconstructed rendered characters | 1,321,244 |
| Blocks truncated by the native formatter | 152 |
| Maximum repetition of one identical diagnostic | 43 |

The 451 following model requests reported 96,093,598 cache-read tokens. That is observed downstream usage, not a causal token allocation to diagnostics.

A second live snapshot from 2026-08-09T07:00:00Z through 07:11:04Z tested the existing external-worktree counterweight. Six diagnostic attachments still reached the parent, containing 180 diagnostics and 39,991 raw UTF-8 bytes, approximately 9,998 tokens at 4 bytes per token. Every attachment referenced external `~/.claude/sidequest/worktrees/.../agent-*` paths. None referenced the parent checkout. External placement suppressed 0 of 6 observed foreign attachments.

There is no supported Toolshed-side after state to report. The measured counterweight produced no reduction, and project hooks cannot reach the native seam. An upstream build with the filter below can run the same reproduction for the actual before/after comparison.

## Required behavior

At `textDocument/publishDiagnostics`, after URI normalization and before registry insertion:

1. Resolve the receiving agent's exact checkout root.
2. Keep diagnostics whose normalized path is inside that checkout.
3. Drop diagnostics under another agent checkout before they become pending attachments.
4. Remove registry records whose worktree root no longer exists or has been released.
5. Deduplicate identical normalized diagnostics by checkout, file, range, code, severity, and message until the publisher reports a changed set.
6. If the parent can act on a submitted worktree it is about to integrate, allow one explicit bounded summary naming that checkout and its error count. Do not inject the full foreign diagnostics.

The filter must preserve error-severity diagnostics for the parent's own checkout. Whole-server `diagnostics: false` and `claude --bare` both fail that requirement.

## Acceptance measurement

Run the reproduction once on Claude Code 2.1.225 and once on the candidate build, then count native diagnostic attachments, rendered UTF-8 bytes, and approximate tokens from the same number of parent turns.

The candidate passes when:

- deleted-worktree attachments fall to zero;
- unrelated live-worktree attachments fall to zero;
- repeating an unchanged publication adds zero duplicate attachments;
- a deliberate parent-checkout TypeScript error still produces one parent diagnostic attachment;
- an actionable submitted-worktree case produces at most one bounded summary and no foreign diagnostic payload.
