# GitHub automation

Workflows in this directory cover tests, release checks, documentation deployment, and GitHub
Release notifications. They run on pushes to `main` or `develop`, pull requests, scheduled release
checks, or manual dispatch as shown below.

| Workflow | Trigger | Role |
| --- | --- | --- |
| `test.yml` | Push to `main` or `develop`, pull request | Runs release-engine tests, builds the plugin test matrix, tests affected plugins, then aggregates every result into `test-complete`. |
| `release-guard.yml` | Push to `main` or `develop`, pull request | Checks release invariants. It exits early while the repository variable `RELEASE_AUTOMATION` is paused or staged. |
| `docs.yml` | Push to `main` for docs/source inputs, manual dispatch | Runs the docs build and deploys `docs/dist` to GitHub Pages. The build regenerates reference pages first. |
| `release.yml` | Tags matching `v*`, daily schedule, manual dispatch | The sole GitHub Release publisher. Creates at most one GitHub Release per UTC day: tag pushes defer after that cap, and the daily catch-up publishes the newest unreleased `v*` tag with generated notes. |

## Which checks protection should require

`test-complete` and `guard`. The `affected-plugin` matrix generates one job name per
plugin/platform pair; those names truncate and collide, so requiring them individually does not
prove both platforms ran. `test-complete` needs every other job in `test.yml` and fails when any of
them did not succeed, which makes it the one stable name that means "the whole Test workflow passed
on this sha".

`release-guard.yml` picks its mode from the branch. A pull request into `main` is a release
promotion, so it runs in `main` mode, where the marketplace version is required to have moved; a
docs-only pull request into `main` fails there. Every other pull request and `develop` push runs in
`dev` mode, where versions must match `origin/main` and every changed plugin needs a release
fragment. A `dev` pull request also hands the guard the forge's own view of itself
(`base.repo.full_name`, `head.repo.full_name`, `base.ref`, and the merge sha), which is what lets it
recognise the `main` → `develop` release sync-back. Repository identity and the base ref only make
the paths a release cut wrote eligible; the waiver is then granted one path at a time, and only where
the merge sha's tree holds exactly the entry the pinned `origin/main` commit published. A branch name
buys nothing, and neither does the list of commits a PR adds: a merge commit can write a tree change
that appears in no non-merge commit on either side.

`RELEASE_AUTOMATION` gates `release-guard.yml` only. Publishing is a local
`scripts/release/cut.mjs --prepare` run, the promotion PR it prints, then
`scripts/release/finalize.mjs --push`, all under the Sidequest publish lock. `release.yml` creates
no more than one GitHub Release per UTC day: a capped tag-push run exits successfully, then the
daily catch-up publishes the newest unreleased `v*` tag. Its generated notes include the
intermediate marketplace versions since the previous GitHub Release. The `v*` workflow notifies
users after a marketplace commit is already on `main`; it does not own plugin or marketplace version
bumps.
