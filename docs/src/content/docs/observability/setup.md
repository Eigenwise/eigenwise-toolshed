---
title: Observability setup
description: Install Observability and start local usage tracking for a repository.
---

Observability installs separately from Quartermaster. It keeps Claude Code usage data local by default and does nothing until a repository opts in.

## Prerequisite

Observability requires Claude Code 2.1.212 or newer.

## Install

Run these in Claude Code:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install observability@eigenwise-toolshed --scope project
```

Reload plugins or start a new Claude Code session. This example installs Observability at project scope, while one managed observer still runs per machine. When a session ensures Observability, it launches the newest installed plugin version. If an older session runs afterward, it leaves a newer live observer in place rather than replacing it. Telemetry remains opt-in for each repository.

## Set up a repository

From inside the repository you want to track, run:

```text
/observability:enable-project-telemetry
```

Claude asks for consent, shows the setup choices, and handles the local observer and dashboard. Choose local SQLite reports only, the loopback dashboard, or a remote sink if you have one. Remote sinks may require you to provide an endpoint or complete the provider's sign-in yourself.

After setup, restart any Claude Code session that was already running in the repository. This is still required for project settings and hooks to apply. The restart does not let an older session replace a newer live observer. New sessions pick up the project settings and send metadata for that repository only.

## Dashboard checks

When the dashboard is enabled, `setup-observability.js --check` names the Docker condition it finds:

- `Docker is not installed or not on PATH.`
- `Docker is installed but its daemon is not responding.`
- `Docker probe timed out after 1500ms, so Docker state is unknown.`

The Docker probe has a 1500 ms budget. Local SQLite observability continues when the dashboard is skipped.

## What you can expect

- Usage stays off for repositories you have not approved.
- Telemetry payloads exclude prompt and response text, code and file contents, tool inputs and results, credentials, and environment values. Sink configuration you provide, including OTLP headers or tokens, is stored locally in `%LOCALAPPDATA%\Eigenwise\Workbench\observability.json` on Windows, or `~/.local/share/Eigenwise/Workbench/observability.json` when `LOCALAPPDATA` is not set, so an exporter can authenticate.
- The local dashboard is optional. Local reports still work when Docker is unavailable.
- Claude keeps the managed local processes running after setup. You do not start them by hand.

Continue with [per-project opt-in](./project-opt-in/) to see how repository coverage and verification work.

If setup or the dashboard stops working, tell Claude what you see and ask it to diagnose Observability. The bundled skill and the Toolshed doctor handle the checks and repairs.

See the generated [Observability reference](/reference/observability/) for the agent-facing setup contract.
