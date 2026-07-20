---
title: Observability
description: See local Claude Code activity without sending project data to a hosted service.
---

Toolshed observability is opt-in and loopback-only. It records counts and timing metadata for enabled projects, not prompt text, file contents, or credentials. The data stays on your machine unless you choose to expose the dashboard yourself.

There are two sources: Claude Code metrics, which describe token and tool activity, and gateway records, which describe requests routed through Codex Gateway. Workbench's observer and the local OpenTelemetry Collector turn those records into dashboard data.

Start with the [per-project opt-in](./project-opt-in/) guide, then use the [dashboard](./dashboard/) guide to read the panels.
