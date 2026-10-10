---
name: verify-discipline
description: >-
  Run focused verification for a ticket and report what it actually covers. The orchestrator runs the
  one combined full gate after integration. Use when running tests, verifying a change, or choosing a
  test command.
---

# Verify discipline

## Focused checks for executors

1. Find the project's real commands in its documented scripts. Do not guess flags.
2. Pick the closest consumer, regression input, or test that can fail for the behavior you changed.
3. Run that focused check while editing. A nontrivial behavior change needs the smallest meaningful
   runnable regression, not an invented test count.
4. Commit the final scoped candidate, then run the ticket's exact verifier once for the final
   clean-candidate capture and report the behavior and assertion or consumer it exercised. A changed
   candidate needs fresh verification. Do not claim broader coverage ran when it did not.

The orchestrator delivers the wave through the real pinned delivery verifier, then runs one combined
full gate after integration and before versioning. Re-gate a changed tree after rebase. Reuse
assembled-tree proof only under the runtime's exact tree, command, candidate, and capture authority checks. An executor does not run or schedule a
broad suite unless the ticket's contract specifically requires it. A safety-sensitive contract can
require independent review for a contract-named seam the oracle cannot exercise or a required
high-stakes review. Multiple lenses need distinct named risks.

## Measured quality without duplicate suites

Run the project's configured quality gate when the briefing names one and report its per-function rows
honestly: unmeasured bodies stay unmeasured, no averages. Use the existing local quality owner. Where supported, run an early measured complexity scan before
expensive final coverage. Reuse fresh candidate-verifier coverage for the same checked bytes only when
the actual runner supports it. For a configured gate, missing analyzer or coverage stays UNVERIFIED. Never substitute tracked
Lizard/proportional attribution, pin `quality:crap` as authority, or rerun a full suite merely for
already captured compatible coverage. Tooling and reports stay local and uncommitted; untouched legacy functions are outside scope.
Block only on new complexity the change introduced: a touched legacy function whose complexity did not
rise since the base is reported with its number as informational (a LEGACY row), never as a failure and
never as a reason to refactor it.
When none is configured, run the pinned verifier, state once "no quality gate is configured for this
project; Quartermaster setup can add one", and continue. Absence alone never holds, parks or marks work
UNVERIFIED. User rules injected by the host still apply.

Before a long run, freeze its inputs and validate source, coverage and executed/source-map byte identity.
Check native baseline/candidate ownership, clean-state prerequisites, finite deadline and actual
resource fit first. Focused real coverage may run separately from the normal final gate when the local
owner supports it. Keep source fixed throughout an immutable capture; changed inputs need a fresh run.
Report failed checks or missing support honestly, never fabricate passing receipts or weaken standards.
Consume the quality owner's evidence; Quartermaster remains setup-only. Reuse genuine compatible
execution evidence at final review without a duplicate suite merely for reviewer identity.

Heavy commands follow the parent-named shared-resource handoff in `../sidequest/references/orchestration.md`. Without the slot,
continue independent reading/editing/commits, record readiness, and end the turn retaining the claim.

## Keep the result readable

The exit code is the verdict. Redirect long commands to a log and show the status and failures; read
only the relevant log range on failure. Preserve the command's exit code when filtering output.

If no focused form exists, use the smallest documented check that covers the change. Do not make a
full suite an edit loop.

## Quote dynamic-route paths

Quote a path that contains brackets, such as a Next.js dynamic-route segment like `[id]`, when you
pin a verify command. sh and bash glob brackets too, not just zsh; every shell risks it. The shells
differ only in the no-match case: the capture wrapper no longer aborts on an unquoted one under
zsh, and sh/bash never aborted either way. The real risk is bigger than a missing-match abort and
it applies everywhere: an unquoted `[id]`-shaped path can silently expand to a DIFFERENT path that
happens to match one character from the class, on any of these shells.

The right fix depends on what the token is and on which tool receives it:

- A literal bracket path (`src/app/[id]/a.test.js`): quote it for a tool that takes literal paths
  (`tsc`, `pytest`). For a runner that globs its own arguments (`node --test`), quote it AND escape
  each `[` as `[[]`, giving `"src/app/[[]id]/a.test.js"`. Quoting alone is backwards there: the
  runner reads the quoted `[id]` as a character class, so it runs 0 tests (or a sibling path that
  does match) and still exits 0. A backslash escape (`\[id\]`) fails with "Could not find".
- An intended glob (`*`, `?`, as in `src/**/*.test.js`): quote it for a runner that globs its own
  arguments, so the shell does not expand it first. Leave it unquoted for a tool that takes literal
  paths (`tsc`, `pytest`) and relies on the shell to expand it; a quoted glob there is a hard error
  (`tsc` exits 2 with TS6053).
- A bracket segment plus a glob (`app/[id]/*.test.js`): escape the bracket and keep the glob. For a
  runner that globs its own arguments (`node --test`), quote it with each `[` written as `[[]`,
  giving `"app/[[]id]/*.test.js"`. Quoting the bare `[id]` form is the false green: the runner reads
  `[id]` as a character class, matches zero tests, and exits 0. For a tool that takes literal paths
  (`tsc`, `pytest`), leave the glob unquoted so the shell expands it, and backslash-escape each
  bracket (`app/\[id\]/*.test.js`).