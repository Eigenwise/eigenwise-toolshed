# Grafana sink

This sink bundles Grafana dashboard provisioning for the local LGTM container. `setup-observability --lgtm` mounts the provider config and dashboards read-only, so Grafana loads the Claude Code Usage dashboard at startup and keeps it across container restarts.
