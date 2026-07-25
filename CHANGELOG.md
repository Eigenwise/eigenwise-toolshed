# Changelog

One section per release window. Each window is a single commit on `main` that moves every
changed plugin at once, tagged `v<marketplace version>`, with matching per-plugin changelogs
under `plugins/<name>/CHANGELOG.md`.

Releases before v3.208.0 predate this file and are not backfilled; `git log` is the record for
those. Entries are generated from `.release/unreleased/*.md` by `scripts/release/cut.mjs`, so
nothing here is hand-written.
