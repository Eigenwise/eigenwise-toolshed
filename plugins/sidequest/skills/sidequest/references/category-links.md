# Category links: shared defaults, board forks, and warnings

Read this when managing or explaining board-scoped category policy. Categories live in a **shared default**
policy (the global taxonomy). Every board inherits the shared defaults until it customizes a category, which
**forks** it into that board's own independent copy. In the UI these scopes read as **Shared defaults** and
the board's name.

## Link states

A category read with `withState: true` (or a board-scoped category list) reports one of these states. The
internal kind is in parentheses; the second name is the word the dashboard and CLI show:

- `linked` — inherited: the board uses the shared default unchanged. No badge.
- `added` (`ADD`) — added here: a board-only category that does not exist in the shared defaults.
- `detached` (`DETACH`) — customized: the board's own forked copy. It holds a full snapshot and no longer
  follows the shared default at all; later shared-default edits, renames, or deletion don't touch it.
- `overridden` (`OVERRIDE`) — legacy: a partial patch that still inherited untouched fields. No surface
  creates these anymore (editing forks instead), but old rows still resolve.

Without `withState: true`, category reads keep their base shape and do not expose these annotations.

## Editing forks; reset un-forks

- **Edit** a category with a board scope (`--project`, or the board scope in the dashboard) and it forks into
  that board's own copy (`DETACH`) — a full, independent snapshot that stops following the shared default.
  Editing with no board scope rewrites the **shared default** for every board that hasn't forked it.
- **Reset** removes the board's copy so the category follows the shared default again.

```bash
sidequest category edit <id>  --project <path-or-slug> [--route-model ... --route-effort ...]  # fork for this board
sidequest category reset <id> --project <path-or-slug>   # alias: relink — drop the fork, follow the shared default
```

Editing merges the current effective category with your changes and stores the full result as a `DETACH`. A
board-only category (no shared default) stays an `ADD`. `general` can be forked like any other category — a
forked `general` still always resolves.

MCP exposes `category_edit` (blast radius depends on whether `project` is passed — with `project` it forks),
and `category_relink` (reset). `category_detach` still exists but is rarely needed: editing already forks on
any change; use detach only to fork a category as-is with no edits. The dashboard drives the same
`/api/categories/:id/relink` endpoint and a board-scoped `DELETE` for reset.

## Deleting a shared default

A board that forked a category (a `DETACH`) already holds a full copy, so deleting the shared default leaves
it working and untouched. As a defensive path for legacy `OVERRIDE` rows (partial patches that predate the
fork model), `removeCategory` converts any such override into a full `DETACH` snapshot before removing the
shared default, so nothing is left dangling.

## Warnings

Board category reads expose `warnings` as objects. Do not treat them as strings:

- `{ kind: 'dangling-override', id, project }` — a legacy state: an `OVERRIDE` whose shared default is gone.
  Editing now forks (no new overrides), and deletion auto-converts overrides to full copies, so this only
  survives in data created before the fork model. A forked `DETACH` coexisting with a live shared default is
  the normal customized state and is **not** a warning.

This warning object is available through JSON CLI output, MCP responses, and the dashboard/server payloads.
The plain CLI category list renders a human-readable message for it.
