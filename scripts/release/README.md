# Release engine

These scripts build the release from the repository tree. They use Node 22 and the standard library, so a release runner needs no install beyond the repository checkout.

| Script | Writes | What it does |
| --- | --- | --- |
| `note.mjs` | one fragment | Records what an integrated ticket releases |
| `plan.mjs` | nothing | Shows the release window the cut would build |
| `cut.mjs` | the release | Bumps versions, writes changelogs, consumes fragments, runs suites, then prepares a release branch (or, only with `--direct-publish`, publishes directly) |
| `finalize.mjs` | tags only | Tags the merged publish-branch commit and pushes those tags |
| `guard.mjs` | nothing | Checks release invariants in CI |

See [`.release/README.md`](../../.release/README.md) for the fragment schema.

## Release authority

The orchestrator owns the release. Each integrated ticket gets one fragment in `.release/unreleased/`. Ticket work records the fragment and does not hand-edit plugin or marketplace versions. `cut.mjs` reads the queued fragments, applies the version bumps, writes the changelogs, removes the consumed fragments, creates the release commit, and runs the suites for changed plugins. A window containing only `scope: repo` fragments still creates a marketplace release and repository changelog entry, without changing a plugin version or plugin changelog.

Use `--sha <rev>` only when the release window must be pinned to a specific descendant of the branch it is cut from. The cut checks the branch and fast-forward relationship before it writes anything.

## Protected branches: prepare, promote, finalize

`main` and `develop` are both protected, so the release transaction is split at the publish boundary and the branch only ever moves through a reviewed PR.

`cut.mjs --prepare` builds the window on a release branch cut from `--base-branch` (default `develop`) and stops there. It creates no tag, touches neither `develop` nor the publish branch, and prints the promotion commands. With `--push` it publishes only that release branch, which is unprotected.

Tags come later, because a tag has to name the commit the publish branch actually carries and only the merge decides that sha. `finalize.mjs` reads the merged commit's manifests against its first parent, derives which versions moved, and tags exactly those, passing that sha to `git tag` explicitly rather than letting it default to the checkout's `HEAD`. It refuses when the commit is not the current remote publish-branch head, when the manifests moved no version against the first parent, when the `Test` workflow did not pass on that same sha, when the publish branch moved while it was validating, and when a tag already points somewhere else. None of those has an override: what a caller may name is the commit, and that commit must be the remote head. Rerunning it after a successful publish is a no-op. It pushes tags and nothing but tags.

### What the lock does and does not cover

The publish lock serialises releases run through Sidequest. It cannot serialise an unrelated writer pushing the publish branch from elsewhere, and git has no push option that makes a tag update conditional on a branch the push does not touch, so there is no atomic remote-head compare-and-set available here. What `finalize.mjs` does instead is re-read the publish branch and its tags inside the lock immediately before any tag exists, refusing on any movement, and re-read the branch again after the push: an advance is reported and the tag stays pinned to the commit it named, while a branch that no longer contains the tagged commit fails loudly with the tag already out. That narrows the race to the push itself. Closing it entirely would mean force-updating a protected branch, which this flow never does.

Bringing the release commit back to `develop` is itself a PR; `finalize.mjs` prints those commands too. Merge it before the next feature PR: until it lands, `develop`'s versions trail the publish branch and `guard.mjs` fails every PR into `develop` for version drift. The guard identifies that sync PR from the forge's base and head repository and refs, then waives each release-owned path only where the PR's resulting tree holds exactly what the pinned publish commit published; never from its branch name (see "Release guard" below). Nothing in this flow resets or rewrites a protected branch.

Without `--prepare`, `cut.mjs --push` would publish the release commit straight onto the publish branch. It refuses unless `--direct-publish` is also passed. That path needs an unprotected publish branch; it is kept, explicitly gated, for repositories that have one and for recovery on a mirror, and it is never used here.

## Release guard

`guard.mjs --mode dev` is ticket work and any PR into the integration branch: versions must match the publish ref, and every changed plugin needs a fragment. `--mode main` is the publish branch and the promotion PR into it: the marketplace version must have moved, every changed plugin must carry its bump, and the repository changelog must be part of the change. A PR into the publish branch that moves no version is not a release promotion and fails.

The release sync-back PR is the one dev-mode case whose manifests moved with no fragment left to name them, because the cut consumed those fragments on the way to the publish branch. Passing the PR's trusted metadata (`--pr-base-repo`, `--pr-head-repo`, `--pr-base-ref`, `--pr-head-sha`) lets the guard verify it in two stages.

First the shape, from forge metadata and the pinned publish commit: same repository, base is the integration branch, and the publish commit is contained in the head. The publish ref is resolved to a commit exactly once, so nothing downstream can be answered by a branch that moved in between. Passing the shape check only makes the paths a cut writes (the marketplace file, the changelogs, `plugins/*/.claude-plugin/plugin.json`, and the consumed fragments) *eligible* for the waiver.

Then the content, per path, which is what actually grants it: the entry at that path in the PR's resulting tree (its merge sha, whose tree is what the base branch would get) must be the entry the pinned publish commit already has, same blob and same mode, or absent on both sides. Anything else keeps the ordinary fragment requirement: different content, a different mode, a path only one side has, an entry that is not an ordinary file, and a tree git could not read at all. So the accepted sync shape is a plain merge of the publish branch into a branch off the integration branch, nothing else added and nothing amended on top.

The refusal is explicit about the path and the reason, and there are only two remedies: rebuild the sync as that plain merge, or release the extra edit with its own fragment. No commit list is consulted, because a merge commit can carry tree changes that appear in no non-merge commit on either side; a branch name is never consulted either. A sync that also carries unreleased integration-branch work still needs a fragment for every plugin that work changes, since those paths are not the ones the cut wrote.

## Delivery and GitHub Releases

The marketplace is delivered through `main` and its marketplace tag, `v<marketplace-version>`. Under the prepare flow, the promotion PR delivers `main` and `finalize.mjs --push` then publishes the marketplace tag in one atomic push, with the plugin version tags, `<plugin>-v<plugin-version>`, following in a second atomic push. A direct cut publishes `main` and the marketplace tag together in the first push instead. Either way the pushes are separate, so the release process never promises one atomic update across `main`, the marketplace tag, and every plugin tag.

The GitHub Release workflow is notification-only. It runs for marketplace `v*` tag pushes, on its daily schedule, and on manual dispatch. The daily cap can defer the GitHub Release, but it does not delay the already-published marketplace `main` branch or marketplace tag. Plugin tags do not create GitHub Releases.

`--push` acquires the Sidequest publish lock before changing the local release window, in both `cut.mjs` and `finalize.mjs`. It also checks the `Test` workflow: the cut checks the remote head of the branch it is cut from, and `finalize.mjs` checks the merged publish-branch commit itself. A failed or missing run stops the cut unless `--ci-override "<reason>"` records why it may proceed; `finalize.mjs` has no override at all. The lock is released after the pushes or any failure.

`Test` fans out over a plugin/platform matrix whose job names truncate and collide, so no individual matrix check proves both platforms ran. The `test-complete` job is the aggregate: it needs every other test job and fails when any of them did not succeed. That is the name branch protection should require, alongside `guard` from `release-guard.yml`.

## Workflow

At integration time, record one fragment for the ticket:

```bash
node scripts/release/note.mjs SQ-843 --title "Build the release engine" --plugins sidequest --bump minor --commit "$(git rev-parse HEAD)"
```

Inspect the queued window, then preview it from `develop` at `HEAD`:

```bash
node scripts/release/plan.mjs
node scripts/release/cut.mjs --prepare --dry-run
```

Prepare the release branch, merge the promotion PR it prints, then tag the merged commit:

```bash
node scripts/release/cut.mjs --prepare --push
# gh pr create / gh pr merge, as printed
node scripts/release/finalize.mjs --push
```

`--dry-run` writes nothing. Without `--push`, `--prepare` creates the local release branch and prints the exact promotion commands, and `finalize.mjs` prints the exact tag pushes. Other useful options include `--sha <rev>`, `--release-branch <name>`, `--skip-tests`, `--allow-dirty` for unstaged or untracked files, and `--force` for an intentional held-window or tag repair. A hotfix selects tickets explicitly:

```bash
node scripts/release/cut.mjs --prepare --mode hotfix --tickets SQ-843,SQ-845 --push
```

Run `--help` for the complete option list.

## Recovery

Everything before the tag push is local or lives on the unprotected release branch. If a suite or invariant fails, a prepared cut leaves every remote ref untouched, resets the release branch away, returns to the branch it was cut from, and leaves a clean tree. A direct cut (`--direct-publish`) resets to the previous `HEAD` and deletes every local release tag instead. If that rollback fails, the cut prints the manual reset and `git update-ref -d refs/tags/<tag>` fallback commands before retrying.

A merged promotion PR that was never finalized is not a broken state: rerun `finalize.mjs --push`. It is safe to repeat, and it refuses rather than guesses when the publish branch has moved past the commit it was asked to tag. Once the marketplace tag is published, leave it in place and follow the roll-forward instructions.

If the first atomic push succeeds and the separate plugin-tag push fails, `main` and the marketplace tag remain published. Inspect the remote, then publish the missing plugin tags with the plugin-tag push command printed by the cut. Do not rerun the whole cut or move an already-published marketplace tag.

If the pushes succeed and the GitHub Release is deferred by the daily cap, leave the marketplace refs in place. The scheduled workflow publishes the newest unreleased marketplace tag.

## Safeguards

- A staged index always stops the cut. `--allow-dirty` only tolerates unstaged and untracked files.
- Manifest versions must match the plan when the cut writes the release.
- Existing remote tags are refused unless `--force` is deliberate repair work.
- The cut rechecks the release commit, index, and tags after suites run, before it publishes.
- Suites run with release credentials and Sidequest runtime identity removed from their environment.
- A prepared window creates no tag, so nothing can publish a sha the promotion PR did not land.
- Every tag names its target commit explicitly. `git.tag` refuses a call without one, so no tag can land on whatever the checkout happened to be on.
- `finalize.mjs` publishes only at the exact remote publish-branch head, only when a version actually moved against its first parent, and never moves a tag that already exists.
- Direct publication of the publish branch is off unless `--direct-publish` asks for it by name.

## Tests

```bash
node --test scripts/release/test/*.test.mjs
```

The release tests use throwaway repositories and local bare remotes. They do not contact a network. They cover planning, version bumps, changelogs, the separate push stages, automatic pre-push rollback, tag checks, and suite safeguards.
