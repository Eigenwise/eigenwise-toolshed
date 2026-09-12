# Release and publishing

Last Updated: 2026-09-12

The marketplace manifests on `main` are delivery. Executors include release fragments with their submitted changes. The orchestrator runs `node scripts/release/cut.mjs --push` to verify, assign matching versions, and publish the release transaction; plugin bumps ship with the changes rather than waiting for a later GitHub Release.

Sidequest executors stop at immutable submitted candidates. The orchestrator integrates accepted candidates, leaves review-rejected candidates held, and verifies the actual merged content before publication. Board closure requires recorded delivery and verification of the delivered revision; rejected predecessors are superseded with reviewed replacement evidence. Integration refuses a dirty target and preserves unrelated working paths when applying a candidate. Single and wave integration merge and verify in the registered local checkout, including default auto mode; invoking from a linked worktree does not redirect that checkout. Remote refs add evidence of landed work without changing integrate-before-push ordering. A candidate landed only remotely triggers `integration_target_behind_landed_candidate` before a verifier or participant mutation. Delivery records identify the ref that actually supplied the revision rather than labeling a local-only delivery as remote.

Every plugin release updates three version fields: the marketplace top-level version, the plugin entry version in `.claude-plugin/marketplace.json`, and `plugins/<name>/.claude-plugin/plugin.json`. `scripts/release/lib/manifests.mjs` owns these writes after a plugin has matching bootstrap versions.

A fragment that changes no published plugin declares `scope: repo` instead of `plugins` and `bump`; `resolveScope` in `scripts/release/lib/fragments.mjs` refuses the two forms together, `plan.mjs` collects them as `repositoryEntries` and names `repository` in the release commit message, and `changelog.mjs` writes them into a `### Repository` section of the repository `CHANGELOG.md` only. A window of only repo-scoped fragments therefore moves no plugin version and creates the marketplace tag alone, which `unpublishedReleaseTip` in `plugins/sidequest/src/lib/commit-scope.ts` cannot yet recognize because it requires at least one plugin tag.

Release tooling covers note, plan, cut, guard, hold, and commit operations. `.release/HOLD` pauses a normal release window; hotfix behavior is separately documented in `.release/README.md`. The `RELEASE_AUTOMATION` repository variable gates `.github/workflows/release-guard.yml` only; its gate runs no-op while paused. Releases are cut locally with `node scripts/release/cut.mjs --push` from a clean tree; the release transaction uses the `sidequest publish lock` enforced by the pre-push hook on `main`. `scripts/release/lib/suites.mjs` delegates package-script and test-directory discovery to the committed `plugins/sidequest/lib/suite-resolver.js`; generated Sidequest `agents/`, `lib/`, and other committed build output ship in the plugin package, and generated `lib` output drives release-suite resolution.

CI gates are split across:

- `.github/workflows/test.yml`, including the manifest-derived plugin matrix and affected-plugin selection. It triggers on `main` pushes and pull requests.
- `.github/workflows/release-guard.yml`, which validates the publish ref.
- `.github/workflows/release.yml` (Publish GitHub Release), which triggers on `v*` tags, a daily schedule, and manual dispatch, and creates at most one GitHub Release per UTC day: a capped tag-push run exits successfully without publishing, and the daily catch-up publishes the newest unreleased `v*` tag with generated notes covering every intermediate version. `cut.mjs` reports a capped run as `githubRelease.status === 'deferred'` instead of failing.
- `.github/workflows/docs.yml`, which builds and deploys the Astro docs site.

`release.yml` is the only GitHub Release publisher; the older cap-unaware `release-cut.yml` was retired. GitHub Releases are notification-only: local cuts remain the publishing path, and the workflows never run `cut.mjs`, change a version, or push `main`.

Docs reference pages are generated from manifests, skill frontmatter, hooks, bin files, and marketplace metadata by `docs/scripts/generate-reference.mjs`. Prose docs under `docs/src/content/docs/` are maintained with the change. Screenshots come only from the synthetic `docs/screenshots/` pipeline.
