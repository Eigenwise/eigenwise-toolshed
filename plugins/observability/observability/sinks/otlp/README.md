# Generic OTLP sink

Set `observability.sink` to `otlp` and provide the OTLP/HTTP base URL in `observability.sinks.otlp.endpoint`. Logs enter the observer and can reach this sink through its consent-filtered outbox. Separate Collector sink pipelines send traces and metrics to this endpoint. Optional request headers live in `observability.sinks.otlp.headers` in `%LOCALAPPDATA%\Eigenwise\Workbench\observability.json` on Windows, or `~/.local/share/Eigenwise/Workbench/observability.json` when `LOCALAPPDATA` is not set.

A non-loopback endpoint is explicit egress. It must use HTTPS, and credentials must be headers rather than URL userinfo. This provider starts no local process.
