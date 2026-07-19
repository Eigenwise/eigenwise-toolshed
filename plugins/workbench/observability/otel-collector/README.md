# Workbench OTel Collector

Loopback-only OpenTelemetry Collector that sits between Claude Code / the Agent SDK
and the Workbench observer. It receives OTLP/HTTP, drops non-Claude signals, strips
content-bearing attributes, batches, and commits to the observer with a persistent
on-disk queue so nothing is lost if the observer is briefly down.

## Flow

```
Claude Code / Agent SDK OTLP  ->  127.0.0.1:4318  (this collector)
  memory_limiter -> filter/signals -> transform/redact -> batch
  -> file_storage queue -> otlphttp  ->  127.0.0.1:14319  (Workbench observer)
```

The observer commits to its canonical ledger, then its own outbox forwards to the
LGTM stack on `127.0.0.1:14318`. The collector never talks to LGTM directly and never
carries prompt, response, tool, or environment content.

## Config

`config.yaml` is a generated reference. Regenerate or install it with:

```
node ../../bin/install-otel-collector.js <target-path>
```

The install script validates every write: loopback-only endpoints, the fixed
`memory_limiter -> filter/signals -> transform/redact -> batch` order, a mandatory
content-stripping processor, the persistent queue, and no debug/logging exporter.

## Run

```
otelcol-contrib --config <target-path>
```

Requires the OpenTelemetry Collector Contrib distribution (for the `transform`,
`filter`, and `file_storage` components). Point Claude Code's `OTEL_EXPORTER_OTLP_ENDPOINT`
at `http://127.0.0.1:4318`.
