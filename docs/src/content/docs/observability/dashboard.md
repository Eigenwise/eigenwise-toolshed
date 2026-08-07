---
title: Dashboard
description: Inspect local Claude Code activity from one place.
---

The Grafana dashboard reads local telemetry from enabled projects. The global **Claude Code Usage** view answers four questions: what the selected range cost, where the spend went, whether the orchestrator or executors consumed it, and whether anything failed or stopped reporting.

Project dashboards are data-driven. Enabling telemetry keeps a project wired, but Grafana only gets a project dashboard after Claude Code metrics arrive for it. A project drops from the dashboard list after 30 days without Claude Code metrics. Gateway records are global because they do not carry project attribution, so gateway panels only appear on the global dashboard.

## At a glance

- **Claude API-equivalent cost** estimates Claude API list-price cost for the selected range. It is a comparison figure, not a bill.
- **Work routed to Codex** shows the gateway list-price-equivalent share routed to Codex. It is global rather than project-specific.
- **Tool failure rate** shows the share of observed tool calls marked failed or errored.

## Where the spend goes

- **Claude cost by model** graphs the Claude API-equivalent cost trend by model.
- **Gateway cost by resolved model** graphs the backend model that handled each gateway request. This is the useful view for Sidequest executor traffic, where the client label is the virtual `claude-codex-auto` route.
- **Claude cost by project** compares reporting projects on the global dashboard.
- **Context by orchestrator vs executor** compares context-token volume by agent role.

Use the **Bucket** dropdown to change the aggregation window. Choose `1m` for close investigation or `1h` and above for an overview. Grafana legends and tooltips carry the individual series values, and **Inspect > Data** provides the table view.

## Failures and source activity

**Hook failures over time** and **Gateway errors and throttles** show when failures happened instead of reducing the whole range to a count. The three source cards show whether Claude metrics, observer records, and gateway records arrived in the last five minutes. A zero on the gateway card can also mean the gateway was idle.

A project dashboard starts with a telemetry status card. If it has no Claude Code metrics in the selected range, the card points to project telemetry setup instead of leaving the rest of the dashboard unexplained.

## Resetting generated dashboards

From the installed Observability plugin's `bin` directory, run:

```sh
node setup-observability.js --reset-dashboards
```

This removes every generated Grafana dashboard and records the reset time. The global dashboard returns on the next setup or ensure run. A project dashboard returns only after that project sends fresh Claude Code metrics, so old samples do not immediately rebuild the deleted list.

Resetting dashboards does not disable telemetry or delete stored metrics and logs.

## Deleting project data

Replace `project-id` and the Loki start time with the project and oldest data you want gone.

:::danger
Delete telemetry only when you mean it. It is permanent.
:::

```sh
docker exec workbench-otel-lgtm-demo curl -X POST -g 'http://127.0.0.1:9090/api/v1/admin/tsdb/delete_series?match[]={project_id=~"project-id"}'
docker exec workbench-otel-lgtm-demo curl -X POST http://127.0.0.1:9090/api/v1/admin/tsdb/clean_tombstones
```

```sh
docker exec workbench-otel-lgtm-demo curl -X POST -g 'http://127.0.0.1:3100/loki/api/v1/delete?query={project_id="project-id"}&start=2026-01-01T00:00:00Z'
```
