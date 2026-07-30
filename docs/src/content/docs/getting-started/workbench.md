---
title: Workbench setup
description: Set up and maintain a Claude Code workspace with Workbench.
---

Workbench handles workspace setup, plugin updates, local health checks, observability setup, and retrospectives.

```text
/plugin install workbench@eigenwise-toolshed --scope user
```

Reload Claude Code after installing. From a project directory, run `/workbench:init-workspace`. The setup interview proceeds in these steps:

1. Setup starts with telemetry consent before it inspects the project.
2. It enables Claude Code agent teams in that project's `.claude/settings.local.json`, preserving any existing project environment keys.
3. If you opt in, Workbench configures and verifies local telemetry, then stops so you can restart Claude Code and run `/workbench:init-workspace` again; the completed telemetry setup is remembered on re-entry.
4. If you decline, it asks what the project is for, then shows a recommendation-bearing plugin picker built from the current Toolshed marketplace catalog.
5. With Sidequest selected, it also asks you to confirm a routing profile and whether dispatched executors should use isolated git worktrees (the default) or always share the checkout. Shared checkout is for outputs that must appear there or projects where parallel worktrees have caused trouble, and the chosen setting is saved to the board config.
6. It assesses the project, interviews you about the setup, installs the selected plugins, and writes the `.claude/` configuration, including live rules.
7. It can also seed a lightweight `CLAUDE.md` for static project context if you choose that during the interview.

The reload boundary matters because Claude Code discovers plugin skills and hooks when a session starts.

At session start, Workbench can tell you when the loaded Workbench version is behind the installed version. Run `/reload-plugins` to pick up the installed version, or restart Claude Code if reload does not work. It can also report Toolshed updates available from its cached marketplace data. That cached signal is not a live network check: run `/update-toolshed`, then `/reload-plugins` to refresh the plugins and load them in the current session.

## Observability stack

Workbench can prepare the local observer and an OpenTelemetry Collector. The collector is downloaded as a binary, so SQLite and collector observability work without Docker. Docker is only required for the optional Grafana dashboard. Run `/workbench:enable-project-telemetry` for one project, or `/workbench:workbench-doctor` to check the install without changing it.

The statusline shim is installed by the setup flow when selected. It reports the current context and usage path while the observer records metadata counts. Use `/workbench:workbench-doctor` when the dashboard is empty or the statusline says the local service is unavailable.

Use `/workbench:update-toolshed` to refresh installed Toolshed plugins and the gateway proxy. It leaves third-party marketplaces and plugins alone, then tells you which affected Toolshed sessions to reload.

It removes registry entries for deleted Sidequest agent worktrees, writes a timestamped registry backup first, and reports every removal. Other missing project directories are still skipped and reported without changing the registry.

When no wiring mode is saved, the first interactive setup asks once: "Global (recommended: it wires every project and executor worktree automatically) or per-project (a private-settings escape hatch that does not reach executor worktrees, and Sidequest cannot detect when it is half-wired)?" It persists your answer and does not ask again. Choosing per-project immediately runs `env --write-project` for the current project. Non-interactive runs use global mode and print a notice. Change it later with `/workbench:update-toolshed --wiring-mode global|local`; global mode keeps existing local blocks and lists them as redundant.
