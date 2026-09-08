# Release engine

These scripts build the release from the repository tree. They use Node 22 and the standard library, so a release runner needs no install beyond the repository checkout.

| Script | Writes | What it does |
| --- | --- | --- |
| `note.mjs` | one fragment | Records what an integrated ticket releases |
| `plan.mjs` | nothing | Shows the release window the cut would build |
| `cut.mjs` | the release | Bumps versions, writes changelogs, consumes fragments, creates tags, runs suites, and optionally publishes |
| `guard.mjs` | nothing | Checks release invariants in CI |

See [`.release/README.md`](../../.release/README.md) for the fragment schema.

## Release authority

The orchestrator owns the release cut from `main` at `HEAD`. Each integrated ticket gets one fragment in `.release/unreleased/`. Ticket work records the fragment and does not hand-edit plugin or marketplace versions. `cut.mjs` reads the queued fragments, applies the version bumps, writes the changelogs, removes the consumed fragments, creates the release commit and tags, and runs the suites for changed plugins.

A normal cut defaults to the current `main` checkout. Use `--sha <rev>` only when the release window must be pinned to a specific descendant of `main`. The cut checks the branch and fast-forward relationship before it writes anything.

## Delivery and GitHub Releases

The marketplace is delivered through `main` and its marketplace tag, `v<marketplace-version>`. When `--push` is used, the cut publishes those two refs together in one atomic push. Plugin version tags, `<plugin>-v<plugin-version>`, are published in a second atomic push. These pushes are separate, so the release process never promises one atomic update across `main`, the marketplace tag, and every plugin tag.

The GitHub Release workflow is notification-only. It runs for marketplace `v*` tag pushes, on its daily schedule, and on manual dispatch. The daily cap can defer the GitHub Release, but it does not delay the already-published marketplace `main` branch or marketplace tag. Plugin tags do not create GitHub Releases.

`--push` acquires the Sidequest publish lock before changing the local release window. It also checks the current remote `main` Test workflow before publishing. A failed or missing run stops the cut unless `--ci-override "<reason>"` records why it may proceed. The lock is released after the pushes or any failure.

## Workflow

At integration time, record one fragment for the ticket:

```bash
node scripts/release/note.mjs SQ-843 --title "Build the release engine" --plugins sidequest --bump minor --commit "$(git rev-parse HEAD)"
```

Inspect the queued window, then preview it from `main` at `HEAD`:

```bash
node scripts/release/plan.mjs
node scripts/release/cut.mjs --dry-run
```

Build the release locally, or build and publish it:

```bash
node scripts/release/cut.mjs
node scripts/release/cut.mjs --push
```

`--dry-run` writes nothing. Without `--push`, the cut creates the local commit and tags and prints the exact publish commands. Other useful options include `--sha <rev>`, `--skip-tests`, `--allow-dirty` for unstaged or untracked files, and `--force` for an intentional held-window or tag repair. A hotfix selects tickets explicitly:

```bash
node scripts/release/cut.mjs --mode hotfix --tickets SQ-843,SQ-845 --push
```

Run `--help` for the complete option list.

## Recovery

Everything before the first remote push is local. If a suite or invariant fails, the cut leaves the remote untouched and prints a reset to the previous `HEAD` plus a `git tag -d` command for every tag it created. Run both commands before retrying. A reset alone leaves local tags behind.

If the first atomic push succeeds and the separate plugin-tag push fails, `main` and the marketplace tag remain published. Inspect the remote, then publish the missing plugin tags with the plugin-tag push command printed by the cut. Do not rerun the whole cut or move an already-published marketplace tag.

If the pushes succeed and the GitHub Release is deferred by the daily cap, leave the marketplace refs in place. The scheduled workflow publishes the newest unreleased marketplace tag.

## Safeguards

- A staged index always stops the cut. `--allow-dirty` only tolerates unstaged and untracked files.
- Manifest versions must match the plan when the cut writes the release.
- Existing remote tags are refused unless `--force` is deliberate repair work.
- The cut rechecks the release commit, index, and tags after suites run, before it publishes.
- Suites run with release credentials and Sidequest runtime identity removed from their environment.

## Tests

```bash
node --test scripts/release/test/*.test.mjs
```

The release tests use throwaway repositories and local bare remotes. They do not contact a network. They cover planning, version bumps, changelogs, the separate push stages, recovery, tag checks, and suite safeguards.
