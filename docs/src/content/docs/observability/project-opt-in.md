---
title: Per-project opt-in
description: Enable local telemetry only for the projects where it helps.
---

Telemetry is off until a project opts in. From anywhere inside that project, run:

```text
/workbench:enable-project-telemetry
```

The skill asks for consent before changing anything. It writes only the repository's private project settings, then prepares the loopback observer and Collector, records the project in the local registry, and checks whether metrics arrive. Per-project wiring is the default. If you choose global wiring, use `/model-gateway:model-gateway` to change the gateway environment mode before enabling telemetry. The registry lets the global dashboard group data by project without copying project files anywhere.

## Opting in covers the repository

A project is its enclosing git repository. Every working directory inside it reports under the repository's name: subdirectories, monorepo packages, and the linked worktrees agents run in. One repository means one registry entry and one dashboard, whichever directory a session started in.

Claude Code's own metrics exporter reads its settings from the directory a session started in and never walks up to the repository root, so opting in writes the telemetry env into the repository root and into each subdirectory that has already hosted sessions. The command prints every directory it wired.

Sessions pick up settings environment changes only at startup. Any session already running in one of those directories has to restart before its metrics appear, not only the one at the repository root.

Disabling from anywhere in the repository unwires that same set, and leaves later edits and unrelated settings alone.

## Checking it worked

Run the same skill to verify or disable telemetry. Its verification reports `found` only after the local observer and Grafana/Loki stack have a `claude_code_token_usage_tokens_total` sample for the project. `not-found` means no sample has arrived yet or no dashboard is configured, so restart Claude Code in the listed directories and create activity before treating setup as complete. `/workbench:workbench-doctor` is read-only and checks the observer, collector, registry, and statusline path. It also flags a half-wired project: one whose hook events reach the observer while no `claude_code_*` metric carries its name in the same window, which is what an unwired session directory looks like from the outside. It names the directory and prints the command that fixes it.

The global dashboard can show every opted-in project. A project view filters to the current project, so you can inspect one codebase without mixing its counts with the rest of your machine. When that project has no samples in the selected range, the top of its dashboard says so instead of looking like an idle project.
