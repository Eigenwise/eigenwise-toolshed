# Category system contract

This is the implementation contract for category-based routing. Categories are a global taxonomy for one Sidequest home, not project-specific. Tickets store only a category ID, so a user changes a category's route once and every ticket using it resolves through the new route on its next read.

## 1. Storage, defaults, and ownership

Add a SQLite `categories` table with `id TEXT PRIMARY KEY, data TEXT`, and add it to `TABLES` in [`lib/db.js:21-27`](../lib/db.js#L21-L27). `data` holds this row shape:

```json
{
  "id": "coding.normal",
  "name": "Standard coding",
  "description": "Classifier text sent to the dispatcher.",
  "route": { "model": "grade-3", "effort": "high" },
  "contract": "Executor instructions fragment.",
  "enabled": true
}
```

Use a table, rather than a `globals` row, for independently addressable category CRUD and predictable per-row usage counts. It follows the existing generic row pattern in [`lib/db.js:77-125`](../lib/db.js#L77-L125), keeps a taxonomy from becoming one conflict-prone JSON blob, and lets the dashboard list/update one category without rewriting all others. The taxonomy is global because `globals` are already home-wide rather than project-bound ([`lib/store.js:234-241`](../lib/store.js#L234-L241)), while every ticket must resolve the same ID consistently across projects.

The shipped taxonomy is the initial data source in [`docs/category-defaults.md`](category-defaults.md). Seed it in a transaction after the `categories` table exists:

- On a fresh database, insert every shipped row exactly once.
- On an existing database, insert only a shipped ID that does not already exist. Never update an existing row from shipped defaults.
- User-created, edited, disabled, and deleted rows are user-owned. Upgrades cannot recreate a deleted non-`general` default.
- `general` is required. Category removal must reject `general`; edits may change its text and route but may not remove or disable it.

Store `category` as an optional ticket property in the existing ticket JSON `data` payload, introduced by [`createTicket()` at `lib/store.js:1221-1281`](../lib/store.js#L1221-L1281) and accepted by [`updateTicket()` at `lib/store.js:1384-1449`](../lib/store.js#L1384-L1449). It is an ID, never an embedded category snapshot. Existing `putTicket()` deliberately persists the ticket body while stripping read-time fields such as `exec` and `profile` ([`lib/store.js:214-228`](../lib/store.js#L214-L228)); category resolution belongs beside that same read-time derivation.

## 2. Read-time resolution and legacy complexity

Category routing is live, like the existing complexity routing. Resolve every ticket in this order:

1. If `ticket.category` names an existing, enabled taxonomy row, use that row.
2. If `ticket.category` is absent, use legacy `complexity` exactly as today through `deriveRouting()` ([`lib/store.js:738-745`](../lib/store.js#L738-L745)) and `routingLadder()` ([`lib/store.js:582-735`](../lib/store.js#L582-L735)).
3. If `ticket.category` is unknown, deleted, or disabled, resolve `general` and include a read warning identifying the invalid ID.
4. Resolve the selected category row's `route.model` and `route.effort` through the existing `resolveExec()` seam ([`lib/store.js:456-470`](../lib/store.js#L456-L470)).

Put this precedence in `applyDerivedRouting()` ([`lib/store.js:753-777`](../lib/store.js#L753-L777)), before its current `if (t.complexity)` branch. A present category takes precedence even when a legacy complexity score remains on the ticket. Complexity-only tickets retain the current behavior unchanged, including live rerouting when model preferences change ([`lib/store.js:499-509`](../lib/store.js#L499-L509)).

Validate a category route's model with the existing provider-neutral tier vocabulary, `coerceModel()` ([`lib/store.js:301-306`](../lib/store.js#L301-L306)), and effort with `coerceEffort()` ([`lib/store.js:324-329`](../lib/store.js#L324-L329)). Category routes may name a configured grade or a discovered backend slug only where the implementation extends the route resolver to do so. A route pointing at an unavailable backend must degrade through the same `resolveTierBackends()` path as `tierBackend`: fall back to the grade's default Claude runtime and append the equivalent warning ([`lib/store.js:407-433`](../lib/store.js#L407-L433)). Do not throw or make tickets undispatchable.

The current code has a mismatch with the requested route shape: `resolveExec()` accepts a grade plus effort, while discovered backend slugs only live as *per-grade* `tierBackend` settings ([`lib/store.js:341-345`](../lib/store.js#L341-L345)). Proposed resolution: add a category-route resolver that converts a grade route to the normal `resolveExec()` call, and converts an explicit discovered backend route to the same resolved backend object and warning semantics as `resolveTierBackends()`. Keep ticket `model` stamped with the canonical grade so filters, claims, provenance, and generated executor names remain compatible.

The resolved ticket must continue to expose the existing `exec` object (`agent`, `model`, `backend`, `runsModel`, `runsLabel`, `dispatch`) assembled in [`applyDerivedRouting()` at `lib/store.js:759-773`](../lib/store.js#L759-L773). Add a `category` read projection containing at least `{ id, name, description, contract, enabled, route, fallback }`; `fallback` is true when an invalid ID resolved to `general`. This gives dispatch callers both the classification and the executor-specific instruction fragment without putting the category record into the persisted ticket body.

## 3. Tickets with neither category nor complexity

A ticket missing both fields has no route today: `applyDerivedRouting()` only resolves complexity or a legacy stored model ([`lib/store.js:753-775`](../lib/store.js#L753-L775)). Reads must instead provide the taxonomy so the dispatching agent can classify before it claims/spawns the ticket.

`listPayload()` and `readyPayload()` are the shared CLI/MCP read seams ([`lib/store.js:2242-2255`](../lib/store.js#L2242-L2255), [`lib/store.js:2262-2268`](../lib/store.js#L2262-L2268)). Both must add a top-level `categories` array, with each enabled row's exact classifier inputs:

```json
{
  "id": "coding.normal",
  "name": "Standard coding",
  "description": "Classifier text",
  "route": { "model": "grade-3", "effort": "high" },
  "contract": "Executor instructions fragment"
}
```

Full ticket reads also carry `category: null` until classified. Brief rows from `briefTicket()` ([`lib/store.js:2157-2181`](../lib/store.js#L2157-L2181)) must carry `categoryId`, `categoryName`, and the resolved route fields already represented by `model`, `effort`, and `exec`/backend fields. A caller classifies from the top-level taxonomy, calls update with the selected `category` ID, then re-reads before dispatch. It must never silently infer and persist a category during a list or ready read.

Current creation surfaces reject missing complexity: CLI [`cmdAdd()` at `bin/sidequest.js:192-218`](../bin/sidequest.js#L192-L218), MCP `add` at [`lib/mcp.js:259-301`](../lib/mcp.js#L259-L301), and dashboard `POST /api/tickets` at [`lib/server.js:307-358`](../lib/server.js#L307-L358). That contradicts the requested missing-both flow. Proposed resolution: allow create when a valid category is supplied, retain complexity+why as the legacy alternative, and allow deliberately unclassified tickets only when the caller opts in. The UI should ask for a category; APIs need an explicit `unclassified: true` guard so accidental omissions remain errors.

## 4. Public surfaces

### CLI

Add `sidequest category list`, `add`, `edit`, and `rm` command handlers and cases adjacent to the existing command dispatch in [`bin/sidequest.js:1646-1770`](../bin/sidequest.js#L1646-L1770). `rm general` fails. `list` prints rows and usage counts. `add`/`edit` accept all editable row fields, while IDs are immutable after creation. `rm` rejects `general` and reports affected ticket counts; those tickets resolve to `general` on later reads rather than being rewritten.

Extend `cmdAdd()`/`cmdUpdate()` at [`bin/sidequest.js:192-317`](../bin/sidequest.js#L192-L317) with `--category <id>`. Extend JSON `list` and `ready` reads, [`cmdList()` at `bin/sidequest.js:234-277`](../bin/sidequest.js#L234-L277) and [`cmdReady()` at `bin/sidequest.js:825-862`](../bin/sidequest.js#L825-L862), to emit the taxonomy and per-ticket category projection. Extend `cmdModels()` ([`bin/sidequest.js:958-1021`](../bin/sidequest.js#L958-L1021)) to emit the taxonomy, resolved category routes, and warnings, since it is the machine-readable routing inventory.

### MCP

Add `category` to the `add` and `update` schemas and handlers at [`lib/mcp.js:259-341`](../lib/mcp.js#L259-L341). Add category CRUD tools matching the CLI names and validation. Extend `list` ([`lib/mcp.js:204-237`](../lib/mcp.js#L204-L237)), `ready` ([`lib/mcp.js:240-256`](../lib/mcp.js#L240-L256)), and `models` ([`lib/mcp.js:621-637`](../lib/mcp.js#L621-L637)) with taxonomy, category warnings, and each ticket's resolved route. Update tool descriptions and the compact-row contract so agents know to classify then update an unclassified ticket.

### Dashboard

Use the existing ticket API: `GET /api/tickets` ([`lib/server.js:289-305`](../lib/server.js#L289-L305)), `POST /api/tickets` ([`lib/server.js:307-359`](../lib/server.js#L307-L359)), and `PATCH`/`PUT /api/tickets/:id` ([`lib/server.js:362-384`](../lib/server.js#L362-L384)). Add category taxonomy endpoints under `/api/categories` for CRUD and usage counts. The dashboard is a single file at [`dashboard/index.html`](../dashboard/index.html), which already renders model chips ([`dashboard/index.html:473-479`](../dashboard/index.html#L473-L479)) and model settings. Add a taxonomy CRUD panel, show per-row usage counts, put a category badge on each card, and add the category picker to ticket create/edit. Counts are computed from all non-archived and archived tickets in the requested board scope, never cached in category data.

### Skills and hooks

Update [`skills/sidequest/SKILL.md:98-114`](../skills/sidequest/SKILL.md#L98-L114) and its routing/dispatch instructions at [`skills/sidequest/SKILL.md:245-307`](../skills/sidequest/SKILL.md#L245-L307): choose a category, record it on the ticket, then trust the returned resolved `exec` object. Update the active-board instructions emitted by [`hooks/capture-nudge.js:159-207`](../hooks/capture-nudge.js#L159-L207) and [`hooks/session-start.js:111-132`](../hooks/session-start.js#L111-L132) to point agents to category-aware list/ready reads and the update-before-dispatch rule. `hooks/force-exec-bypass.js:76-87` already obtains the routed ticket via `store.getTicket()` and `resolveExec()`; it needs no independent taxonomy lookup once `applyDerivedRouting()` produces the canonical model/effort/exec fields.

## 5. Migration and schema versions

This change does not rewrite or delete existing tickets. Ticket JSON remains in `tickets.data`; the only per-ticket migration is optional, lazy category resolution at read time. A missing category preserves complexity routing. An unknown category resolves to `general` in memory and must not be silently persisted as `general`, so a user can see and repair the original invalid ID.

The current SQLite schema creates tables in [`openDb()` at `lib/db.js:35-75`](../lib/db.js#L35-L75) and writes `meta.schema_version = "1"` with `INSERT OR IGNORE`, but nothing reads or increments it. The JSON-to-SQLite migration is independently guarded by `meta.json_migrated` in [`migrateIfNeeded()` at `lib/migrate.js:52-73`](../lib/migrate.js#L52-L73). That is a contradiction with the requested schema-version migration rule: no version-gated database migration layer exists yet.

Implement schema version 2 explicitly:

1. Define one current schema version in `lib/db.js`.
2. On open, create the base tables idempotently, then read `meta.schema_version`.
3. In one `db.txn()` transaction ([`lib/db.js:127-144`](../lib/db.js#L127-L144)), apply each pending additive migration in order. Version 2 creates `categories`, seeds only absent default IDs, and writes `schema_version = "2"` only after all work succeeds.
4. Preserve `json_migrated` as a separate, one-time JSON import marker. Do not conflate it with schema version or rerun JSON import during a category upgrade.
5. Every later version is additive or has an explicit non-destructive migration. Never overwrite user category rows, delete ticket data, or transform a missing/invalid category ID without a user action.

This matches the existing non-destructive import guarantee: [`migrateIfNeeded()` reads old JSON, writes it inside a transaction, marks completion last, and leaves source files untouched](../lib/migrate.js#L52-L73).
