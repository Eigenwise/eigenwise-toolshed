---
title: Observability
description: See local Claude Code activity without sending project data to a hosted service.
---

Toolshed observability is opt-in and loopback-only. It records counts and timing metadata for enabled projects, not prompt text, file contents, or credentials. The data stays on your machine unless you choose to expose the dashboard yourself.

There are two sources: Claude Code metrics, which describe token and tool activity, and gateway records, which describe requests routed through Model Gateway. Workbench's observer and the local OpenTelemetry Collector turn those records into dashboard data.

The local observer stores canonical records in SQLite. The Collector receives redacted OTLP, batches it through persistent file storage, and can send it to one of four sinks: `grafana-lgtm`, `otlp`, `posthog`, or `none`. `none` keeps SQLite and local reports only. Remote OTLP requires HTTPS. PostHog requires an explicit HTTPS regional host, `phc_` project key, and remote-egress consent. The managed ensure worker adopts healthy loopback services and repairs version drift without running an OS service.

Hook observations are metadata-only. The observer records event type, project identity, permission mode, effort, tool facets, recipient, status, and error type. It never records prompt or response text, file contents, credentials, tool inputs or results, raw request bodies, or environment values. The request high-water guard uses the gateway's actual per-session peak and warns near the 32 MB body limit before an executor starts.

The dashboard's **Cost over time, by resolved model (gateway)** panel uses gateway records and the model that actually handled each request. Use it for Sidequest dispatch executors: Claude Code labels those requests `claude-codex-auto`, a virtual route name with no single price. Client-reported cost panels exclude that virtual label rather than showing an invented dollar amount.

Start with the [per-project opt-in](./project-opt-in/) guide, then use the [dashboard](./dashboard/) guide to read the panels.
