---
title: Observability setup
description: Install Observability and start local usage tracking for a repository.
---

Observability installs separately from Workbench. It keeps Claude Code usage data local by default and does nothing until a repository opts in.

## Install

Run these in Claude Code:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install observability@eigenwise-toolshed --scope user
```

Reload plugins or start a new Claude Code session. User scope keeps one managed observer on the machine. A project-scoped copy can start a second set of hooks.

## Set up a repository

From inside the repository you want to track, run:

```text
/observability:enable-project-telemetry
```

Claude asks for consent, shows the setup choices, and handles the local observer and dashboard. Choose local SQLite reports only, the loopback dashboard, or a remote sink if you have one. Remote sinks may require you to provide an endpoint or complete the provider's sign-in yourself.

After setup, restart any Claude Code session that was already running in the repository. New sessions pick up the project settings and send metadata for that repository only.

## What you can expect

- Usage stays off for repositories you have not approved.
- Prompt and response text, code and file contents, tool inputs and results, credentials, and environment values stay out of telemetry.
- The local dashboard is optional. Local reports still work when Docker is unavailable.
- Claude keeps the managed local processes running after setup. You do not start them by hand.

Continue with [per-project opt-in](./project-opt-in/) to see how repository coverage and verification work.

If setup or the dashboard stops working, tell Claude what you see and ask it to diagnose Observability. The bundled skill and the Toolshed doctor handle the checks and repairs.

See the generated [Observability reference](/reference/observability/) for the agent-facing setup contract.
