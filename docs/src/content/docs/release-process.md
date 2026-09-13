---
title: Release process
description: Maintainer workflow for moving verified Toolshed changes to the marketplace.
---

## Maintainer overview

Toolshed integrates on `develop` and publishes from `main`. Both branches are protected: pull requests and required checks, admins included, and no force-push or deletion. So a release is three explicit steps rather than one push, and `main` only ever moves through a reviewed promotion PR.

A release creates a marketplace tag, `v<marketplace-version>`, and a tag for each released plugin, `<plugin>-v<plugin-version>`. A window of only repository-scoped work moves no plugin version, so it creates the marketplace tag alone. The `Publish GitHub Release` workflow runs for pushes of `v*` tags, on its daily schedule, and when manually dispatched. It creates GitHub Releases only for marketplace tags, so per-plugin tags do not create GitHub Releases.

## Cut a release

1. Add a fragment under `.release/unreleased/` with the plugin, change type, and user-facing summary.

   Work that changes no published plugin declares `scope: repo` instead of `plugins` and `bump`. Release scripts, CI workflows, and repository documentation are the usual cases. A repo-scoped fragment moves no plugin version, so nobody re-extracts a plugin for it; it lands in the repository `CHANGELOG.md` under `Repository` and the release commit message names `repository` alongside any plugins the window does move. The two forms are mutually exclusive: a fragment declaring `scope: repo` alongside `plugins` or `bump` is refused. Do not reach for it to avoid a bump you find inconvenient, and do not bump a plugin the change never touched.
2. Check the queue and preview the release from a clean `develop`:

   ```text
   sidequest publish queue
   node scripts/release/cut.mjs --prepare --dry-run
   ```

3. Prepare the release branch:

   ```text
   node scripts/release/cut.mjs --prepare --push
   ```

   This bumps the versions, writes the changelogs, consumes the fragments, runs the changed plugins' suites, and commits all of that on `release/v<version>`. It creates no tag, and neither `main` nor `develop` moves.

4. Open and merge the promotion PR the cut printed, once the required checks pass:

   ```text
   gh pr create --base main --head release/v<version> --title "release v<version>"
   gh pr merge --merge
   ```

5. Tag the merged commit:

   ```text
   node scripts/release/finalize.mjs --push
   ```

   `finalize.mjs` reads the merged commit's manifests against its first parent, works out which versions moved, and tags exactly those at that commit, named explicitly rather than at whatever the checkout happens to be on. It pushes tags and nothing else. It refuses when the commit is not the current `origin/main` head, when no version moved against the first parent, when `Test` did not pass on that same sha, when `main` moved while it was validating, and when a tag already points somewhere else. None of those refusals can be overridden. Running it again after a successful publish does nothing.

6. Sync `main` back to `develop` through the PR that `finalize.mjs` printed, and merge it before the next feature PR. Both branches are protected, so nothing here resets or force-pushes either one.

   Until that sync lands, `develop` carries older versions than `main`, and the release guard fails every PR into `develop` for version drift. The guard recognises the sync PR itself from the forge's base and head repository and refs: same repository, base `develop`, and the pinned `origin/main` commit contained in the head. That only makes the paths a cut writes eligible. The waiver is then decided path by path: the entry in the PR's resulting tree has to be the entry that pinned commit published, same content and same mode, or absent on both sides.

   So build the sync as a plain merge of `main` into a branch off `develop`, with nothing added and nothing amended on top. An edit riding the merge commit keeps its ordinary fragment requirement even when it touches a manifest, and the refusal names the path and the reason: either rebuild the sync as that plain merge, or release the edit with its own fragment. A branch named `sync/...` gets nothing for its name, and a feature branch that merges `main` still has to carry a fragment for every plugin it changes.

The release cut owns plugin manifest versions. Do not hand-edit a manifest to guess the next version. `hold: true` in a fragment holds only that fragment for a later cut. A `.release/HOLD` file holds the whole release window, though a hotfix still runs while it is present.

The `Test` and `Release guard` workflows run on pull requests and on pushes to `main` and `develop`. `Test` always runs; its `test-complete` job aggregates every other test job and is the check branch protection should require, because the plugin/platform matrix job names truncate and collide. Anything other than `success` in a job it needs, a skip or a cancellation included, fails it. `Release guard` enforces release invariants only when the repository `RELEASE_AUTOMATION` variable is `active`, `on`, `true`, or `1`; otherwise it reports that enforcement is staged or paused and passes through. A PR into `main` runs it in promotion mode, where the marketplace version is required to have moved, so a docs-only PR into `main` fails it.

Both `--push` steps hold the publish lock for their half of the transaction and stop before changing anything when the lock is unavailable. The cut checks the `Test` workflow for the current remote `develop` head; `finalize.mjs` checks it for the merged `main` commit itself. A failed or missing run stops the cut unless an explicit `--ci-override "<reason>"` records why it may proceed; `finalize.mjs` has no such override, because there the sha in question is already published branch content.

The lock only covers publishers that go through Sidequest. It cannot serialise an unrelated writer pushing `main` from somewhere else, and git has no way to make a tag push conditional on a branch the push does not update, so there is no atomic remote-head compare-and-set to hold. `finalize.mjs` re-reads `main` and its tags inside the lock immediately before creating any tag, refusing on movement, and re-reads `main` after the push, reporting an advance and failing loudly if `main` no longer contains the tagged commit. That narrows the window to the push itself rather than closing it; closing it would mean force-updating a protected branch, which this flow never does.

## When the cut stops

The cut also runs tests itself. It writes the release commit on the release branch, then runs the test suite of each plugin the release moves, and only pushes if they all pass. `--dry-run` lists those suites under `suites (N)`, so you can see what a cut will run before it runs it.

A failing suite publishes nothing. A prepared cut resets the release branch away, returns you to `develop` with a clean tree, and leaves every remote ref where it was, while preserving the suite log under `.release/logs/`. A marketplace tag that has already been published keeps its existing roll-forward recovery path.

Sidequest refuses to prepare a dispatch whose baseline is a locally tagged commit that the remote branch does not have yet. Neither half of the protected flow can produce that state: a prepared cut creates no tag at all, and `finalize.mjs` only tags a commit the remote publish branch already carries, so the tagged tip is reachable from the remote branch and the guard passes. What it still catches is a direct `cut.mjs --push --direct-publish` run on an unprotected publish branch, which tags its release commit locally before running the suites. The refusal names the tags it found, and that commit stays until someone clears it or reruns the cut.

Clearing it by hand needs the publish lock, because Sidequest refuses a manual tag deletion on this repository without one. Acquire it with `sidequest publish lock`, run the `git update-ref -d refs/tags/<tag>` commands that were printed, then `sidequest publish unlock`. The refusal blocks the whole shell invocation, so run the lock, the deletion, and the unlock as three separate commands rather than chaining them.

This gate is local and it runs on your machine, so a test that reads your own environment can fail here while CI is green on the same commit. That is a bug in the test, not a reason to skip the gate.

A failure that disappears when you rerun the failing file on its own is a different problem: a concurrency flake, usually two test files sharing a fixture, or a reader parsing a file another test is still writing. It is still worth stopping for, because an intermittent that can fail a cut can fail CI later. Run the failing file alone to confirm, cut again, and file the flake as its own ticket so the next cut does not pay for it twice.

A merged promotion PR that never got finalized is not a broken state. Rerun `node scripts/release/finalize.mjs --push`: it is safe to repeat, and when `main` has moved past the commit it was asked to tag it refuses and tells you rather than guessing.

GitHub Releases publish at most once per UTC day. When several marketplace tags land before the daily publish, the workflow releases the newest unreleased tag and generated notes cover the intermediate versions from the previous published Release. A finalize whose release workflow succeeds under that cap reports the deferral as successful, and the scheduled publish catches it up.

Executors stop at a verified commit. Integration, release cutting, manifest versioning, and publishing happen after their submission.

See [`scripts/release/README.md`](https://github.com/Eigenwise/eigenwise-toolshed/blob/main/scripts/release/README.md), [`.release/README.md`](https://github.com/Eigenwise/eigenwise-toolshed/blob/main/.release/README.md), and the [workflow docs](https://github.com/Eigenwise/eigenwise-toolshed/tree/main/.github/workflows) for current safeguards.
