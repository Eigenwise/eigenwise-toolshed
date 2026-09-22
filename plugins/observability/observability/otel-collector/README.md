# Observability OTel Collector

Loopback-bound OpenTelemetry Collector that sits between Claude Code / the Agent SDK
and the Observability observer. It receives OTLP/HTTP, drops non-Claude signals, strips
content-bearing attributes, batches, and commits to the observer with a persistent
on-disk queue so nothing is lost if the observer is briefly down.

## Flow

```
Claude Code / Agent SDK OTLP  ->  127.0.0.1:4318  (this collector)
  logs, traces, metrics -> memory_limiter -> filter/signals -> transform/redact -> batch
  -> file_storage queue -> otlphttp/observer -> 127.0.0.1:14319
  logs -> observer's consent-filtered outbox -> optional configured sink
  traces, metrics -> optional otlphttp/sink -> declared Grafana or generic OTLP endpoint
```

The observer stays the canonical ledger. Logs can reach a configured sink only through its consent-filtered outbox. For `grafana-lgtm` and `otlp`, separate Collector sink pipelines send traces and metrics to the declared sink; `none` keeps only the observer exporter. The transform copies the pseudonymous `project.id` resource attribute onto metric datapoints, giving each backend a native `project_id` label without a `target_info` join.

## Config

`config.yaml` is a generated reference. Regenerate or install it with:

```
node ../../bin/install-otel-collector.js <target-path>
```

The install script validates every write: a loopback receiver and observer, an optional exactly declared sink exporter, the fixed
`memory_limiter -> filter/signals -> transform/redact -> batch` order, mandatory
content stripping plus project-label promotion, the persistent observer queue, and no debug/logging exporter. A remote sink is accepted only from the explicit `otlp` provider declaration and must use HTTPS.

## Run

```
otelcol-contrib --config <target-path>
```

Requires the OpenTelemetry Collector Contrib distribution (for the `transform`,
`filter`, and `file_storage` components). Point Claude Code's `OTEL_EXPORTER_OTLP_ENDPOINT`
at `http://127.0.0.1:4318`.
