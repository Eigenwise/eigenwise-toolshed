# Workbench

[![Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FEigenwise%2Feigenwise-toolshed%2Fmain%2Fplugins%2Fworkbench%2F.claude-plugin%2Fplugin.json&query=%24.version&label=version&color=blue)](.claude-plugin/plugin.json)
[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-D97757?logo=claude&logoColor=white)](https://claude.com/claude-code)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](../../LICENSE)

*Part of the [eigenwise-toolshed](../../README.md), a small marketplace of Claude Code plugins by [Eigenwise](https://eigenwise.io).*

Workbench owns the lifecycle of a Claude Code workspace: set it up, keep its plugins current, check local health, and improve the workflow after real use.

## Install

Install Workbench once at user scope. It stays outside generated project settings, so a workspace never loads a second project-scoped copy or duplicate hooks.

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install workbench@eigenwise-toolshed --scope user
```

Reload plugins or restart Claude Code after installing.

## Skills

- **`init-workspace`** is the one bootstrap entrypoint for a project-side `.claude/` directory. It runs a short stack interview, proposes core and stack plugins, installs the selected plugins at project scope by default, then writes rules, structure notes, and a codebase map where appropriate. It asks for one reload and verifies every selected plugin works. Workbench stays user-scoped and never appears in generated project settings.
- **`update-toolshed`** refreshes marketplaces, updates recorded user, project, and local installs, checks the Codex gateway, and prints reload advice. Run it first with `--check` for a read-only report.
- **`workbench-doctor`** is the read-only health check. It combines updater check mode with the session health audit and reports the next useful repair step.
- **`retro`** reviews recurring session friction and proposes small, durable workspace improvements.

Bare skill names work as usual: `/init-workspace`, `/update-toolshed`, `/workbench-doctor`, and `/retro`. Qualified invocations use `/workbench:<skill>` when needed.

## Update and health

The updater changes installed plugins, so it is always user-invoked rather than automatic:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/update-toolshed.js" --check
node "${CLAUDE_PLUGIN_ROOT}/bin/update-toolshed.js"
```

After updates, reload every session that had an affected plugin loaded.

## License

[MIT](../../LICENSE) © Kenny Vaneetvelde
