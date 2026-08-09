# Release and publishing

Last Updated: 2026-08-10

The marketplace manifests on `main` are delivery. Verified integration lands on `main` and writes a release fragment in the same push with `node scripts/release/note.mjs`. Plugin version bumps ship with that integration; do not hold a bump for a later GitHub Release.

Every plugin release updates three version fields: the marketplace top-level version, the plugin entry version in `.claude-plugin/marketplace.json`, and `plugins/<name>/.claude-plugin/plugin.json`. `scripts/release/lib/manifests.mjs` owns these writes after a plugin has matching bootstrap versions. Codegraph is the eighth marketplace plugin; its initial matching `0.0.0` fields let the release cut publish `0.1.0`.

Release tooling covers note, plan, cut, guard, hold, and commit operations. `.release/HOLD` pauses a normal release window; hotfix behavior is separately documented in `.release/README.md`. The `RELEASE_AUTOMATION` repository variable gates `.github/workflows/release-guard.yml` only; its gate runs no-op while paused. Releases are cut locally with `node scripts/release/cut.mjs` from a clean tree while holding the `sidequest publish lock`. The pre-push hook enforces that lock on `main`; publish with the exact `git push --atomic` command `cut.mjs` prints. `scripts/release/lib/suites.mjs` delegates package-script and test-directory discovery to the committed `plugins/sidequest/lib/suite-resolver.js`, so generated Sidequest `lib` output is part of release-suite resolution.

CI gates are split across:

- `.github/workflows/test.yml`, including the manifest-derived plugin matrix and affected-plugin selection. It triggers on `main` pushes and pull requests.
- `.github/workflows/release-guard.yml`, which validates the publish ref.
- `.github/workflows/release-cut.yml`, which runs daily or by manual dispatch and publishes the notification-only GitHub Release for the marketplace version on `main`.
- `.github/workflows/docs.yml`, which builds and deploys the Astro docs site.

The release cut workflow is notification-only: `.github/workflows/release-cut.yml` reads the marketplace version from `main`, tags that exact commit when the version has no GitHub Release, and publishes generated notes. It never runs `cut.mjs`, changes a version, or pushes `main`; local cuts remain the publishing path.

Docs reference pages are generated from manifests, skill frontmatter, hooks, bin files, and marketplace metadata by `docs/scripts/generate-reference.mjs`. Prose docs under `docs/src/content/docs/` are maintained with the change. Screenshots come only from the synthetic `docs/screenshots/` pipeline.
