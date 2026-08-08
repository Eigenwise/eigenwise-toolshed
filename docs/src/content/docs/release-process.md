---
title: Release process
description: How Toolshed changes move from a fragment to a published marketplace version.
---

Toolshed publishes from `main`. A plugin change needs its release fragment and manifest version to reach the marketplace; the notification-only GitHub Release is separate.

## Prepare a release

Add a fragment under `.release/unreleased/` with the plugin, change type, and user-facing summary. Check the queue before cutting:

```text
sidequest publish queue
```

The queue shows held fragments, the latest release, integration and published branches, and the next scheduled-cut hint. Preview the cut, then let `--push` hold the publish lock for the whole release transaction:

```text
node scripts/release/cut.mjs --dry-run
node scripts/release/cut.mjs --push
```

`--push` acquires the lock before it changes the local release window and releases it after the final push or a failure. A held lock stops the cut before it changes the window.

The release cut owns manifest versions. Do not hand-edit both plugin manifests to guess the next number. A hotfix cut uses the same ownership rules and is reserved for an urgent published fix. A `HOLD` marker keeps a fragment out of the next cut while preserving it for a later release.

The orchestrator integrates executor submissions, runs the recorded verification command, and cuts the release. Before it publishes, the cut checks the `Test` workflow for the current remote `main` head. A failed or missing run stops the cut unless `--ci-override "<reason>"` records why the release may proceed, such as a release that repairs CI. Executors stop at a verified commit and never push, bump manifests, or assign release versions. The GitHub `v*` release is notification-only and can be created after the marketplace change is on `main`.

See `scripts/release/README.md`, `.release/README.md`, and the repository's release workflows for the current commands and safeguards.
