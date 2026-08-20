---
title: Release process
description: Maintainer workflow for moving verified Toolshed changes to the marketplace.
---

## Maintainer overview

Toolshed publishes from `main`. A release cut creates a marketplace tag, `v<marketplace-version>`, and a tag for each released plugin, `<plugin>-v<plugin-version>`. The `Publish GitHub Release` workflow runs for pushes of `v*` tags, on its daily schedule, and when manually dispatched. It creates GitHub Releases only for marketplace tags, so per-plugin tags do not create GitHub Releases.

## Prepare a release

1. Add a fragment under `.release/unreleased/` with the plugin, change type, and user-facing summary.
2. Check the queue and preview the release:

   ```text
   sidequest publish queue
   node scripts/release/cut.mjs --dry-run
   ```

3. Run the publish cut:

   ```text
   node scripts/release/cut.mjs --push
   ```

The release cut owns plugin manifest versions. Do not hand-edit a manifest to guess the next version. `hold: true` in a fragment holds only that fragment for a later cut. A `.release/HOLD` file holds the whole release window, though a hotfix still runs while it is present.

The `Test` and `Release guard` workflows run on pull requests and pushes to `main`. `Test` always runs. `Release guard` enforces release invariants only when the repository `RELEASE_AUTOMATION` variable is `active`, `on`, `true`, or `1`; otherwise it reports that enforcement is staged or paused and passes through. The `--push` cut holds the publish lock for the release transaction and stops before changing the release window when the lock is unavailable. Before publishing, it checks the `Test` workflow for the current remote `main` head. A failed or missing run stops the cut unless an explicit `--ci-override "<reason>"` records why it may proceed.

## When the cut stops

The cut also runs tests itself. It writes the release commit and every tag locally, then runs the test suite of each plugin the release moves, and only pushes if they all pass. `--dry-run` lists those suites under `suites (N)`, so you can see what a cut will run before it runs it.

A failing suite publishes nothing, but the local release commit and its tags are already written by that point. The cut prints the two commands that undo them, a `git reset --hard` back to the previous head and a `git tag -d` naming every tag it created. Run both. A reset alone leaves the tags behind, and a later cut for the same version will not be able to create them.

Deleting those tags needs the publish lock, because Sidequest refuses a manual `git tag` on this repository without one. Acquire it with `sidequest publish lock`, delete the tags, then `sidequest publish unlock`. The refusal blocks the whole shell invocation, so run the lock, the deletion, and the unlock as three separate commands rather than chaining them.

This gate is local and it runs on your machine, so a test that reads your own environment can fail here while CI is green on the same commit. That is a bug in the test, not a reason to skip the gate.

GitHub Releases publish at most once per UTC day. When several marketplace tags land before the daily publish, the workflow releases the newest unreleased tag and generated notes cover the intermediate versions from the previous published Release. A cut whose release workflow succeeds under that cap reports the deferral as successful, and the scheduled publish catches it up.

Executors stop at a verified commit. Integration, release cutting, manifest versioning, and publishing happen after their submission.

See [`scripts/release/README.md`](https://github.com/Eigenwise/eigenwise-toolshed/blob/main/scripts/release/README.md), [`.release/README.md`](https://github.com/Eigenwise/eigenwise-toolshed/blob/main/.release/README.md), and the [workflow docs](https://github.com/Eigenwise/eigenwise-toolshed/tree/main/.github/workflows) for current safeguards.
