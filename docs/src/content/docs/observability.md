---
title: Observability
description: See local Claude Code activity without sending project data to a hosted service.
---

Toolshed observability is opt-in and loopback-only. It records counts and timing metadata for enabled projects, not prompt text, file contents, or credentials. The data stays on your machine unless you choose to expose the dashboard yourself.

All of it lives in the Observability plugin, which installs separately from Workbench. There are two sources: Claude Code metrics, which describe token and tool activity, and gateway records, which describe requests routed through Model Gateway. The plugin's observer and the local OpenTelemetry Collector turn those records into dashboard data.

The local observer stores canonical records in SQLite. It prunes records older than 30 days every six hours, checkpoints its WAL after each prune, and reports database and WAL sizes with ceiling warnings in its local health snapshot. The Collector receives redacted OTLP, batches it through persistent file storage, and can send it to one of four sinks: `grafana-lgtm`, `otlp`, `posthog`, or `none`. `none` keeps SQLite and local reports only. Remote OTLP requires HTTPS. PostHog requires an explicit HTTPS regional host, `phc_` project key, and remote-egress consent. The managed ensure worker identifies its loopback observer by PID and plugin version, replaces stale or unresponsive owners during upgrades, rotates oversized collector and observer logs before restart while keeping three archives, and reports that replacement at session start. It repairs version drift without running an OS service.

Hook observations are metadata-only. The observer records event type, project identity, permission mode, effort, tool facets, recipient, status, and error type. It never records prompt or response text, file contents, credentials, tool inputs or results, raw request bodies, or environment values. The request high-water guard uses the gateway's actual per-session peak and warns near the 32 MB body limit before an executor starts.

The Grafana dashboard leads with cost, routing, failures, and source activity, then graphs spend by model, project, and agent role. Project dashboards appear only after that project reports Claude Code metrics and expire after 30 quiet days. Gateway panels stay on the global dashboard because gateway records do not yet carry project attribution.

## Checking CI after a push

The local dashboard cannot tell you whether GitHub Actions finished. Run Workbench's bundled helper after pushing:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/check-ci.js"
```

Pass a commit SHA to check a different commit. The helper waits for every workflow it finds, prints the verified workflow names, and fails when no run appears, a run fails, GitHub authentication is missing, or the repository has no GitHub remote. It waits for 10 minutes by default; use `--timeout <seconds>` to set a different bound.

Start with [setup](./setup/) to install the plugin, then [per-project opt-in](./project-opt-in/) to turn it on for a repository, then the [dashboard](./dashboard/) guide to read the panels.
