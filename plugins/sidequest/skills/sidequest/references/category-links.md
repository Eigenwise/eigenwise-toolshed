# Category links: profile entries, board rows, and warnings

Routing profiles own complete, independent category sets. Each board points to one profile, then applies local rows on top. Profile edits propagate to boards that point at the profile. Board rows preserve their base profile and provenance.

## Row states

A category read with `withState: true` (or a board-scoped category list) reports its source and internal kind:

- `profile` — the board uses the selected profile entry unchanged.
- `added` (`ADD`) — a board-only full category row. If the selected profile has the same ID, the board row wins and emits `add-collision`.
- `detached` (`DETACH`) — a pinned full snapshot. Later profile edits do not touch it.
- `overridden` (`OVERRIDE`) — a patch over the selected profile row. The base snapshot remains available if that ID later disappears.
- `disabled` (`DISABLE`) — the board removes the category and keeps it disabled if a future profile adds the same ID.

Rows based on another profile emit a `foreign-base` warning. Full category output includes provenance, base profile, changed fields, and warnings. Compact output includes the selected profile and local-row count.

## Profile and board scope

Use profile scope to edit a profile entry and project scope to change one board's local policy. Mutations require exactly one scope:

```bash
sidequest category edit <id> --profile <profile> [--route-model ... --route-effort ...]
sidequest category edit <id> --project <path-or-slug> [--route-model ... --route-effort ...]
sidequest category pin <id> --project <path-or-slug>
sidequest category reset <id> --project <path-or-slug>
```

Profile lifecycle commands cover list, show, create, edit, retire, use, repoint, promote, and new-board selection. `repoint --dry-run` reports drift before changing board pointers. `promote` creates a profile from a board's effective taxonomy and repoints selected boards only when their normalized taxonomies match. Reset removes the board row so the category follows the selected profile again.

`general` must remain enabled in every profile and always resolves when a ticket category is missing or disabled. `global-fallback` is the model-availability fallback after category route and category fallback resolution, not a profile or category layer.

## Warnings

Board category reads expose `warnings` as objects. Do not treat them as strings:

- `{ kind: 'foreign-base', id, project, baseProfileId }` means a local row was created from another profile.
- `{ kind: 'add-collision', id, project }` means a board ADD wins over a profile entry with the same ID.
- `{ kind: 'override-using-snapshot', id, project }` means an OVERRIDE used its stored base because the selected profile lacks that ID.
- `{ kind: 'redundant-disable', id, project }` means a DISABLE currently has no matching profile entry but remains active for future additions.

These warnings are available through JSON CLI output, MCP responses, and dashboard/server payloads. The plain CLI category list renders human-readable messages where supported.
