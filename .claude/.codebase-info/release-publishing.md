# Release and publishing

Last Updated: 2026-08-17

The marketplace manifests on `main` are delivery. Verified integration lands on `main` and writes a release fragment in the same push with `node scripts/release/note.mjs`. Plugin version bumps ship with that integration; do not hold a bump for a later GitHub Release.

Sidequest executors stop at immutable submitted candidates. The orchestrator assembles the accepted terminal wave, leaves every review-rejected candidate quarantined, reruns property-level oracles for overlapping changes, and runs one merged full gate before advancing `main`. Board closure follows delivery reachability: accepted submissions close only after their delivered commits are ancestors of the integration branch, while rejected predecessors are superseded with the integrated repair evidence. Integration refuses a dirty target and preserves unrelated working paths when applying a candidate.

Every plugin release updates three version fields: the marketplace top-level version, the plugin entry version in `.claude-plugin/marketplace.json`, and `plugins/<name>/.claude-plugin/plugin.json`. `scripts/release/lib/manifests.mjs` owns these writes after a plugin has matching bootstrap versions.

Release tooling covers note, plan, cut, guard, hold, and commit operations. `.release/HOLD` pauses a normal release window; hotfix behavior is separately documented in `.release/README.md`. The `RELEASE_AUTOMATION` repository variable gates `.github/workflows/release-guard.yml` only; its gate runs no-op while paused. Releases are cut locally with `node scripts/release/cut.mjs` from a clean tree while holding the `sidequest publish lock`. The pre-push hook enforces that lock on `main`; publish with the exact `git push --atomic` command `cut.mjs` prints. `scripts/release/lib/suites.mjs` delegates package-script and test-directory discovery to the committed `plugins/sidequest/lib/suite-resolver.js`, so generated Sidequest `lib` output is part of release-suite resolution.

CI gates are split across:

- `.github/workflows/test.yml`, including the manifest-derived plugin matrix and affected-plugin selection. It triggers on `main` pushes and pull requests.
- `.github/workflows/release-guard.yml`, which validates the publish ref.
- `.github/workflows/release.yml` (Publish GitHub Release), which triggers on `v*` tags, a daily schedule, and manual dispatch, and creates at most one GitHub Release per UTC day: a capped tag-push run exits successfully without publishing, and the daily catch-up publishes the newest unreleased `v*` tag with generated notes covering every intermediate version. `cut.mjs` reports a capped run as `githubRelease.status === 'deferred'` instead of failing.
- `.github/workflows/docs.yml`, which builds and deploys the Astro docs site.

`release.yml` is the only GitHub Release publisher; the older cap-unaware `release-cut.yml` was retired (SQ-2219). GitHub Releases are notification-only: local cuts remain the publishing path, and the workflows never run `cut.mjs`, change a version, or push `main`.

Docs reference pages are generated from manifests, skill frontmatter, hooks, bin files, and marketplace metadata by `docs/scripts/generate-reference.mjs`. Prose docs under `docs/src/content/docs/` are maintained with the change. Screenshots come only from the synthetic `docs/screenshots/` pipeline.
