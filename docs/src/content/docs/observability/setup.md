---
title: Observability setup
description: Install the Observability plugin, understand what it records, and know which commands and hooks it brings.
---

Observability is its own plugin. It was part of Workbench until the split; it now installs, updates, and uninstalls on its own, and nothing in Workbench depends on it being there.

```text
/plugin install observability@eigenwise-toolshed --scope user
```

User scope matters: the observer is one process per machine, and a second project-scoped copy would double-load its hooks. `/workbench:init-workspace` offers the plugin during setup when you consent to telemetry, so installing by hand is the fallback.

Nothing runs until you opt a repository in. See [per-project opt-in](../project-opt-in/) for that step.

## What it records

Hook observations are metadata only: event type, project identity, permission mode, effort, tool facets, recipient, status, and error type. Prompt and response text, file contents, tool inputs and results, raw request bodies, credentials, and environment values are never recorded.

The local observer writes canonical records to SQLite, which works without Docker and is the source of truth. Supported sinks are `grafana-lgtm`, `otlp`, `posthog`, and `none`. `none` keeps SQLite and local reports only. Grafana and generic OTLP receive the same redacted signals through the Collector. PostHog emits content-free events and requires an explicit HTTPS regional host, `phc_` project key, and remote-egress consent. Remote OTLP requires HTTPS and keeps credentials in Collector config headers rather than project settings.

## Hooks

Every hook is fail-open with a short timeout.

`SessionStart` (`startup|resume`) runs the ensure worker, which adopts or repairs enabled local observability without prompts and without an OS service. It is a silent no-op until you consent. `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStart`, and `SubagentStop` each record a metadata-only lifecycle observation. `PreToolUse` on `Agent` and `Task` also runs the request-body preflight, which reads the gateway's real per-session peak and warns near the 32 MB body limit before a subagent starts.

## Bundled commands

Under the plugin's `bin/` directory: `setup-observability --check` inspects sinks and ports, `project-telemetry` enables or disables a repository, `verify-project-telemetry --audit` explains missing attribution, `install-otel-collector` writes a Collector config, `observer` runs the canonical observer, `token-usage-report --help` lists local SQLite reporting options, `prune-observability` previews rows older than 90 days and requires `--apply` or `--yes` to delete them, and `statusline` provides the optional statusline shim.

The statusline is installed by the setup flow when you select it. It reports current context and usage while the observer records metadata counts. `/workbench:update-toolshed` heals a stale statusline pin after an update, but only when this plugin is installed.

Use `/workbench:workbench-doctor` when the dashboard is empty or the statusline says the local service is unavailable.

## Wire identifiers did not change

The observer's OpenTelemetry service name is still `workbench-observer`, and its attributes still carry a `workbench_` prefix. Those names are baked into every shipped Grafana query and into the data already on your disk, so renaming them with the plugin would have orphaned existing dashboards and history. Only the plugin moved.
