# Changelog

One section per release window. Each window is a single commit on `main` that moves every
changed plugin at once, tagged `v<marketplace version>`, with matching per-plugin changelogs
under `plugins/<name>/CHANGELOG.md`.

Releases before v3.208.0 predate this file and are not backfilled; `git log` is the record for
those. Entries are generated from `.release/unreleased/*.md` by `scripts/release/cut.mjs`, so
nothing here is hand-written.

## v3.243.0 (2026-07-27)

### sidequest 3.26.2 → 3.26.3

#### Fixes

- Upfront backlog before first dispatch; evidence-gated unpinnable-contract branch (SQ-943) [`0b598be`](https://github.com/Eigenwise/eigenwise-toolshed/commit/0b598be477a6619a87cbb539ed90f384c2a02064)

## v3.242.0 (2026-07-27)

### sidequest 3.26.1 → 3.26.2

#### Fixes

- Solo-fit gate v2: never-inline invariant, contract-first parallel waves, restored economy guards (SQ-941) [`1849c79`](https://github.com/Eigenwise/eigenwise-toolshed/commit/1849c7952febb11daf75bbe78b236c5c36c9e9ef)

## v3.241.0 (2026-07-27)

### sidequest 3.26.0 → 3.26.1

#### Fixes

- Right-size ticket decomposition: solo-fit gate, deterministic-verify audit skip, wave-batched integration (SQ-938) [`d0ca9d9`](https://github.com/Eigenwise/eigenwise-toolshed/commit/d0ca9d958c556debc49eff898a95a3947e615908)
