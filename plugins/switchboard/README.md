# switchboard

[![Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FEigenwise%2Feigenwise-toolshed%2Fmain%2Fplugins%2Fswitchboard%2F.claude-plugin%2Fplugin.json&query=%24.version&label=version&color=blue)](.claude-plugin/plugin.json)
[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-D97757?logo=claude&logoColor=white)](https://claude.com/claude-code)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](../../LICENSE)

*Part of the [eigenwise-toolshed](../../README.md), a small marketplace of Claude Code plugins by [Eigenwise](https://eigenwise.io).*

Switchboard routes delegated work by **category**. A category describes the work, names the model and effort that should handle it, and can include a category fallback. The resolver checks available models, then tries the category route, category fallback, global fallback, and finally hardwired `sonnet/high`.

## Install

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install switchboard@eigenwise-toolshed
```

Run `/reload-plugins` or restart Claude Code. Switchboard is standalone, uses Node's standard library, and has no build step or external dependency.

## How routing works

The bundled skill classifies a request before delegation. It sends a category id to Switchboard, rather than asking Claude to pick a model by feel. The default categories cover common work such as debugging, coding, documentation, architecture, testing, research, and data visualization. Run `switchboard category list` to see the exact set installed in this release.

Every category has:

- a primary `model` and `effort` route;
- an optional category fallback;
- a short contract for the executor;
- an enabled flag.

A route is accepted only when the selected model is available. If the primary is unavailable, the resolver records the failed attempt and walks the fallback chain. An unrouted result explains every failed attempt instead of silently choosing a model.

## Configuration and model caps

Configuration layers are applied in this order:

```text
shipped defaults < user < project < environment/test overrides
```

The user file is `~/.claude/toolshed/switchboard.json`. A project override is `.claude/switchboard.json` in that project. `SWITCHBOARD_CONFIG_HOME`, `SWITCHBOARD_CONFIG_USER_FILE`, and `SWITCHBOARD_CONFIG_PROJECT_FILE` are available for isolated installs and tests. `SWITCHBOARD_CONFIG_OVERRIDES` accepts a JSON layer.

Project settings can narrow the models and routes that may be used. They cannot add a model that is absent from the discovered catalog. The resolver only uses a route when its model and effort are allowed and available. `general` is always present and cannot be disabled.

Set a global fallback with `switchboard fallback --model <model> --effort <effort>`. Use `switchboard doctor` to check schema, categories, catalog availability, and fallback health.

## CLI

The CLI lives at `bin/switchboard.js`. A shell alias is convenient:

```bash
alias switchboard='node "$HOME/.claude/plugins/marketplaces/eigenwise-toolshed/plugins/switchboard/bin/switchboard.js"'
```

```text
switchboard open [--port <port>]                              local routing settings
switchboard category list|show|add|edit|disable|remove [args] category policy
switchboard category detach|relink|reset <id> --project <path> project overlays
switchboard fallback [--model <model> --effort <effort>]      global fallback
switchboard available [--project <path>] [--json]             models and effort caps
switchboard resolve <category> [--project <path>] [--json]   route and fallback attempts
switchboard contract [--json]                                routing contract
switchboard doctor [--project <path>] [--json]               health checks
```

Use `--json` where supported for scripts. The stable integration command is:

```bash
node bin/switchboard.js routing resolve --request '{"contractVersion":1,"categoryId":"debugging"}'
```

## MCP

The plugin also exposes typed MCP tools for category policy and routing. The tool names are `category_list`, `category_show`, `category_add`, `category_edit`, `category_disable`, `category_remove`, `category_detach`, `category_relink`, `category_reset`, `global_fallback`, `available_models`, `routing_resolve`, `routing_contract`, `doctor`, and `migrate`.

MCP and CLI use the same resolver and config files. The CLI is the compatibility boundary; `lib/contract.js` validates requests and results for in-process consumers.

## Settings UI

`switchboard open` starts the local routing settings server. It shows effective categories, inheritance state, model availability, and warnings. Global settings live in the user file. Project edits are overlays, with detach/relink controls when a project needs its own complete category row.

## Migrating numeric routing

Older Switchboard versions stored a complexity ladder in `~/.claude/switchboard/prefs.json`. Numeric commands still exist for one release as a compatibility window, but they are deprecated and only affect those legacy preferences. They do not change category routes.

Preview migration before writing the new user config:

```bash
switchboard migrate --dry-run
switchboard migrate --apply
```

Migration carries over routing state, enabled model tiers, and effort allowlists. The old `routingBias` value has no category equivalent and is reported as ignored. Migration refuses to overwrite an existing category config. Remove or archive the old prefs after checking the migrated result.

## Relation to sidequest

[sidequest](../sidequest) adds a ticket board, claims, persistence, and dashboard workflows. Switchboard is the standalone category router and works without a board. Sidequest can use Switchboard's versioned routing contract when both plugins are installed.

Sidequest's comparison mode is still active. It lets users compare Switchboard's category result with the board's current routing; it does not mean the Sidequest cutover is complete. The two plugins keep their own tests and remain independently usable during the comparison window.

## License

MIT (c) Eigenwise
