# Category system contract v2

Categories are global routing policy. A ticket persists a category ID, never a route snapshot, so a category edit takes effect on the next read. This replaces capability grades with concrete model routes. The target schema is v3.

## 1. Category rows, fallback storage, and availability

A category row is stored in the SQLite `categories` table ([`lib/db.js:24-31`](../lib/db.js#L24-L31)) and has this v2 shape:

```json
{
  "id": "coding.normal",
  "name": "Standard coding",
  "description": "Classifier text sent to the dispatcher.",
  "route": { "model": "codex-gpt-5-6-terra", "effort": "high" },
  "fallback": { "model": "opus", "effort": "high" },
  "contract": "Executor instructions fragment.",
  "enabled": true
}
```

`route` and optional `fallback` accept a Claude runtime (`haiku`, `sonnet`, `opus`, or `fable`) or a discovered, source-qualified Codex slug. Claude runtimes are always available. A Codex slug is available only when the current discovery result contains it, using the source-qualified catalog keys from [`discoveredByKey()` at `lib/store.js:367-379`](../lib/store.js#L367-L379). `effort` remains independently validated by [`coerceEffort()` at `lib/store.js:327-332`](../lib/store.js#L327-L332).

The required global fallback lives in the global row named `routing-fallback`, using the existing home-wide global helpers ([`lib/store.js:237-244`](../lib/store.js#L237-L244)):

```json
{ "model": "sonnet", "effort": "high" }
```

This is a separate global row, rather than part of model preferences, because it remains the last ordinary routing policy after the old model-preference system is deleted. Its shipped value is Sonnet/high. A malformed or missing global row falls through to the hardwired Sonnet/high safety net and produces a warning.

Resolution is deterministic:

1. Resolve `category.route` when its model is available.
2. Otherwise resolve the category's `fallback`, if present and available.
3. Otherwise resolve global `routing-fallback`, if valid.
4. Otherwise launch hardwired `sonnet` at `high` and append a warning.

The resolved concrete model plus effort produces the existing native-agent shape. Preserve the agent-name construction in [`resolveExec()` at `lib/store.js:451-477`](../lib/store.js#L451-L477), but change its input contract from a capability alias to `{ model, effort }`. Tickets expose `exec` only as a read projection, as `putTicket()` already strips it before persistence ([`lib/store.js:215-230`](../lib/store.js#L215-L230)).

**Current-code conflict.** `normalizeCategory()` currently accepts a category route without a fallback and defaults it to a capability alias ([`lib/store.js:770-793`](../lib/store.js#L770-L793)). `resolveCategoryRoute()` then invents an alias for a direct Codex route, including one from `suggestedTier` ([`lib/store.js:818-843`](../lib/store.js#L818-L843)). Replace both with concrete route validation and the ordered fallback chain above. A direct Codex route must not infer an unrelated capability identity.

## 2. Read-time routing, legacy scores, and filtering

`applyDerivedRouting()` is the one read-time routing seam ([`lib/store.js:854-900`](../lib/store.js#L854-L900)). It resolves a present, enabled category first. An unknown or disabled ID still projects `general` without changing the persisted ID, but its own route now follows the same fallback chain.

Legacy tickets that have complexity but no category map at read time only:

| Complexity | Category |
| --- | --- |
| 1–3 | `coding.easy` |
| 4–6 | `coding.normal` |
| 7–10 | `coding.hard` |

Do not persist this mapped category. Mark the ticket with a read warning such as `Legacy complexity 5 mapped to coding.normal; update the ticket to persist a category.` A ticket with neither field remains unclassified and is not dispatchable until classification.

The model field on full and brief ticket reads becomes the resolved concrete slug or Claude runtime. `briefTicket()` is the compact projection to update ([`lib/store.js:2283-2310`](../lib/store.js#L2283-L2310)); `listPayload()` and `readyPayload()` are the shared CLI/MCP read payloads ([`lib/store.js:2370-2398`](../lib/store.js#L2370-L2398)). Keep top-level enabled categories there so an orchestrator can classify an unclassified ticket and update it before dispatch.

`ready` and `next` model filters match the resolved concrete model, including the current runtime slug for a direct Codex route. Add an optional category-ID filter for stable policy-based selection. Unknown model values remain errors, never an empty filter. This replaces the current capability-only filter parser in [`classifyModelFilter()` at `lib/store.js:494-504`](../lib/store.js#L494-L504), the CLI guard at [`bin/sidequest.js:479-499`](../bin/sidequest.js#L479-L499), and MCP validation at [`lib/mcp.js:137-162`](../lib/mcp.js#L137-L162).

**Current-code conflict.** Complexity still feeds `routingLadder()` through `deriveRouting()` ([`lib/store.js:745-752`](../lib/store.js#L745-L752)), so it can change with preferences. The legacy band mapping above is intentionally fixed and category-based. Delete the ladder path rather than retaining a second routing policy.

## 3. Deleted routing apparatus

Delete these concepts and their persisted preference fields:

- `VALID_MODELS`, `GRADE_TIER`, profile aliases, and capability labels ([`lib/store.js:271-308`](../lib/store.js#L271-L308)).
- `tierBackend`, `normalizeTierBackend()`, and `resolveTierBackends()` ([`lib/store.js:381-440`](../lib/store.js#L381-L440)).
- The complexity ladder, bias control, enabled-runtime matrix, and per-runtime effort matrix ([`lib/store.js:519-752`](../lib/store.js#L519-L752)).
- Grade/profile payloads in `models`, and capability filters on `claim` and `next`.

Executor generation remains concrete-model × effort. A Claude route keeps the generic Claude executor behavior; a discovered Codex route keeps its generated backend-specific executor. The claim check compares the executor that the resolved `exec` projection names, rather than special-casing complexity tickets as [`executorDriftReason()` does now](../bin/sidequest.js#L501-L524).

## 4. Schema v3 migration and write protection

`CURRENT_SCHEMA_VERSION` and the ordered transaction migration in [`lib/db.js:22-100`](../lib/db.js#L22-L100) are the migration anchor. Schema v3 must run inside `txn()` ([`lib/db.js:153-170`](../lib/db.js#L153-L170)), update the version only after success, and refuse an older writer before it can write a newer store.

Migration steps are non-destructive and one-way:

1. Read each category's old capability-valued route while the current backend-resolution code is still available.
2. Materialize its current resolved backend as `route.model`; preserve its route effort.
3. Add `fallback` with that old capability's Claude runtime and the preserved effort.
4. Remove obsolete global model-preference data, then seed `routing-fallback` as `{ model: "sonnet", effort: "high" }` only when it is absent or invalid.
5. Set `schema_version` to `3` last.

Migration notes are the only place old capability aliases belong in this document. The mapping must be captured before deleting [`resolveTierBackends()`](../lib/store.js#L417-L440). Do not rewrite ticket category IDs or materialize legacy complexity mappings. The existing future-schema refusal ([`lib/db.js:97-99`](../lib/db.js#L97-L99)) is the read-side guard, but the current database API has no writer-version guard across running binaries. Add the guard at database open/write ownership so an old process cannot write after a v3 process migrated the home.

**Current-code conflict.** The current database is schema v2, creates categories during migration, and has no v3 migration or global fallback row ([`lib/db.js:76-95`](../lib/db.js#L76-L95)). The contract requires those changes before removing the old router.

## 5. Public surface contract

### CLI

Keep category CRUD at [`cmdCategory()` in `bin/sidequest.js:331-390`](../bin/sidequest.js#L331-L390), adding `--fallback-model` and `--fallback-effort` to add/edit. Add a global fallback settings command rather than exposing a generic preference blob. `category list` and `models` show configured route, fallback, resolved route, and warnings.

`cmdAdd()` and `cmdUpdate()` already accept a category ([`bin/sidequest.js:199-329`](../bin/sidequest.js#L199-L329)). They should continue to reject direct ticket model/effort overrides. `ready`, `next`, and their help text move from capability filtering to resolved-model and category filtering ([`bin/sidequest.js:607-616`](../bin/sidequest.js#L607-L616), [`bin/sidequest.js:898-910`](../bin/sidequest.js#L898-L910)).

### MCP

Keep category selection on `add` and `update` ([`lib/mcp.js:259-360`](../lib/mcp.js#L259-L360)) and category CRUD ([`lib/mcp.js:642-703`](../lib/mcp.js#L642-L703)). Extend category schemas with fallback fields and add a global-fallback settings tool. `list`, `ready`, and `models` return concrete route data and resolution warnings. Update `ready`/`next` tool descriptions and schemas from capability filtering to `model` and `category` filters ([`lib/mcp.js:241-256`](../lib/mcp.js#L241-L256), [`lib/mcp.js:416-435`](../lib/mcp.js#L416-L435)).

### Dashboard

The existing taxonomy endpoints at [`lib/server.js:305-374`](../lib/server.js#L305-L374) accept and return route data; extend them for fallback and add a global-fallback endpoint or model-settings replacement. Ticket POST already permits a category or deliberate unclassified intake ([`lib/server.js:395-452`](../lib/server.js#L395-L452)).

Replace the dashboard's tier settings, ladder, bias, and route-picker assumptions with category route/fallback editing. The current category form builds options from capability aliases and discovered backends ([`dashboard/index.html:2093-2101`](../dashboard/index.html#L2093-L2101)); it should instead offer Claude runtimes plus discovered concrete models for both route fields. Remove the model-preference and ladder UI rooted at [`dashboard/index.html:1122-1217`](../dashboard/index.html#L1122-L1217) and the category-by-capability display at [`dashboard/index.html:1835-1954`](../dashboard/index.html#L1835-L1954).

## 6. Default taxonomy and downstream architecture

[`category-defaults.js`](../lib/category-defaults.js) is the executable seed source, and [`category-defaults.md`](category-defaults.md) is the human reference. Each shipped row must pin its recommended concrete backend in `route`, retain its existing effort, and name its prior Claude runtime in `fallback`.

The modular architecture's engine lift changes from a capability ladder to a category-to-model router. The gateway catalog remains discovery data. It must not supply a policy-derived replacement route when a selected backend disappears: category fallback, global fallback, then the hardwired safety net own that decision.

## 7. v3 project-scoped taxonomy layer

This section is the next contract change after the concrete-route v2 policy above. It changes storage to schema v4. It does not introduce a repository `.claude/sidequest.json` layer yet.

### 7.1 Storage: one local row per project and category ID

Schema v4 adds a `project_categories` table with `project`, `id`, `kind`, and `data` columns, keyed by `PRIMARY KEY (project, id)`. `project` is the existing stable project slug, not a path. Use the same slug construction as [`slugify()` in `lib/store.js:62-71`](../lib/store.js#L62-L71), the same denormalized project key used by ticket and story rows ([`lib/db.js:27-34`](../lib/db.js#L27-L34)), and the existing ticket project indexes ([`lib/db.js:52-70`](../lib/db.js#L52-L70)).

The table is a sparse local layer over the global `categories` table, which deliberately remains keyed only by category ID in v3 ([`lib/db.js:27-34`](../lib/db.js#L27-L34)). Each `(project, id)` has exactly one of these forms:

| Kind | `data` | Effective result |
| --- | --- | --- |
| `ADD` | A complete category row | Adds a project-local category. Its ID must not already exist globally. |
| `OVERRIDE` | `{ "name"?, "description"?, "contract"?, "route"?, "fallback"? }` | Patches only the present keys over an existing global category. |
| `DISABLE` | `{}` | Hides an existing global category in this project. |

A music project such as `C:\dev\BMR` can therefore add `music-analysis` and `composing`, then override the route for `coding.normal`, without either category or route appearing in a coding project. Project-local `ADD` rows use the same normalized full-row shape as [`normalizeCategory()` in `lib/store.js:434-449`](../lib/store.js#L434-L449). `OVERRIDE` rows must reject keys outside the five patchable fields above. A local override cannot change a global row's ID or enabled state; `DISABLE` is the local visibility control.

### 7.2 Effective taxonomy: merge once at the category read seam

The canonical merge point is `getCategories({ project })`, with `getCategory(id, { project })` reading from that result. Start with normalized global rows from the current category read seam ([`lib/store.js:418-449`](../lib/store.js#L418-L449)), then apply the selected project's `project_categories` rows by ID:

1. Apply `ADD` only when no global row has that ID.
2. Apply an `OVERRIDE` as a key-level patch over its global base row.
3. Remove a global base row when its local row is `DISABLE`.
4. Normalize and sort the resulting effective rows before returning them.

No caller may independently merge rows. `applyDerivedRouting()` must resolve through the effective lookup ([`lib/store.js:502-540`](../lib/store.js#L502-L540)); `listTickets()` and `getTicket()` already centralize that read projection ([`lib/store.js:924-941`](../lib/store.js#L924-L941)). `listPayload()` and `readyPayload()` must expose the effective classifier taxonomy for their requested project ([`lib/store.js:2008-2036`](../lib/store.js#L2008-L2036)), and `modelsPayload({ project })` must expose the same effective rows and route warnings ([`lib/store.js:366-381`](../lib/store.js#L366-L381)). This keeps CLI, MCP, dashboard, ticket classification, ready filtering, and executor derivation on one policy.

### 7.3 Invariants and orphan handling

`general` is always effective. Reject a project `DISABLE` for `general`; a project may still `OVERRIDE` its `name`, description, contract, route, or fallback. The existing global guards in [`setCategory()` and `removeCategory()`](../lib/store.js#L451-L468) remain the baseline. Removing a local row means removing the local patch and restoring its global base, never deleting that base.

Reject an `ADD` when its ID collides with a global category, including a global category currently disabled in the selected project. This prevents a local row from silently changing meaning when the global row changes.

Deleting a global category auto-pins the boards that customized it: each project `OVERRIDE` for that ID is converted into a `DETACH` snapshot of its effective (base + patch) value before the global row is removed, so the board keeps a working category instead of a dangling record ([`removeCategory()` in `lib/store.js`](../lib/store.js)). A `DETACH` row keeps its full local snapshot and remains effective for the project; when a global row with the same ID still exists, report `{ kind: 'shadows-global', id }` because the pinned snapshot intentionally ignores global policy. The `{ kind: 'dangling-override', id, project }` warning is retained only as a defensive path for legacy data created before auto-pin existed; normal deletion no longer produces it. Existing tickets with the deleted ID retain that persisted ID and continue through the existing unknown-category-to-`general` projection ([`lib/store.js`](../lib/store.js)). A project-local `ADD` may use an ID only after no global row exists. Resetting (relink) removes the project-local `OVERRIDE` or `DETACH` row and restores shared-default inheritance; resetting a pinned category discards its local snapshot. `DISABLE` rows remain project-local management records and are not included in the dangling-override warning.

### 7.4 Usage counts and classification

Ticket rows already carry `project` and category IDs separately from their derived routing data ([`lib/store.js:214-232`](../lib/store.js#L214-L232), [`lib/db.js:52-64`](../lib/db.js#L52-L64)). Count category usage by filtering tickets for the selected project, then matching stored `categoryId`; never infer a count from the effective taxonomy or scan every project. The current dashboard helper is already project-parameterized at [`categoryUsageCounts(project)` in `lib/server.js:111-133`](../lib/server.js#L111-L133), while CLI and MCP category lists currently obtain usage in their active project ([`bin/sidequest.js:329-407`](../bin/sidequest.js#L329-L407), [`lib/mcp.js:625-633`](../lib/mcp.js#L625-L633)). Schema v4 keeps that scope.

Classification confirmation receives only enabled effective categories for the target project through `classifierCategories()` ([`lib/store.js:470-472`](../lib/store.js#L470-L472)) and the shared list/ready payloads. `cmdAdd()`/`cmdUpdate()` and the MCP add/update tools validate a selected ID against that same effective enabled set, not the global table ([`bin/sidequest.js:190-241`](../bin/sidequest.js#L190-L241), [`lib/mcp.js:245-340`](../lib/mcp.js#L245-L340)). An unseen music-only category can be chosen in `C:\dev\BMR`; it must be rejected in a coding project.

### 7.5 Public surfaces

All category CRUD gains an explicit scope. Global is the default, preserving today's home-wide category management. Passing `--project <path-or-slug>` selects that project's local layer for CLI category commands at [`cmdCategory()` in `bin/sidequest.js:329-407`](../bin/sidequest.js#L329-L407): `ADD` writes a local row, edit writes an `OVERRIDE`, and remove either removes the local layer row or creates/removes a `DISABLE` record as the requested local action requires. The existing ticket `--category` and `ready`/`next` category filters continue to operate against the selected project's effective taxonomy ([`bin/sidequest.js:933-938`](../bin/sidequest.js#L933-L938)).

MCP adds the same optional project scope to `category_list`, `category_add`, `category_edit`, and `category_rm` ([`lib/mcp.js:625-719`](../lib/mcp.js#L625-L719)). With no project argument, these mutate global policy. With a project, results return local row kind, effective row, and orphan warnings. `add`, `update`, `ready`, `next`, and `models` read the effective taxonomy for their board project ([`lib/mcp.js:226-245`](../lib/mcp.js#L226-L245), [`lib/mcp.js:402-419`](../lib/mcp.js#L402-L419), [`lib/mcp.js:721-727`](../lib/mcp.js#L721-L727)). The existing home-wide `global_fallback` surface remains unchanged in this phase ([`lib/mcp.js:690-707`](../lib/mcp.js#L690-L707)).

The dashboard category panel gets a `Global` / `This project` scope toggle. Its existing endpoints are [`GET/POST /api/categories`](../lib/server.js#L312-L345) and [`PATCH|PUT|DELETE /api/categories/:id`](../lib/server.js#L347-L381); each accepts the selected project scope and returns effective rows plus local-layer metadata. The panel at [`dashboard/index.html:684-686`](../dashboard/index.html#L684-L686), loaded by [`loadCategories()` at `dashboard/index.html:1192-1195`](../dashboard/index.html#L1192-L1195) and rendered by [`renderCategorySettings()` at `dashboard/index.html:1747-1821`](../dashboard/index.html#L1747-L1821), badges local `ADD` rows, presents `OVERRIDE` values as deltas from their global base, and shows disabled/orphan records as local management state. Ticket category pickers continue to render only enabled effective choices ([`dashboard/index.html:1822-1836`](../dashboard/index.html#L1822-L1836)).

### 7.6 Schema v4 migration and future configuration layers

The v4 migration is additive: create `project_categories` and its project index inside the existing ordered transaction migration in [`openDb()` at `lib/db.js:42-143`](../lib/db.js#L42-L143), then update `meta.schema_version` to `4` last. Existing global categories and tickets are unchanged, and no local rows are seeded. Bump `CURRENT_SCHEMA_VERSION` from `3` ([`lib/db.js:23`](../lib/db.js#L23)); preserve the current future-schema read refusal and writer guard ([`lib/db.js:100-102`](../lib/db.js#L100-L102), [`lib/db.js:152-158`](../lib/db.js#L152-L158)). Use `txn()` for the migration ([`lib/db.js:205-224`](../lib/db.js#L205-L224)).

A committable `.claude/sidequest.json` file layer is explicitly out of scope for v4. Keep the effective-taxonomy implementation source-ordered and key-level so that it can later accept the project file as another merge source. This is the required forward compatibility with the planned configuration order, `shipped defaults < user home < project .claude/<plugin>.json < environment`, and its key-level merge rule in [`docs/modular-architecture.md:147-166`](../../../docs/modular-architecture.md#L147-L166). The file layer must slot into the merge before the final effective taxonomy is normalized and exposed, without changing the ADD/OVERRIDE/DISABLE semantics or letting repository data execute code.
