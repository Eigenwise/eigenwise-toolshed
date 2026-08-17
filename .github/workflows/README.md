# GitHub automation

Workflows in this directory cover tests, release checks, documentation deployment, and GitHub
Release notifications. They run on pushes to `main`, pull requests, scheduled release checks, or
manual dispatch as shown below.

| Workflow | Trigger | Role |
| --- | --- | --- |
| `test.yml` | Push to `main`, pull request | Runs release-engine tests, builds the plugin test matrix, then tests affected plugins. |
| `release-guard.yml` | Push to `main`, pull request | Checks release invariants. It exits early while the repository variable `RELEASE_AUTOMATION` is paused or staged. |
| `docs.yml` | Push to `main` for docs/source inputs, manual dispatch | Runs the docs build and deploys `docs/dist` to GitHub Pages. The build regenerates reference pages first. |
| `release-cut.yml` | Daily schedule, manual dispatch | Reads the marketplace version on `main` and creates the matching notification-only tag and GitHub Release when one is missing. It does not run `cut.mjs` or change versions. |
| `release.yml` | Tags matching `v*`, daily schedule, manual dispatch | Creates at most one GitHub Release per UTC day. Tag pushes defer after that cap; the daily catch-up publishes the newest unreleased `v*` tag with generated notes. |

`RELEASE_AUTOMATION` gates `release-guard.yml` only. `release-cut.yml` is not gated by it and does
run on its daily schedule. Normal publishing remains a local `scripts/release/cut.mjs` run under
the Sidequest publish lock, followed by the exact atomic push it prints. `release.yml` creates no
more than one GitHub Release per UTC day: a capped tag-push run exits successfully, then the daily
catch-up publishes the newest unreleased `v*` tag. Its generated notes include the intermediate
marketplace versions since the previous GitHub Release. The `v*` workflows notify users after a
marketplace commit is already on `main`; they do not own plugin or marketplace version bumps.
