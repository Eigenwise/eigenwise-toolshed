# Category links: shared defaults, board customizations, and warnings

Read this when managing or explaining board-scoped category policy. Categories live in a **shared default**
policy (the global taxonomy). Every board inherits the shared defaults until a board-local row changes that
relationship. In the UI these scopes read as **Shared defaults** and the board's name.

## Link states

A category read with `withState: true` (or a board-scoped category list) reports one of these states. The
internal kind is in parentheses; the second name is the word the dashboard and CLI show:

- `linked` — inherited: the board uses the shared default unchanged. No badge.
- `added` (`ADD`) — added here: the board has a category that does not exist in the shared defaults.
- `overridden` (`OVERRIDE`) — customized: the board patches a shared default. The row also includes
  `changedFields`, the sorted keys in the patch, e.g. `['name', 'route']`. Fields you did not change keep
  following the shared default, so later shared-default fixes to those fields still flow in.
- `detached` (`DETACH`) — pinned: the board holds a full snapshot and ignores the shared default entirely,
  surviving later shared-default edits, renames, or deletion.

Without `withState: true`, category reads keep their base shape and do not expose these annotations.

## Editing = customizing; reset and pin

- **Edit** a category with a board scope (`--project`, or the board scope in the dashboard) and the change is
  saved as that board's **customization** (`OVERRIDE`). Other boards keep the shared default. Editing with no
  board scope rewrites the **shared default** for every board that hasn't customized it.
- **Reset** drops a board's customization or pin so it follows the shared default again.
- **Pin** freezes a board's copy against future shared-default changes. Normal customizing already keeps your
  own changes, so pin is only for a hard fork (e.g. you want this board immune to a shared-default rename or
  removal).

```bash
sidequest category edit <id>  --project <path-or-slug> [--route-model ... --route-effort ...]  # customize
sidequest category reset <id> --project <path-or-slug>   # alias: relink — back to the shared default
sidequest category pin <id>   --project <path-or-slug>   # alias: detach — freeze this board's copy
```

`pin` stores `{ project, id, kind: 'DETACH', data: <full snapshot> }` and returns the local row. It refuses
an already-pinned category, `general`, or an ID that does not resolve. `reset` removes the board-local
`OVERRIDE` or `DETACH` row; a board-local `ADD` is deleted by the normal delete action, not reset.

MCP exposes these as `category_edit` (blast radius depends on whether `project` is passed), `category_detach`
(pin), and `category_relink` (reset), each board operation requiring `project`. The dashboard drives the same
`/api/categories/:id/detach` and `/api/categories/:id/relink` endpoints, plus a board-scoped `DELETE` for
reset.

## Deleting a shared default auto-pins its customizations

When a shared default is removed, every board that only **customized** it (an `OVERRIDE`) is auto-pinned:
the board's effective category is frozen into a full `DETACH` snapshot so it keeps working. A board is never
left with a customization pointing at a shared default that no longer exists.

## Warnings

Board category reads expose `warnings` as objects. Do not treat them as strings:

- `{ kind: 'shadows-global', id }` — a pinned board row has the same ID as a live shared default. The pinned
  snapshot wins for that board and intentionally ignores shared-default updates.
- `{ kind: 'dangling-override', id, project }` — a legacy state: a customization whose shared default is
  gone. New deletions can't produce this (they auto-pin instead); it only survives in data created before
  auto-pin existed.

These warning objects are available through JSON CLI output, MCP responses, and the dashboard/server
payloads. The plain CLI category list renders human-readable messages for both kinds.
