---
name: update-codebase-map
description: >-
  Refresh an existing .claude/.codebase-info/ map after code changes. Use for stale codebase or
  architecture docs; use map-codebase to create one.
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

### Step 2a — Decide whether to hand off

Do not ask the user whether to update the map, run this skill, or create a handoff. Decide using this
process, announce the applicable documentation-check outcome, and immediately perform the warranted
update or handoff without waiting for a reply.

A true no-op stays inline: report that no documented behavior, structure, interface, dependency, or
convention changed, then leave the map alone. Do not create a ticket merely to refresh timestamps or
state.

For a meaningful refresh, inspect the session tool roster before reading further. The handoff requires
the native `Agent` tool plus Sidequest `category_list`, `add`, `comment`, `dispatch`, and `pulse`. Do not
probe the Sidequest CLI or dashboard. Read the live `codebase-exploration` category and hand off only
when it is enabled and its contract permits one bounded documentation-artifact write while keeping
project source read-only.

- When the tools are absent, continue inline without an error banner.
- When Sidequest is present but the category is missing, disabled, or still read-only, continue inline
  and say: `Sidequest is loaded, but its live taxonomy cannot accept map artifacts yet.`
- When it is ready, create one `codebase-exploration` artifact ticket with
  `files: [".claude/.codebase-info/"]` and this exact clause. Creating and dispatching this ticket is the
  required default for a meaningful refresh; do it immediately without checking in with the user:
  `Artifact write carve-out: write only .claude/.codebase-info/**; all project source is read-only.`

The incremental ticket records the stored `gitCommit`, current `HEAD`, initial dirty-source status
outside `.claude/.codebase-info/`, and the current map document list. Its writer diffs from stored state
through the visible working tree, reassesses the warranted docs, preserves intentional manual map edits,
touches only affected docs, and replaces `.map-state.json` last. It must inspect the shared tree, verify
every cited path, skip generated/vendor/secret material, never touch `CLAUDE.md`, and never invoke
`map-codebase` or create nested mapping tickets. Include this lifecycle marker verbatim:

```text
Shared-tree artifact mode: leave the generated map as working-tree output; verify, comment, and close with done. Do not commit, submit, push, or edit source.
```

Before dispatch, comment this reason:

```text
Shared-tree dispatch is required because the map must describe the current working tree, including intentional uncommitted source, and the generated .claude/.codebase-info/** files must remain visible to the invoking session.
```

Dispatch with `{ sharedTree: true }`, pass returned spawn fields to the native `Agent` unchanged, then
end the turn. Resume only on native completion, never by polling or a proxy waiter. Do not make
concurrent project edits while the writer owns the shared tree.

On completion, inspect the ticket evidence and verify `INDEX.md`, changed paths, and hashes without
redoing the codebase reading:

```text
node -e "const fs=require('node:fs'),c=require('node:crypto'),p='.claude/.codebase-info/',s=JSON.parse(fs.readFileSync(p+'.map-state.json','utf8'));if(!Array.isArray(s.documents))throw Error('documents');for(const n of new Set(['INDEX.md',...s.documents])){const b=fs.readFileSync(p+n,'utf8');if(!s.hashes||s.hashes[n]!==c.createHash('sha256').update(b.replace(/\r/g,'')).digest('hex'))throw Error(n)}"
```

Require cited-path checks, docs created/updated/removed, and confirmation that `CLAUDE.md` is untouched.
A writer whose source snapshot moves reconciles once or releases rather than certifying a mixed snapshot.
For a broad diff, use a `codebase-exploration` story with read-only area tickets and one dependent final
artifact writer. Area tickets report paths, symbols, entry points, and flows in their threads; never use
nested generic tasks.

For an add, dispatch, spawn, or executor failure, inspect `pulse` and the ticket thread. Retry once only
when a diagnosis changes the launch and no live claim remains. After a second failure, record the
evidence, ensure no writer owns the claim, validate or repair any partial map inline in this shared tree,
replace state last, and comment that the ticket completed through inline fallback. Give the user one short
line naming the failure and inline fallback.

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
| Setup steps or common processes | `onboarding.md` |
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

After the final document edits, run the bundled state writer from the installed plugin:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/write-map-state.js" --project .
```

It discovers the current documents, records today's date and the current commit (or `null` outside a
git repo), hashes the final bytes, and atomically replaces `.map-state.json` last. A manual edit or
interrupted write can leave hashes stale; that is safe because hooks hash live files and treat the
manifest only as a consistency check.

Then summarize for the user: which docs you updated, created, or removed, and why. Commit the
refreshed map (outside shared-tree artifact mode, where committing is forbidden), and make sure the
commit includes **`.map-state.json` alongside the edited docs**: an uncommitted manifest means every
other checkout sees stale hashes and re-flags docs that are actually current. If `git check-ignore
.claude/.codebase-info/INDEX.md` matches (a broad `.claude/*` rule), add `!.claude/.codebase-info/`
and `!.claude/.codebase-info/**` to `.gitignore` in the same commit; the ignore warning on `git add`
does not mean the map is local-only. If committing right now would be wrong for the user's flow, say
plainly that the map changes including `.map-state.json` still need committing.

## Guidelines

- **Surgical, not sweeping.** Targeted edits keep diffs reviewable and history meaningful.
- **Verify before writing.** Every path you add must exist; every path you remove must really be
  gone.
- **No churn for churn's sake.** If nothing meaningful changed, say so and leave the map and state
  untouched.
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
- [ ] Map changes committed including `.map-state.json` (or the user told plainly they still need
      committing)
