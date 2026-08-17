# GitHub automation

Workflows in this directory cover tests, release checks, documentation deployment, and GitHub
Release notifications. They run on pushes to `main`, pull requests, scheduled release checks, or
manual dispatch as shown below.

| Workflow | Trigger | Role |
| --- | --- | --- |
| `test.yml` | Push to `main`, pull request | Runs release-engine tests, builds the plugin test matrix, then tests affected plugins. |
| `release-guard.yml` | Push to `main`, pull request | Checks release invariants. It exits early while the repository variable `RELEASE_AUTOMATION` is paused or staged. |
| `docs.yml` | Push to `main` for docs/source inputs, manual dispatch | Runs the docs build and deploys `docs/dist` to GitHub Pages. The build regenerates reference pages first. |
| `release.yml` | Tags matching `v*`, daily schedule, manual dispatch | The sole GitHub Release publisher. Creates at most one GitHub Release per UTC day: tag pushes defer after that cap, and the daily catch-up publishes the newest unreleased `v*` tag with generated notes. |

`RELEASE_AUTOMATION` gates `release-guard.yml` only. Normal publishing remains a local
`scripts/release/cut.mjs` run under the Sidequest publish lock, followed by the exact atomic push it
prints. `release.yml` creates no more than one GitHub Release per UTC day: a capped tag-push run
exits successfully, then the daily catch-up publishes the newest unreleased `v*` tag. Its generated
notes include the intermediate marketplace versions since the previous GitHub Release. The `v*`
workflow notifies users after a marketplace commit is already on `main`; it does not own plugin or
marketplace version bumps.
