# Generic OTLP sink

Set `observability.sink` to `otlp` and provide the OTLP/HTTP base URL in `observability.sinks.otlp.endpoint`. The collector appends each signal path and fans the same redacted logs, traces, and metrics out to the observer plus this sink. Optional request headers live in `observability.sinks.otlp.headers` inside the current-user-only observability config.

A non-loopback endpoint is explicit egress. It must use HTTPS, and credentials must be headers rather than URL userinfo. This provider starts no local process.
