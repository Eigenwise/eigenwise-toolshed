# Modular toolshed architecture

Phase 2 splits the toolshed into three layered plugins with explicit contracts:

```text
codex-gateway  ->  switchboard  ->  sidequest
     discovery        routing          work board + dashboard
```

The dependency direction is deliberate. `codex-gateway` can stand alone. `switchboard` can use its own defaults when no gateway is present. `sidequest` needs switchboard for routing, but its board remains readable when routing is unavailable.

Claude Code loads marketplace plugins from a versioned local cache rather than in-place. The cache path is `~/.claude/plugins/cache`, each installed version has its own directory, and old versions may remain briefly for running sessions. Plugin code must therefore treat its installation root as an ephemeral runtime location, never as shared state. [Plugin caching and file resolution](https://code.claude.com/docs/en/plugins-reference#plugin-caching-and-file-resolution) [Environment variables](https://code.claude.com/docs/en/plugins-reference#environment-variables)

## 1. Layering and degradation

| Installed set | What works | What is deliberately absent |
| --- | --- | --- |
| `codex-gateway` | Gateway login, model discovery, catalog publication | Routing and board UI |
| `switchboard` | Category-to-model routing, fallback-chain policy, user and project category preferences | Tickets, board workflow, dashboard |
| `sidequest` | Tickets, claims, comments, storage, dashboard shell | Derived routing and dispatch when switchboard is absent |
| gateway + switchboard | Switchboard can validate discovered Codex backends | Board workflow |
| switchboard + sidequest | Tickets receive resolved concrete-model/effort routes using category and global fallbacks | Discovered Codex routes unless a gateway catalog is present |
| all three | Full routing and dashboard experience | Nothing |

Each row is a product, not an error state. The main degradation rule is:

- A missing optional lower-layer module removes its optional capability and leaves the installed module usable.
- A missing required routing dependency leaves sidequest tickets visible and editable, but marks newly derived routes as `unrouted` and rejects dispatch with a direct install/configuration error.
- A stale registry entry never changes routing. Consumers validate it, ignore it if invalid, and use their normal degradation behavior.

Per-project enablement belongs in Claude Code's `enabledPlugins` settings. The supported scopes are user (`~/.claude/settings.json`), project (`.claude/settings.json`), local (`.claude/settings.local.json`), and managed settings; an enabled entry at any scope persists across plugin updates. A project setting can declare a plugin but does not by itself install an external-source plugin for a teammate: it won't load until they install it. The documented bridge is `extraKnownMarketplaces` in the project's `.claude/settings.json` — when a teammate trusts the repository folder, Claude Code prompts them to install the declared marketplaces and enabled plugins, so a repo shipping `extraKnownMarketplaces` + `enabledPlugins` gets a teammate from clone to working toolshed in one consent prompt. [Plugin installation scopes](https://code.claude.com/docs/en/plugins-reference#plugin-installation-scopes) [Default enablement](https://code.claude.com/docs/en/plugins-reference#default-enablement) [Configure team marketplaces](https://code.claude.com/docs/en/discover-plugins#configure-team-marketplaces)

Example project enablement:

```json
{
  "enabledPlugins": {
    "codex-gateway@eigenwise-toolshed": true,
    "switchboard@eigenwise-toolshed": true,
    "sidequest@eigenwise-toolshed": true
  }
}
```

The registry cannot infer installation from a project setting. It records a module only after that module actually starts.

## 2. Self-registration registry

The shared registry lives outside every plugin root:

```text
~/.claude/toolshed/registry/<plugin>.json
```

A module writes one presence file after it has initialized. The initial contract is:

```json
{
  "name": "switchboard",
  "version": "2.0.0",
  "contractVersion": 1,
  "pluginRoot": "/absolute/path/to/installed/plugin",
  "capabilities": ["routing", "categories"],
  "categories": { "contractVersion": 1 },
  "ui": {
    "contractVersion": 1,
    "panels": ["routing"]
  },
  "projects": {
    "/absolute/path/to/project": {
      "version": "2.0.0",
      "lastSeen": "2026-07-15T18:00:00.000Z"
    }
  }
}
```

`categories` and `ui` are omitted when a module has no contribution. `projects` is an object keyed by canonical absolute project path, not a list, so a module can update the current project without rewriting unrelated entries.

### Writers

- Each plugin has a fast `SessionStart` hook that writes or refreshes its own file when that plugin is enabled.
- Each plugin CLI refreshes its own file before commands that depend on cross-plugin discovery.
- Writes are atomic replace operations. The writer owns only its file.

Claude Code runs a plugin's bundled hooks while that plugin is enabled, and merges those hooks with user and project hooks. `SessionStart` fires at startup and resume, and its matcher can distinguish `startup`, `resume`, `clear`, and `compact`; it should stay fast. [Hooks locations and scope](https://code.claude.com/docs/en/hooks#configure-hooks) [SessionStart](https://code.claude.com/docs/en/hooks#sessionstart)

### Consumers

A consumer accepts a registry entry only when all checks pass:

1. JSON parses and `name` matches the file name.
2. `contractVersion` is supported.
3. `pluginRoot` exists and contains the advertised contract entry point.
4. The advertised `version` is compatible with the consumer's contract range.
5. A requested project entry is present and recent enough for the operation.

Failed validation means the entry is stale and ignored. A consumer never discovers siblings by walking `~/.claude/plugins/cache` and never persists data below another plugin's `pluginRoot`. Claude Code says plugin cache versions are separate and can be removed after the orphan grace period; `${CLAUDE_PLUGIN_ROOT}` changes on update and must not hold state. [Plugin caching and file resolution](https://code.claude.com/docs/en/plugins-reference#plugin-caching-and-file-resolution) [Environment variables](https://code.claude.com/docs/en/plugins-reference#environment-variables)

A plugin uses `${CLAUDE_PLUGIN_ROOT}` only to locate its own bundled hook script, CLI, and contract adapter. Claude Code resolves that variable to the absolute installation directory and supports it in hook commands, skill and agent content, and plugin MCP configuration. [Environment variables](https://code.claude.com/docs/en/plugins-reference#environment-variables)

## 3. Lift the routing engine into switchboard

Switchboard becomes the owner of routing semantics and category policy. It exports a small local contract rather than asking consumers to copy code:

```text
switchboard/bin/switchboard.js routing resolve --request <json>
switchboard/bin/switchboard.js routing contract
switchboard/lib/contract.js             # supported in-process adapter
```

Sidequest discovers switchboard through the registry breadcrumb, then invokes the CLI or loads the declared adapter. The CLI is the stable compatibility boundary. The in-process adapter is permitted only after its contract version check passes, and is an optimization rather than a second source of truth.

The current copy must be retired:

- `plugins/switchboard/lib/ladder.js` is an explicit copy of the old sidequest routing section. It must be replaced by a category-to-model router.
- `plugins/sidequest/lib/store.js` has the current capability router, backend resolution, runtime grouping, and `resolveExec()` seam.
- `plugins/sidequest/lib/discovery.js` reads the Codex catalog directly today. That discovery becomes switchboard input instead.

Move the live routing core from `sidequest/lib/store.js` into switchboard: category route validation, concrete-model availability checks, the category fallback chain, global fallback, concrete executor generation, and all routing tests. Move the future category system with it, including category defaults and category-to-model/effort policy. `plugins/sidequest/docs/category-contract.md` and `category-defaults.md` are the design/reference material for that contract. Sidequest keeps ticket-specific routing application and displays the switchboard result.

There is no vendored fallback router in sidequest. With a missing or invalid switchboard breadcrumb, sidequest stores and returns tickets but derives `unrouted` rather than silently choosing a model. That keeps a user from getting two routing answers depending on which plugin happened to load.

## 4. Gateway state contract

`codex-gateway` publishes one versioned discovery document. The current concrete source is `~/.claude/codex-gateway/catalog.json`, which sidequest reads in `plugins/sidequest/lib/discovery.js`. Replace the private, consumer-specific read with this documented contract:

```json
{
  "schemaVersion": 3,
  "source": "codex-gateway",
  "updatedAt": "2026-07-15T18:00:00.000Z",
  "models": [
    {
      "slug": "codex-gpt-5-6-terra",
      "id": "claude-codex-gpt-5.6-terra",
      "label": "GPT-5.6 Terra"
    }
  ]
}
```

Switchboard owns validation of this document and uses it only to decide whether a selected concrete model is available. Gateway owns its contents and atomic publication. Category policy chooses the primary route and its fallback, so the catalog must not publish a replacement policy field such as `suggestedFallback`: catalog ordering and labels are enough for a user choosing a route. Neither side loads the other's private storage or source files.

Gateway registration advertises `capabilities: ["model-catalog"]` and a `catalog` descriptor with the document path, schema version, and optional command for explicit refresh. Switchboard rejects an unknown schema, malformed model, or absent catalog and continues through the configured category fallback chain, then its global fallback.

## 5. Configuration layering

The toolshed configuration order is fixed:

```text
shipped defaults < user home < project .claude/<plugin>.json < environment
```

The two middle files are toolshed-owned configuration, not arbitrary Claude Code plugin configuration. Claude Code's documented plugin configuration model has its own scope rules, including user-level `pluginConfigs`; the toolshed must not rely on undocumented merge behavior for its cross-plugin settings. [Plugin settings](https://code.claude.com/docs/en/settings#plugin-settings)

| Layer | Location | Holds |
| --- | --- | --- |
| Shipped defaults | plugin package | Category routes, category fallbacks, global fallback default |
| User | `~/.claude/toolshed/<plugin>.json` | User category overrides and global fallback override |
| Project | `.claude/<plugin>.json` | Project category overrides and allowed category/model policy |
| Environment | documented `TOOLSHED_*` variables | CI/test overrides only |

Project-owned values are category overrides, permitted concrete models, and the global fallback. Resolve each value by its deepest present layer. Arrays and maps use key-level merge; a scalar replaces the lower value. An environment variable wins only for its named key.

Keep project files narrow and explicit. Claude Code permits project-scoped settings but applies trust and component restrictions to repository-provided plugin content. A toolshed project config is data read by the plugin, never executable plugin registration. [Skills-directory plugins](https://code.claude.com/docs/en/plugins-reference#skills-directory-plugins)

## 6. `schemaVersion` write guards

Every persisted toolshed document has `schemaVersion`, including registry entries, gateway catalogs, switchboard preferences, sidequest board storage metadata, and project config.

The write rule is strict:

```text
writer schema < stored schema  -> refuse write, report upgrade required
writer schema = stored schema  -> read/write normally
writer schema > stored schema  -> migrate atomically, then write
```

An older binary must never rewrite a newer file into an older shape. It reports the stored and supported versions, the affected path, and the minimum plugin version needed. Read-only inspection may continue where the document's stable fields are known.

This is mandatory before the next sidequest persistence migration. `plugins/sidequest/lib/db.js` currently initializes `meta.schema_version` to `1`, but has no version-gated migration layer. The guard prevents a repeat of the 1.46 JSON/SQLite split-brain problem, where active older sessions could keep writing an obsolete representation.

## 7. Contract tests at every edge

Each producer has fixture tests proving the shape it writes. Each consumer has independent fixture tests proving how it handles valid, stale, missing, malformed, future-version, and incompatible-version inputs. Fixtures live with the consumer so a producer refactor cannot accidentally hide a broken compatibility assumption.

| Edge | Producer assertion | Consumer fixture cases |
| --- | --- | --- |
| Gateway -> switchboard | Catalog validates against its declared schema | Valid catalog, bad model, stale schema, missing catalog |
| Switchboard -> sidequest | `routing contract` returns a schema-valid resolution | Claude default, Codex pin, missing switchboard, unsupported contract |
| Plugin -> registry | Presence file includes valid root/version/capabilities | Missing root, stale version, wrong name, future contract |
| Config layers -> switchboard | Canonical resolved config is schema-valid | Every precedence conflict, map merge, env override |
| Sidequest -> dashboard shell | Dashboard module manifest is schema-valid | No modules, incompatible panel, failed panel health check |
| Persistence -> writer | Migration preserves fixture data | Older writer refusal, migration recovery, future-store read-only path |

Use a contract test command at the boundary, not a shared test helper. The publisher and consumer need to be able to fail independently.

## 8. Dashboard shell and module panels

Sidequest owns a small dashboard shell. It keeps board navigation, ticket data, and the panel mount lifecycle. Modules contribute panels through the registry's `ui` descriptor:

```json
{
  "ui": {
    "contractVersion": 1,
    "panels": [
      {
        "id": "routing",
        "label": "Routing",
        "entry": "dashboard/panels/routing.js",
        "capability": "routing"
      }
    ]
  }
}
```

The shell discovers valid entries, loads only supported panel contracts, and renders unavailable modules as a compact install/repair state. It must not require every panel to exist. The first panels are:

- switchboard: category route and fallback settings, availability warnings, and category policy;
- codex-gateway: authentication and discovered model catalog state;
- sidequest: the existing board, claims, ticket detail, and dispatch status.

This is a tooling-level registry, not Claude Code plugin UI registration. Claude Code automatically discovers plugin skills and commands from documented plugin locations, finds agents in `agents/`, and starts plugin MCP servers when the plugin is enabled. Those mechanisms register Claude Code components, not panels in another plugin's HTML dashboard. [Plugin structure overview](https://code.claude.com/docs/en/plugins) [Plugin components reference](https://code.claude.com/docs/en/plugins-reference)

Plugin agents cannot ship their own `hooks`, `mcpServers`, or `permissionMode`. Dashboard and registration behavior must stay in plugin-level hooks/MCP configuration, not agent frontmatter. [Plugin agents](https://code.claude.com/docs/en/plugins-reference#agents)

## 9. Phased migration plan

1. **Define shared documents.** Add schema definitions and consumer-side fixtures for registry entry, gateway catalog v3, routing request/result, config, and dashboard panel descriptors. No behavior moves yet.
2. **Add registry writers.** Give gateway, switchboard, and sidequest a fast enabled-only `SessionStart` writer plus a CLI refresh path. Add stale-entry consumer tests.
3. **Formalize gateway publication.** Make codex-gateway publish catalog v3 with write guards. Add switchboard catalog reader while preserving the current sidequest reader temporarily.
4. **Lift the live engine.** Move Sidequest's concrete-model route resolver and its tests into switchboard. Replace `switchboard/lib/ladder.js`; migrate existing routing preferences into category routes and fallbacks.
5. **Move category policy.** Implement category-to-model routing in switchboard from the Sidequest category contract/defaults, including configuration layering and schema guards.
6. **Replace Sidequest routing.** Sidequest calls switchboard through the registry breadcrumb and stores only resolved routing output. Delete its direct catalog discovery and copied routing ownership. Missing switchboard yields `unrouted` tickets, never an implicit fallback router.
7. **Add the dashboard shell.** Extract sidequest's existing dashboard frame, mount the sidequest panel first, then switchboard and gateway panels from validated registry entries.
8. **Remove compatibility paths.** After one supported migration window, remove the old sidequest routing engine, old direct catalog reader, and obsolete schema readers. Keep a clear upgrade diagnostic for stale installations.

Each phase gets a separate ticket, contract fixtures, and one end-to-end test of its degradation path. Do not combine the engine lift with the dashboard work. A routing failure needs to be diagnosable before UI composition adds another moving part.

## Claude Code facts this plan relies on

- Marketplace plugin code is cached under `~/.claude/plugins/cache`; cached versions are separate and old versions may survive briefly for existing sessions. [Plugin caching and file resolution](https://code.claude.com/docs/en/plugins-reference#plugin-caching-and-file-resolution)
- Plugin enablement uses `enabledPlugins` in user, project, local, or managed settings scopes. Project declarations do not install missing external plugins. [Plugin installation scopes](https://code.claude.com/docs/en/plugins-reference#plugin-installation-scopes) [Configure team marketplaces](https://code.claude.com/docs/en/discover-plugins#configure-team-marketplaces)
- Plugin hooks apply while the plugin is enabled. `SessionStart` runs at session start and resume, which makes it suitable for a quick presence refresh. [Hooks locations and scope](https://code.claude.com/docs/en/hooks#configure-hooks) [SessionStart](https://code.claude.com/docs/en/hooks#sessionstart)
- `${CLAUDE_PLUGIN_ROOT}` points at the current installation directory, changes on plugin update, and is appropriate for bundled resources rather than persistent state. [Environment variables](https://code.claude.com/docs/en/plugins-reference#environment-variables)
- Skills/commands, agents, and MCP servers have distinct documented plugin registration paths. The modular dashboard is separate from those Claude Code component registries. [Plugin structure overview](https://code.claude.com/docs/en/plugins) [Plugin components reference](https://code.claude.com/docs/en/plugins-reference)

One implementation detail is intentionally excluded: `installed_plugins.json` is not a documented Claude Code plugin state file. This design relies only on documented cache paths and `enabledPlugins`, plus the toolshed-owned registry.
