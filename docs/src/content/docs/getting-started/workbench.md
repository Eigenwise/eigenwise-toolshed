---
title: Workbench setup
description: Set up and maintain a Claude Code workspace with Workbench.
---

Workbench handles workspace setup, plugin updates, local health checks, observability setup, and retrospectives.

```text
/plugin install workbench@eigenwise-toolshed --scope user
```

Reload Claude Code after installing. From a project directory, run `/workbench:init-workspace`. Setup starts with telemetry consent before it inspects the project. If you opt in, Workbench configures and verifies local telemetry, then stops so you can restart Claude Code and run `/workbench:init-workspace` again; the completed telemetry setup is remembered on re-entry. If you decline, it moves straight to a plugin picker built from the current Toolshed marketplace catalog, before project assessment. It then assesses the project, interviews you about the setup, installs the selected plugins, and writes the `.claude/` configuration. The reload boundary matters because Claude Code discovers plugin skills and hooks when a session starts.

At session start, Workbench can tell you when the loaded Workbench version is behind the installed version. Run `/reload-plugins` to pick up the installed version, or restart Claude Code if reload does not work. It can also report Toolshed updates available from its cached marketplace data. That cached signal is not a live network check: run `/update-toolshed`, then `/reload-plugins` to refresh the plugins and load them in the current session.

## Observability stack

Workbench can prepare the local observer and an OpenTelemetry Collector. The collector is downloaded as a binary, so SQLite and collector observability work without Docker. Docker is only required for the optional Grafana dashboard. Run `/workbench:enable-project-telemetry` for one project, or `/workbench:workbench-doctor` to check the install without changing it.

The statusline shim is installed by the setup flow when selected. It reports the current context and usage path while the observer records metadata counts. Use `/workbench:workbench-doctor` when the dashboard is empty or the statusline says the local service is unavailable.

Use `/workbench:update-toolshed` to refresh installed Toolshed plugins and the gateway proxy. It leaves third-party marketplaces and plugins alone, then tells you which affected Toolshed sessions to reload.

When no wiring mode is saved, the first interactive setup asks once: "Global (all projects wired automatically via user settings) or per-project (each project opts in via its private settings.local.json — recommended)?" It persists your answer and does not ask again. Non-interactive runs use per-project mode and print a notice. Change it later with `/workbench:update-toolshed --wiring-mode global|local`; global mode keeps existing local blocks and lists them as redundant.
