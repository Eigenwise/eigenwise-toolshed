# Modular toolshed architecture

The modular toolshed is implemented as three independently useful plugins:

```text
codex-gateway  ->  switchboard  ->  sidequest
   discovery        category routing       board and workflow
```

The arrows describe optional integration, not install requirements. `codex-gateway` publishes model
discovery. `switchboard` owns category policy and route resolution. `sidequest` owns tickets, claims,
storage, and the board. Each plugin still works when its optional neighbor is absent.

## Implemented status

| Plugin set | Current behavior |
| --- | --- |
| `switchboard` alone | Category routes, category and global fallbacks, model availability checks, CLI, MCP, and local settings UI |
| `codex-gateway` + `switchboard` | Switchboard checks gateway's discovered model catalog before accepting a route |
| `switchboard` + `sidequest` | Sidequest can call Switchboard's versioned resolver and inspect the returned route and attempts |
| all three | Codex discovery feeds standalone category routing and Sidequest integration |

Sidequest is still in **comparison mode**. It can compare its current board routing with Switchboard's
category result. The final Sidequest cutover is separate work and is not part of this contract.

## Routing contract

The stable boundary is:

```text
bin/switchboard.js routing resolve --request <json>
lib/contract.js
```

A request has `contractVersion: 1`, a required `categoryId`, and optional `projectPath` and `consumer`.
A routed result contains the category projection, `{ model, effort, source }`, provider-neutral dispatch
information, every attempted route, and warnings. `source` is one of `primary`, `category-fallback`,
`global-fallback`, or `hard-default`. An unrouted result contains the category, attempts, and a non-empty
warning list.

Dispatch is provider-neutral. Native consumers receive a `native` dispatch kind. Gateway-backed
consumers receive a `gateway-marker` with the concrete dispatch model and a
`[switchboard-route model=... effort=...]` marker. Switchboard does not own provider authentication.

## Configuration layers

The effective configuration is merged in this order:

```text
shipped defaults < user < project < environment/test overrides
```

- User: `~/.claude/toolshed/switchboard.json`
- Project: `.claude/switchboard.json`
- Test/CI overrides: `SWITCHBOARD_CONFIG_HOME`, `SWITCHBOARD_CONFIG_USER_FILE`,
  `SWITCHBOARD_CONFIG_PROJECT_FILE`, and `SWITCHBOARD_CONFIG_OVERRIDES`

The config has a schema version. Project overlays may narrow `allowedModels` and `allowedRoutes`, and
may add or override categories. They cannot widen a lower layer's model caps. `general` is always
present and enabled.

The resolver checks the selected route against the available model catalog. It then tries, in order:

1. category primary route;
2. category fallback, when configured;
3. global fallback, when configured;
4. hardwired `sonnet/high`.

Unavailable routes are recorded with a reason. If every candidate is unavailable, the result is
`unrouted` and the warning explains why.

## Registry and catalog

An enabled plugin writes its own breadcrumb under:

```text
~/.claude/toolshed/registry/<plugin>.json
```

The Switchboard breadcrumb advertises the routing contract, the `routing` capability, category support,
and the local contract adapter. Consumers validate the schema, plugin name, version, root, and contract
entry point. Invalid or stale entries are ignored. A consumer never walks the Claude plugin cache to
discover another plugin.

Codex Gateway publishes its catalog separately. Switchboard uses that catalog only for model availability;
category policy remains in Switchboard config and catalog ordering never becomes fallback policy.

## CLI, MCP, and settings UI

The CLI is the compatibility boundary:

```text
switchboard open [--port <port>]
switchboard category list|show|add|edit|disable|remove [args]
switchboard category detach|relink|reset <id> --project <path>
switchboard fallback [--model <model> --effort <effort>]
switchboard available [--project <path>] [--json]
switchboard resolve <category> [--project <path>] [--json]
switchboard contract [--json]
switchboard doctor [--project <path>] [--json]
```

The plugin MCP server exposes the same operations as typed tools, including category CRUD, project
inheritance controls, fallback configuration, model availability, route resolution, contract discovery,
and migration. Both surfaces read and write the same user and project files.

`switchboard open` starts the local settings server. The UI shows effective categories, inheritance
state, available models, effort caps, and warnings. A project edit can detach a complete category row;
relink/reset removes that overlay and follows inherited policy again.

## Numeric migration window

Older releases stored numeric ladder preferences in `~/.claude/switchboard/prefs.json`. Numeric commands
remain for one release so users can migrate, but they are deprecated and only affect legacy preferences.
They do not change category routes.

```bash
switchboard migrate --dry-run
switchboard migrate --apply
```

Migration carries routing state, enabled model tiers, and effort allowlists into the category config.
`routingBias` has no category equivalent and is reported as ignored. Migration refuses to overwrite an
existing category config. After this one-release window, legacy numeric commands and the old prefs path
can be removed.

## Degradation rules

- Switchboard without a gateway uses configured models that are available locally.
- Switchboard without Sidequest remains a complete standalone router.
- Sidequest without Switchboard keeps tickets readable and returns `unrouted` for new derived routes;
  it does not silently use a second router.
- A missing or invalid registry entry degrades to the normal missing-module behavior.
- Plugin installation roots are cache locations. Persistent state belongs under `~/.claude/toolshed`,
  not inside `${CLAUDE_PLUGIN_ROOT}`.

The contract and behavior are covered by independent Switchboard tests and Sidequest comparison tests.
