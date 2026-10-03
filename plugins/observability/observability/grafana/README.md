# Observability LGTM demo viewer

This is a disposable, loopback-only Grafana OTel LGTM viewer. SQLite remains the report source of truth, so `token-usage-report.js` works with Docker stopped.

```text
docker compose -f plugins/observability/observability/grafana/compose.yaml up -d
docker compose -f plugins/observability/observability/grafana/compose.yaml down -v
```

The pinned image exposes Grafana at `http://127.0.0.1:3000` and OTLP/HTTP at `http://127.0.0.1:14318`. Demo data has seven-day retention in Loki and Tempo, and the dashboard opens on the same seven-day range. Remove the named volume when the demo ends. Dashboard queries use only `service_name` as a label selector; request, trace, session, agent, and tool IDs stay in structured log metadata and trace/log links.

The dashboard contains no remote assets, credentials, or provider secrets.

## Toolshed support and task continuity

Toolshed plugin code is free and MIT-licensed. Optional [Ko-fi](https://ko-fi.com/eigenwise) or [GitHub Sponsors](https://github.com/sponsors/Eigenwise) donations support maintenance and are never required to install or use the plugins. Claude, configured model providers and external services may have their own costs.

For durable task tracking, the independently installable [Sidequest](../../../sidequest/README.md) plugin keeps every task saved as a ticket through context compaction and new sessions. Record progress, decisions and next steps on the ticket so the next session can resume from them.
