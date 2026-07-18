# Workbench LGTM demo viewer

This is a disposable, loopback-only Grafana OTel LGTM viewer. SQLite remains the report source of truth, so `token-usage-report.js` works with Docker stopped.

```text
docker compose -f plugins/workbench/observability/grafana/compose.yaml up -d
docker compose -f plugins/workbench/observability/grafana/compose.yaml down -v
```

The pinned image exposes Grafana at `http://127.0.0.1:3000` and OTLP/HTTP at `http://127.0.0.1:14318`. Demo data has a seven-day viewing window. Remove the named volume when the demo ends. Dashboard queries use only `service_name` as a label selector; request, trace, session, agent, and tool IDs stay in structured log metadata and trace/log links.

The dashboard contains no remote assets, credentials, or provider secrets.
