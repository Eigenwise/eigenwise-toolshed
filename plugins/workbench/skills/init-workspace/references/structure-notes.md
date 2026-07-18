# Structure notes

A short doc capturing **how the project is meant to be laid out** — the organizing principle and where
things belong. It's the intent behind the directory tree, written down so a fresh session (or a new
contributor) puts new code in the right place instead of guessing.

## When it's a real deliverable vs a light touch

- **Greenfield (empty repo / bare scaffold / just a spec):** this is a **real deliverable.** There's
  no code yet for `map-codebase` to read, so the structure notes are where the intended shape gets
  captured. Spend real effort here — it's the seed the whole map grows from.
- **Existing codebase:** keep it **light.** `map-codebase` will document the actual structure
  (`directory-structure.md`). Here you're just capturing the *rules of the road* that aren't obvious
  from the tree: what the organizing principle is, and any "new X goes here, never there" conventions.
- **Not-a-codebase (wiki/notes/content):** capture the content organization instead — folder taxonomy,
  naming conventions, front-matter/tagging rules, where a new note or page goes.

## Where it goes

- Codebase project: `.claude/.codebase-info/structure.md` (so it sits with the map and can be linked
  from `INDEX.md`; for greenfield, `map-codebase`'s seed will fold it in).
- Not-a-codebase: a top-level `.claude/structure.md`, or a live-rules rule if it's short enough to be
  guidance rather than reference.

## Template

```markdown
# Project structure

*Last Updated: YYYY-MM-DD*

## What this project is
<one or two lines: the purpose, from the interview>

## Organizing principle
<layer-based | feature/domain-based | hexagonal/clean | monorepo | flat — and the one-line why>

## Where things go
| Kind of thing | Lives in | Notes |
|---------------|----------|-------|
| <e.g. domain logic> | `src/core/` | framework-free, pure |
| <e.g. UI components> | `src/lib/components/` | one folder per component |
| <e.g. tests> | mirrors the source tree | colocated `*.test.*` |
| <e.g. config> | `config/` | no secrets in the repo |

## Conventions that aren't obvious from the tree
- <new modules go here, not there>
- <this directory is a pure leaf — nothing imports upward into it>
- <naming: files kebab-case, types PascalCase, ...>

## Planned but not built yet   (greenfield only)
- <areas the layout anticipates but that have no code yet>
```

## Guidelines

- **Concrete paths, not vibes.** `src/core/` and a real rule beats "keep things organized."
- **Only what isn't obvious.** Don't restate the whole tree (the map does that). Capture the decisions
  and the "put new things here" conventions a reader can't infer.
- **Date it,** so staleness is visible.
- **Keep greenfield honest:** mark what's planned vs what exists, so nobody reads intent as reality.
