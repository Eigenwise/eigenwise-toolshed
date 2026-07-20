---
title: Workbench setup
description: Set up and maintain a Claude Code workspace with Workbench.
---

Workbench handles workspace setup, plugin updates, local health checks, observability setup, and retrospectives.

```text
/plugin install workbench@eigenwise-toolshed --scope user
```

Reload Claude Code after installing. From a project directory, run `/workbench:init-workspace`. The interview chooses the project plugins and writes the `.claude/` configuration. The reload boundary matters because Claude Code discovers plugin skills and hooks when a session starts.

At session start, Workbench can tell you when the loaded Workbench version is behind the installed version. Run `/reload-plugins` to pick up the installed version, or restart Claude Code if reload does not work. It can also report Toolshed updates available from its cached marketplace data. That cached signal is not a live network check: run `/update-toolshed`, then `/reload-plugins` to refresh the plugins and load them in the current session.

## Observability stack

Workbench can prepare the local observer and an OpenTelemetry Collector. The collector is downloaded as a binary, so SQLite and collector observability work without Docker. Docker is only required for the optional Grafana dashboard. Run `/workbench:enable-project-telemetry` for one project, or `/workbench:workbench-doctor` to check the install without changing it.

The statusline shim is installed by the setup flow when selected. It reports the current context and usage path while the observer records metadata counts. Use `/workbench:workbench-doctor` when the dashboard is empty or the statusline says the local service is unavailable.

Use `/workbench:update-toolshed` to refresh installed Toolshed plugins and the gateway proxy. It leaves third-party marketplaces and plugins alone, then tells you which affected Toolshed sessions to reload.
