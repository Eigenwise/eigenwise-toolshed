---
name: apply
description: Apply one accepted Quartermaster proposal by id, record its prior bytes first, run its check, and report the rollback.
argument-hint: "<proposal id, e.g. P-0007>"
disable-model-invocation: true
---

# Apply

Apply exactly one proposal: the id in the argument. No id means ask for one and stop.

All calls below go to `mcp__quartermaster__proposal`. When that tool is missing (the mod is not loaded), say so and do each step by hand on the files under `.claude/quartermaster/`.

## 1. Load and check the status

Read it with `operation: list` and its `id`, which returns the whole proposal (or open `.claude/quartermaster/proposals/<id>.md`).

Refuse unless its status is `accepted`. Say the status you saw and the next move in one line, for example "P-0007 is `draft`. Approve it in `/quartermaster` first." Never apply any other status, and never treat this request itself as the approval.

## 2. Record before writing

`operation: record-change` with `id` and `files`: every file the change will touch, including ones it creates. It saves each file's prior bytes under `.claude/quartermaster/changes/C-<n>/` and notes which files are new. Do this BEFORE any write. If it fails, stop and report: an unrecorded change cannot be rolled back.

By hand: copy each existing target to `changes/C-<n>/prior/<index>.txt` and write `changes/C-<n>/change.json` with `id`, `proposal`, `created`, and `files` (each `path`, `existed`, and `prior` when it existed).

A plugin install touches `.claude/settings.json` (or `settings.local.json` for local scope). Record that file.

## 3. Make exactly the change

Make the diff or run the command in the proposal body, nothing more. When it no longer applies cleanly (the file moved, the line is gone), stop, move it with `operation: update` and `status: expired`, and tell the human it went stale and what changed. Expired writes no rejection, so a different fix can be a new proposal.

Plugin installs use `claude plugin install <name>@<marketplace>` at the scope the proposal names: `--scope local` in a team project unless the team adopts it, `--scope project` otherwise. The permission prompt is the human's second look.

Then `operation: update` with `id` and `status: applied`. That also saves what each recorded file holds now, so a rollback can tell your change from a later edit. Edit the recorded files after this and a rollback will leave them alone.

## 4. Run its check

Run the proposal's `expect` check now if it can run now (a command exits 0, a file parses, a rule loads). A new or changed skill, agent or plugin manifest is always checked with:

```sh
claude plugin validate <plugin or skill folder>
```

Fix a validation failure in the file you just wrote. If it still fails, roll back (step 6) and report.

Checks that need future sessions (a skill gets invoked, a command stops being typed) belong to the `review` skill. Say roughly when there will be enough sessions to read them.

## 5. Report

A few lines:

- what changed, by file
- the check and its real result, or "pending, read by review after a few sessions"
- the rollback, as one step: roll back `<id>` from `/quartermaster` or `/quartermaster:review`, or copy the files in `changes/C-<n>/prior/` back over the originals (only if nobody edited them since)
- anything that needs `/reload-plugins` or a restart first

## 6. Rolling back on failure

`operation: rollback` with `id`. It restores each recorded file that still holds what the change wrote and names the files the change created. Delete those yourself. A file edited since (a fix after `applied` counts) is left alone and named with the difference: say so, undo that part by hand, and the proposal keeps its status. Report the reason.
