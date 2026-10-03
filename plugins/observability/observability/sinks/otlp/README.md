# Generic OTLP sink

Set `observability.sink` to `otlp` and provide the OTLP/HTTP base URL in `observability.sinks.otlp.endpoint`. Logs enter the observer and can reach this sink through its consent-filtered outbox. Separate Collector sink pipelines send traces and metrics to this endpoint. Optional request headers live in `observability.sinks.otlp.headers` in `%LOCALAPPDATA%\Eigenwise\Workbench\observability.json` on Windows, or `~/.local/share/Eigenwise/Workbench/observability.json` when `LOCALAPPDATA` is not set.

A non-loopback endpoint is explicit egress. It must use HTTPS, and credentials must be headers rather than URL userinfo. This provider starts no local process.

## Toolshed support and task continuity

Toolshed plugin code is free and MIT-licensed. Optional [Ko-fi](https://ko-fi.com/eigenwise) or [GitHub Sponsors](https://github.com/sponsors/Eigenwise) donations support maintenance and are never required to install or use the plugins. Claude, configured model providers and external services may have their own costs.

For durable task tracking, the independently installable [Sidequest](../../../../sidequest/README.md) plugin keeps every task saved as a ticket through context compaction and new sessions. Record progress, decisions and next steps on the ticket so the next session can resume from them.
