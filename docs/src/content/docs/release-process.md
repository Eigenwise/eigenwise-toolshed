---
title: Release process
description: Maintainer workflow for moving verified Toolshed changes to the marketplace.
---

## Maintainer overview

Toolshed publishes from `main`. A plugin change reaches the marketplace through its release fragment and manifest version. The GitHub `v*` release is a separate notification after the marketplace change is on `main`.

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

The release cut owns plugin manifest versions. Do not hand-edit a manifest to guess the next version. A `HOLD` marker keeps a fragment for a later cut.

The `--push` cut holds the publish lock for the release transaction and stops before changing the release window when the lock is unavailable. Before publishing, it checks the `Test` workflow for the current remote `main` head. A failed or missing run stops the cut unless an explicit `--ci-override "<reason>"` records why it may proceed.

GitHub Releases publish at most once per UTC day. When several marketplace tags land before the daily publish, the workflow releases the newest unreleased tag and generated notes cover the intermediate versions from the previous published Release. A cut whose release workflow succeeds under that cap reports the deferral as successful, and the scheduled publish catches it up.

Executors stop at a verified commit. Integration, release cutting, manifest versioning, and publishing happen after their submission.

See [`scripts/release/README.md`](https://github.com/Eigenwise/eigenwise-toolshed/blob/main/scripts/release/README.md), [`.release/README.md`](https://github.com/Eigenwise/eigenwise-toolshed/blob/main/.release/README.md), and the [workflow docs](https://github.com/Eigenwise/eigenwise-toolshed/tree/main/.github/workflows) for current safeguards.
