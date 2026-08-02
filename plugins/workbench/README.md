# Workbench

[![Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FEigenwise%2Feigenwise-toolshed%2Fmain%2Fplugins%2Fworkbench%2F.claude-plugin%2Fplugin.json&query=%24.version&label=version&color=blue)](.claude-plugin/plugin.json)
[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-D97757?logo=claude&logoColor=white)](https://claude.com/claude-code)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](../../LICENSE)

*Part of the [eigenwise-toolshed](../../README.md), a small marketplace of Claude Code plugins by [Eigenwise](https://eigenwise.io).*

Workbench sets up a Claude Code workspace, keeps its plugins current, and checks local health. It is also the front door to the rest of the shed: the plugin picker in `init-workspace` is how you find and install everything else.

> Start with the [workbench guide](https://eigenwise.github.io/eigenwise-toolshed/getting-started/workbench/), then see the [full docs site](https://eigenwise.github.io/eigenwise-toolshed/).

## Install

Install Workbench by hand first at user scope. It stays outside generated project settings, so a workspace never loads a second project-scoped copy or duplicate hooks.

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install workbench@eigenwise-toolshed --scope user
```

Reload plugins or restart Claude Code after installing.

## Skills

Bare skill names work as usual. Qualified invocations use `/workbench:<skill>` when needed.

- **`init-workspace`** (`/init-workspace`) is the one bootstrap entrypoint for a project-side `.claude/` directory. It asks for telemetry consent before inspecting the project, asks about project intent, offers the current marketplace catalog, assesses the repository, interviews for stack and workspace choices, installs the selected plugins at project scope by default, writes rules and other artifacts, pauses for one reload, then builds the map, brings up Sidequest, and verifies every selected plugin works. Workbench itself remains user-scoped.
  - Its compaction step asks for both settings before writing. `autoCompactWindow` is a global user setting in `~/.claude/settings.json`: recommended `350000` (trigger about `317k`), aggressive `250000` (about `217k`), leave default, or a custom value clamped to `100000..1000000`. A leftover project-level window is offered for removal because it overrides the global choice.
  - `SIDEQUEST_COMPACTION_POLICY` is per-project in the project `env` block. Choose `pin` (safe default), `veto` (experimental), or `off`. An unset policy behaves like `pin`, but the setup still asks and records an explicit choice. Gateway wiring is global and is not a setup choice.
- **`update-toolshed`** (`/update-toolshed`) refreshes only the Eigenwise Toolshed marketplace and updates only its recorded user, project, and local installs. It runs model-gateway setup and doctor when that plugin is installed, reports failures, reconciles global gateway wiring, and prints reload advice. It never runs automatically from SessionStart because it mutates installs and downloads dependencies.
- **`workbench-doctor`** (`/workbench-doctor`) is read-only. It combines updater check mode, the session freshness and Sidequest mapping audit, agent-teams masking checks, and, when the observability plugin is installed, its health and telemetry attribution. It reports the smallest next repair and never edits settings or installs anything.

Telemetry and the statusline live in the [observability](../observability) plugin. Retrospectives and working practice live in [playbook](../playbook). Workbench offers both during setup.

## Commands and bundled programs

The programs are under `${CLAUDE_PLUGIN_ROOT}/bin` and can be run with Node.

| Program | Purpose and main options |
| --- | --- |
| `update-toolshed.js` | Performs the updater. `--check` is read-only, `--dry-run` prints commands, and `--migrate-model-gateway --confirm-sessions-closed` migrates retired `codex-gateway` installs after every Codex session is closed. `--claude <command>` selects the Claude Code executable. |
| `install-workspace-plugins.js` | Applies the JSON plan built by `init-workspace`. `--plan <file>` is required; `--check` inventories without mutation and `--dry-run` prints planned mutations. `--claude <command>` selects the executable. |

The updater also heals stale statusline settings, but only when the observability plugin is installed. It resolves that plugin's setup module from the install registry rather than importing it, so Workbench works on its own.

## Hooks

[hooks/hooks.json](hooks/hooks.json) registers these commands. Every hook is fail-open and uses short timeouts.

- **SessionStart (`startup|resume`)** runs `session-start-freshness.js` and `billing-path-check.js`. Freshness checks installed Toolshed plugins, marketplace cache age, gateway health, required Node and Claude Code versions, and Sidequest board-to-install mappings. Billing-path-check warns once per session when an API key overrides an available Pro, Max, Team, or Enterprise subscription seat.
- **UserPromptSubmit** runs `user-prompt-freshness.js`, which warns about available updates and blocks only when this session loaded an older Workbench than the installed copy. Maintenance prompts remain usable for recovery.

Workbench records nothing. The lifecycle observation hooks belong to the observability plugin.

## License

[MIT](../../LICENSE) © Kenny Vaneetvelde
