# Eigenwise Toolshed

[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin_marketplace-D97757?logo=claude&logoColor=white)](https://claude.com/claude-code)
[![Docs](https://img.shields.io/badge/docs-online-CB7D32)](https://eigenwise.github.io/eigenwise-toolshed/)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](./LICENSE)
[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-EA4AAA?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/Eigenwise)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-support-FF5E5B?logo=kofi&logoColor=white)](https://ko-fi.com/eigenwise)

Claude Code can use a project well and still make you re-teach it the repository, lose a side issue, or repeat the same setup work in every new session.

The same thing happens around model choice and measurement. Expensive models get routine jobs, parallel changes need ownership and verification, and usage stays invisible until a bill or a slow week makes it obvious. Then a plugin install or update has its own friction: what scope did it change, which session needs a reload, and what is safe to turn on?

Toolshed packages those jobs as six independent Claude Code plugins. Use one, a few, or all six. Quartermaster is the guided starting path when you want help choosing, installing, and checking the pieces that fit a project, and it draws on whatever plugins are available on the machine, not only these six.

## The six plugins

| Problem | Plugin | What it does |
| --- | --- | --- |
| A fresh session keeps exploring the same repository | [Codebase Mapper](./plugins/codebase-mapper) | Builds a small project map, loads it at session start, and refreshes the parts touched by changes. |
| Project rules get forgotten or fill every context | [Live Rules](./plugins/live-rules) | Re-injects matching rules when they apply, so conditional guidance stays out of unrelated work. |
| Side work gets lost, and parallel changes need a clear owner | [Sidequest](./plugins/sidequest) | Tracks work as tickets, claims changes before work starts, dispatches independent work, and gates results on verification before integration. |
| You want the models and subscriptions you already have in Claude Code | [Model Gateway](./plugins/model-gateway) | Adds supported ChatGPT/Codex and Grok subscription models to Claude Code's `/model` picker through a local gateway. |
| You cannot tell where time and tokens go | [Observability](./plugins/observability) | Records selected session and tool metadata locally, with per-project opt-in and optional sinks. |
| Setup, updates, and missing capabilities keep pushing back | [Quartermaster](./plugins/quartermaster) | Recommends and installs plugins from any marketplace on the machine for setup, keeps active Toolshed installs current, checks health, and uses bounded session summaries to suggest one approved improvement at a time. |

Each plugin has its own install path and guide. None requires the others. Sidequest can route across Claude models on its own; Model Gateway is only needed for its non-Claude routes. Observability is separate from the other plugins and remains opt-in per project.

## Start with Quartermaster

Use Quartermaster when you want Claude to look at a project and recommend what fits from the plugins available on the machine, Toolshed and otherwise, installing only what you approve. Before it names a plugin, it can check current sources for whether that plugin is still maintained, whether its cached description is stale, and whether something better fits, including from a marketplace you have not added yet. Those lookups use generic capability terms; nothing mined from your sessions goes into a search. Install a plugin directly when you already know which job you want.

From the project directory:

1. Add the marketplace.
   ```text
   /plugin marketplace add Eigenwise/eigenwise-toolshed
   ```
2. Install Quartermaster for this project. Project scope is the default example because the choice stays with the repository.
   ```text
   /plugin install quartermaster@eigenwise-toolshed --scope project
   ```
3. Activate the installed plugin by reloading plugins or starting a new Claude Code session.
   ```text
   /reload-plugins
   ```
4. Run setup and approve the plan item by item.
   ```text
   /quartermaster:setup
   ```
5. Setup installs the selected plugins and writes the approved workspace files. When it pauses at the reload boundary, reload plugins or restart Claude Code if the change affects the process environment, then tell Claude `continue`.
6. Let setup verify the installed plugins and workspace after that boundary. Try one real request in the project before adding more pieces.

Quartermaster's setup uses project scope by default, but Claude Code also supports user and local scopes. Setup can recommend and install plugins from any marketplace. The updater is scoped to Toolshed only: it follows the recorded scope and project path for every active Toolshed install, so a request from one project can update Toolshed installs in other recorded projects too, and it never touches plugins from other marketplaces. Read the update and reload notes before running it.

## Install a plugin directly

Use the same marketplace with the scope you want:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install <plugin-name>@eigenwise-toolshed --scope project
```

Replace `<plugin-name>` with `sidequest`, `model-gateway`, `observability`, `codebase-mapper`, `live-rules`, or `quartermaster`. Use `--scope user` for a plugin you want in every project, or `--scope local` when it should stay out of shared settings. Reload plugins or start a new session after an install. The [plugin guides](https://eigenwise.github.io/eigenwise-toolshed/getting-started/) cover the first workflow for each one.

## Updates and reloads

`/quartermaster:update-toolshed` is the requested updater. It refreshes the Eigenwise Toolshed marketplace and updates all active Toolshed registry installs at their recorded user, project, or local scope and project path. It leaves third-party marketplaces alone. Freshness hooks only report cached availability or loaded-version mismatches and point you to the updater; they do not install or restart anything.

Marketplace auto-update is optional. Enable it for the Eigenwise Toolshed marketplace in Claude Code if you want marketplace checks after session start. An open session still needs `/reload-plugins` after plugin code changes. Changes to process-level gateway wiring or model discovery may need a new Claude Code process instead of a reload.

## Docs and source

- [Getting started](https://eigenwise.github.io/eigenwise-toolshed/getting-started/)
- [Quartermaster setup guide](https://eigenwise.github.io/eigenwise-toolshed/getting-started/quartermaster/)
- [Plugin reference](https://eigenwise.github.io/eigenwise-toolshed/reference/)
- [Contributing](https://eigenwise.github.io/eigenwise-toolshed/contributing/)
- [Release process](https://eigenwise.github.io/eigenwise-toolshed/release-process/)
- [Support](https://eigenwise.github.io/eigenwise-toolshed/support/)
- [GitHub repository](https://github.com/Eigenwise/eigenwise-toolshed)

## Compatibility

Toolshed plugins run inside Claude Code and use its plugin marketplace, plugin scopes, and reload commands. Quartermaster's local scripts use Node.js and the Node standard library. Model Gateway also needs the provider access and local process setup described in its guide. No plugin activation opts a project into telemetry, a gateway, or Sidequest routing by itself.

## Support

If these tools save you time, optional support is available through [Ko-fi](https://ko-fi.com/eigenwise) or [GitHub Sponsors](https://github.com/sponsors/Eigenwise).

## License

[MIT](./LICENSE)
