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
4. When the related edits are current, run the ticket's exact verifier and report the behavior and
   assertion or consumer it exercised. Do not claim broader coverage ran when it did not.

The orchestrator runs one combined full gate after integration. An executor does not run or schedule a
broad suite unless the ticket's contract specifically requires it. A safety-sensitive contract can
require independent review when it names the untested seam that needs scrutiny.

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