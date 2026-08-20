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

GitHub Releases publish at most once per UTC day. When several marketplace tags land before the daily publish, the workflow releases the newest unreleased tag and generated notes cover the intermediate versions from the previous published Release. A cut whose release workflow succeeds under that cap reports the deferral as successful, and the scheduled publish catches it up.

Executors stop at a verified commit. Integration, release cutting, manifest versioning, and publishing happen after their submission.

See [`scripts/release/README.md`](https://github.com/Eigenwise/eigenwise-toolshed/blob/main/scripts/release/README.md), [`.release/README.md`](https://github.com/Eigenwise/eigenwise-toolshed/blob/main/.release/README.md), and the [workflow docs](https://github.com/Eigenwise/eigenwise-toolshed/tree/main/.github/workflows) for current safeguards.
