# Category links: project state, warnings, and inheritance

Read this when managing or explaining project-scoped category policy. Global categories are inherited by
projects unless a project-local row changes that relationship.

## Link states

A category read with `withState: true` (or a project-scoped category list) reports one of these states:

- `linked`: the project uses the global category unchanged.
- `added`: the project has an `ADD` row for a category that does not exist globally.
- `overridden`: the project patches a global category. The row also includes `changedFields`, the sorted
  keys present in the local patch, such as `['name', 'route']`.
- `detached`: the project has a `DETACH` row. The row contains a full snapshot of the effective category,
  so the project keeps its local content even if the global category is later edited or deleted.

Without `withState: true`, category reads keep their base shape and do not expose these annotations.

## Warnings

Project category-management reads expose `warnings` as objects. Do not treat them as strings:

- `{ kind: 'dangling-override', id, project }` means a project `OVERRIDE` remains after its global
  category was deleted. The local row is preserved, but it is omitted from the effective taxonomy until
  the global ID is restored.
- `{ kind: 'shadows-global', id }` means a detached project row still has the same ID as a global
  category. The detached snapshot wins for that project and intentionally shadows global updates.

These warning objects are available through JSON CLI output, MCP responses, and the dashboard/server
payloads. The plain CLI category list renders human-readable messages for both kinds.

## Detach and relink

Detach only from a project scope:

```bash
sidequest category detach <id> --project <path-or-slug>
sidequest category relink <id> --project <path-or-slug>
```

`detach` stores `{ project, id, kind: 'DETACH', data: <full snapshot> }` and returns the local row. It
refuses an already-detached category, `general`, or an ID that does not resolve. The dashboard uses the
same actions at `/api/categories/:id/detach` and `/api/categories/:id/relink`; detach asks for
confirmation because later global edits no longer affect the project, and relinking discards local
changes.

MCP exposes the same operations as `category_detach` and `category_relink`, each requiring `project`.
Relink is implemented by removing the project-local `OVERRIDE` or `DETACH` row, restoring inheritance
from global policy. A project-local `ADD` is not relinked by this operation.
