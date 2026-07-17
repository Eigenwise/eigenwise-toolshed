---
name: update-codebase-map
description: >-
  Refresh an existing codebase map in .claude/.codebase-info/ so it reflects the current code.
  Detects what changed since the map was last written, updates only the affected atomic docs, and
  re-records state. Use when the user asks to "update the codebase map", "refresh codebase docs",
  "sync documentation", "the docs are stale", "update architecture docs", or after a change that
  affects architecture, structure, dependencies, the data model, entry points, APIs/events, or
  conventions. If there's no .claude/.codebase-info/ yet, use map-codebase instead.
---

# Update Codebase Map

Bring an existing map up to date with surgical edits — detect changes, touch only the affected
documents, keep everything internally consistent. This is a refresh, **not** a full rewrite.

## Prerequisite

A `.claude/.codebase-info/` directory with `INDEX.md` must already exist. If it doesn't, stop and
use the `map-codebase` skill to create the initial map.

## Process

### Step 1 — Load current state

Read `.claude/.codebase-info/.map-state.json` to get `gitCommit`, `mappedAt`, and the list of
existing `documents`. Skim `INDEX.md` to recall what's already covered. (If `.map-state.json` is
missing — e.g. a map from an older version — fall back to the `mappedAt` date in `INDEX.md`, and
plan to write a fresh `.map-state.json` at the end.)

### Step 2 — Detect what changed

**Git repo (preferred — precise):** diff against the last-mapped commit.
```bash
git diff --stat <gitCommit>..HEAD          # which files changed, added, deleted
git log --oneline <gitCommit>..HEAD        # what the changes were about
git diff <gitCommit>..HEAD -- package.json pyproject.toml go.mod Cargo.toml composer.json Gemfile   # dependency churn (adjust to the project's manifests)
```

**No git, or no stored commit (fallback):** find source files modified since the map was written.
```bash
# files newer than the index (skip noise dirs)
find . -type f -newer .claude/.codebase-info/INDEX.md \
  -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/vendor/*' \
  -not -path '*/dist/*' -not -path '*/build/*' -not -path '*/target/*' -not -path '*/.venv/*'
```

### Step 3 — Re-assess the warranted doc set, then map changes to documents

An update is not only "edit the docs that exist." First **re-evaluate which documents this codebase
now warrants**, because the right set drifts as the project grows. The map should always carry the docs
that apply now, no more and no less:

- **A new aspect appeared → add its doc.** The project gained its first `Dockerfile`/`compose.yaml`, so
  create `docker.md` now even though the last map had none. First datastore → add `database.md`. First
  dependency manifest → add `dependencies.md`. A new major subsystem that no standard doc covers → add
  a custom doc (e.g. `ml-pipeline.md`, `realtime.md`), the same way `map-codebase` would. This is the
  common case the user cares about: you don't make `docker.md` until there's Docker, and once the code
  is dockerized, the next update is exactly when it should appear.
- **An aspect vanished → prune its doc.** A service, integration, or datastore was removed, so delete
  the now-empty doc and its `INDEX.md` row.

Then map the remaining changes onto the existing documents:

| If this changed… | Update… |
|------------------|---------|
| Directory layout (folders added/removed/renamed) | `directory-structure.md` |
| Components / services / module boundaries | `architecture.md`, `modules.md` |
| New/removed routes, CLI commands, jobs, handlers | `entry-points.md` |
| API contracts, events, queues, integrations | `communication.md` |
| Schema, migrations, new tables/collections | `database.md` |
| Dependency manifest (added/removed/upgraded) | `dependencies.md`, maybe `tech-landscape.md` |
| Design patterns, error handling, test setup, config | `patterns.md` |
| Linter/formatter config or naming conventions | `coding-style.md` |
| Container/compose setup | `docker.md` |
| Setup steps or common workflows | `onboarding.md` |
| Project name/description, or any doc added/removed | `INDEX.md` |

Prioritize structural changes (new/removed entry points, components, infra, data model) over cosmetic
ones. Skip pure internal refactors that don't change any documented interface, layout, or convention.

### Step 4 — Apply targeted edits

For each affected document:
1. Read it.
2. Make focused edits — change only what's now different; don't rewrite the whole file.
3. Update its `*Last Updated: YYYY-MM-DD*` line to today's real date.

Then carry out the additions and removals you identified in Step 3:
- **New doc for an aspect that appeared:** create it from the matching template in
  `../map-codebase/references/document-templates.md` (or, for a non-standard aspect, follow the same
  shape), then add it to `INDEX.md` and to the `documents` list in state.
- **Prune a doc for an aspect that vanished:** delete the now-empty doc (and its `INDEX.md` row), or
  prune the stale sections from a shared doc. Remove orphaned references.

### Step 5 — Re-record state

Rewrite `.claude/.codebase-info/.map-state.json` after the final document edits:
- `mappedAt`: today's date
- `gitCommit`: current `git rev-parse HEAD` (or `null` if not a git repo)
- `documents`: the current set of docs (reflecting any added/removed)
- `hashes`: SHA-256 hashes of the exact final contents of `INDEX.md` and every listed document
- keep `tool` and bump `version` to match the plugin if needed

Stage the final document contents first, then atomically replace `.map-state.json`. A manual edit or
interrupted write can leave hashes stale; that is safe because hooks hash live files and treat the
manifest only as a consistency check.

Then summarize for the user: which docs you updated, created, or removed, and why. Remind them to
commit the changes so the team and future sessions stay in sync.

## Guidelines

- **Surgical, not sweeping.** Targeted edits keep diffs reviewable and history meaningful.
- **Verify before writing.** Every path you add must exist; every path you remove must really be
  gone.
- **No churn for churn's sake.** If nothing meaningful changed, say so and update only the
  `mappedAt`/`gitCommit` in state (or nothing at all).
- **Never touch `CLAUDE.md`.** The plugin's hook handles loading; the map lives entirely in
  `.claude/.codebase-info/`. Leave `CLAUDE.md` (and `CLAUDE.local.md`) alone.

## Success criteria

- [ ] Changes since the last map detected (via stored commit, or mtime fallback)
- [ ] Warranted doc set re-assessed: docs added for aspects that appeared (e.g. Docker, a datastore),
      docs pruned for aspects that vanished
- [ ] Only affected documents edited; new areas documented; removed areas pruned
- [ ] `INDEX.md` reflects any added/removed docs
- [ ] `Last Updated` dates current on every touched doc
- [ ] `CLAUDE.md` left untouched
- [ ] `.map-state.json` rewritten with today's date, current commit, and document list
