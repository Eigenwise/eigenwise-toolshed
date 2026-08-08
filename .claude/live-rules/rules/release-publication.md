---
description: Automated release policy
prompt: ["ship", "publish", "release", "bump", "hotfix", "marketplace"]
---
- Integrate ticket work on `main`; write a release fragment in the same push with `node scripts/release/note.mjs <REF> --plugins <p> --bump <level> --commit <sha>`.
- Versions, tags, and changelog edits are release-owned; only `scripts/release/cut.mjs` writes them.
- Run `node scripts/release/cut.mjs --dry-run` from a clean tree, then publish with `node scripts/release/cut.mjs --push`. `--push` acquires the Sidequest publish lock before it changes the release window and releases it after the push or a failure; a held lock stops the cut before it changes the window.
- The pre-push hook enforces the publish lock on `main`.
- `release-cut.yml` exists but is paused through `RELEASE_AUTOMATION`. If automation is unpaused, the dev-flow publication text applies again.
