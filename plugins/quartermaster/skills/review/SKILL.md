---
name: review
description: Judge Quartermaster changes already applied, from the evidence since. Use to decide keep, improve or roll back, or when asked whether a change helped.
---

# Review

For each applied change, read whether anything used it since, then put a verdict to the human only where the evidence says something. A change nobody used is a failed trial. Retiring it is a normal outcome.

## 1. Gather

Call `mcp__quartermaster__proposal` with `operation: list` and keep the proposals in status `applied`, `loaded` or `exercised`. Read each one in full with `operation: list` and its `id` for `expect` and `baseline`, and read its change record in `.claude/quartermaster/changes/C-<n>/change.json` (the `created` time is when it landed).

Call `mcp__quartermaster__evidence` with `since` set to that `created` time for the counts after it landed: skills exercised, command prefixes typed by hand, failures, denials.

Without the tools, read the same files directly and run `node "${CLAUDE_PLUGIN_ROOT}/scripts/mine.mjs" "${CLAUDE_PROJECT_DIR}"` for counts. Its counts cover a whole window, so say when you cannot separate before from after.

## 2. Place each change on the ladder

`applied → loaded → exercised → useful`

- **applied**: the files still hold the change. If someone edited or reverted them since, say so and stop there for that change.
- **loaded**: the skill, rule, plugin or setting is visible in this session.
- **exercised**: used after the change landed. A skill was invoked. A rule's `paths:` were worked in. A permission's command ran without a prompt. A script was run.
- **useful**: the `expect` count moved the right way from its `baseline`, per session or per day.

Move each proposal up the rungs it has reached with `operation: update` and `status`, one rung at a time.

Fewer than three sessions since the change is too early. List it as waiting and ask nothing.

## 3. Ask only where there is evidence

- **Exercised, check moved the right way**: recommend keep.
- **Exercised, check flat or worse**: recommend improve, with one line on what to change, or roll back.
- **Never exercised after enough sessions**: report a failed trial and offer rollback.

Ask each as one question with your recommendation first, worded so "yes" accepts it. Batch closed questions through the question tool, recommended option first.

## 4. Record and act

Add the verdict and the counts it rests on to the proposal body with `operation: update`. Silence is recorded as silence, never as a keep.

- **keep**: move it to `useful` if it is not there yet.
- **improve**: draft one new proposal (usually `skill-improvement`) on the same target. It goes to `/qm` like any other.
- **roll back**: `operation: rollback` with `id`. It restores each recorded file that still holds what the change wrote, and names the files the change created; delete those. A file edited since is left alone and named with the difference: tell the person and undo it by hand. A plugin rollback also needs `claude plugin uninstall <name> --scope <the scope the change recorded>` (`local` in a team project, as outfit installs).

End with one short line per change: id, rung, verdict or "waiting".
