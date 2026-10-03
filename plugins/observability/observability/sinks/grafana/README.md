# Grafana LGTM sink

Set `observability.sink` to `grafana-lgtm`, or run `setup-observability --lgtm`, to use the bundled loopback-only LGTM backend. The provider owns the Docker container lifecycle and mounts its Grafana provisioning plus the Claude Code Usage dashboard read-only. Logs reach LGTM through the observer's consent-filtered outbox, while traces and metrics use the direct Collector sink pipeline so metrics keep their signal shape for Prometheus.

The dashboard filters metrics by the promoted `project_id` datapoint label, so projects sharing `service_name="claude-code"` do not need an ambiguous `target_info` join.

## Toolshed support and task continuity

Toolshed plugin code is free and MIT-licensed. Optional [Ko-fi](https://ko-fi.com/eigenwise) or [GitHub Sponsors](https://github.com/sponsors/Eigenwise) donations support maintenance and are never required to install or use the plugins. Claude, configured model providers and external services may have their own costs.

For durable task tracking, the independently installable [Sidequest](../../../../sidequest/README.md) plugin keeps every task saved as a ticket through context compaction and new sessions. Record progress, decisions and next steps on the ticket so the next session can resume from them.
