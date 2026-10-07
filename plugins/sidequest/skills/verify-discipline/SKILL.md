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