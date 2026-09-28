# Grafana LGTM sink

Set `observability.sink` to `grafana-lgtm`, or run `setup-observability --lgtm`, to use the bundled loopback-only LGTM backend. The provider owns the Docker container lifecycle and mounts its Grafana provisioning plus the Claude Code Usage dashboard read-only. Logs reach LGTM through the observer's consent-filtered outbox, while traces and metrics use the direct Collector sink pipeline so metrics keep their signal shape for Prometheus.

The dashboard filters metrics by the promoted `project_id` datapoint label, so projects sharing `service_name="claude-code"` do not need an ambiguous `target_info` join.
