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
