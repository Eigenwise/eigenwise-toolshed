---
title: Observability setup
description: Install Observability and start local usage tracking for a repository.
---

Observability installs separately from Quartermaster. The intended policy is per-repository opt-in, with a separate machine-shared service consent for the observer and Collector. Current hook and ingest enforcement does not fully enforce that boundary, so do not present opt-in as a hard runtime privacy guarantee until the runtime fix lands.

## Prerequisite

Observability requires Claude Code 2.1.212 or newer.

## Install

Run these in Claude Code:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install observability@eigenwise-toolshed --scope project
```

Reload plugins or start a new Claude Code session. This example installs Observability at project scope, while one managed observer still runs per machine. When a session ensures Observability, it launches the newest installed plugin version. If an older session runs afterward, it leaves a newer live observer in place rather than replacing it. Plugin install scope does not decide project participation. The machine service choice and each repository opt-in remain separate.

## Set up a repository

From inside the repository you want to track, run:

```text
/observability:enable-project-telemetry
```

Claude asks separately for the shared service consent and this repository's opt-in, then handles the local observer and any dashboard choice. A bare setup keeps SQLite reports only and does not request Docker. Use `--dashboard` only when the user explicitly wants the Docker-backed loopback dashboard. Remote sinks may require you to provide an endpoint or complete the provider's sign-in yourself.

After setup, restart every Claude Code session that was already running in the repository or in a listed session-hosting directory. Restart before creating activity or running verification. This is required for project settings and hooks to apply; `/reload-plugins` alone does not apply the new environment. The restart does not let an older session replace a newer live observer. New sessions pick up the project settings and send metadata for that repository only under the intended policy.

## Dashboard checks

When the dashboard is enabled, `setup-observability.js --check` names the Docker condition it finds:

- `Docker is not installed or not on PATH.`
- `Docker is installed but its daemon is not responding.`
- `Docker probe timed out after 1500ms, so Docker state is unknown.`

The Docker probe has a 1500 ms budget. Local SQLite observability continues when the dashboard is skipped.

## What you can expect

- Per-repository opt-in remains the intended policy, but the current hook and ingest path can accept hook events before checking that opt-in. Do not treat the policy as a hard runtime collection guarantee.
- The telemetry schema is designed to exclude prompt and response text, code and file contents, tool inputs and results, credentials, and environment values. Sink configuration you provide stays in the private local observability config.
- The local dashboard is optional. Local reports still work when Docker is unavailable.
- Hook events from a linked worktree can resolve to the main repository identity. Native Claude Code metrics still require wiring in the exact directory where the session starts.
- Claude keeps the managed local processes running after setup. You do not start them by hand.

Continue with [per-project opt-in](../project-opt-in/) to see how repository coverage and verification work.

If setup or the dashboard stops working, tell Claude what you see and ask it to diagnose Observability. The bundled skill and the Toolshed doctor handle the checks and repairs.

See the generated [Observability reference](../../reference/observability/) for the agent-facing setup contract.
