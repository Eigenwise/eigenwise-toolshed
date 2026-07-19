# Token observability demo

This is a disposable Workbench telemetry project. The end-to-end test copies the project into a temporary directory, gives setup a temporary application-data directory, and uses local fake inputs. It never reads or changes the real Claude registry, plugin cache, Sidequest database, codex route log, Docker volumes, or telemetry state.

Run it from the repository root:

```text
node --test plugins/workbench/test/observability-demo.e2e.test.js
```

The test calls Workbench initialization with a fake local Collector binary and a pinned Claude version. Initialization writes only the temporary project's `.claude/settings.json` and temporary application-data files. The observer is bound to an ephemeral loopback port. Grafana LGTM and a real Claude or Codex request are deliberately not required, because provider evidence and Docker behavior are not deterministic in a unit test.

## What the report means

- **Exact**: provider token counts, cache read and cache creation counts, client request/tool timing, and context snapshots when the source emitted them.
- **Derived**: arithmetic from exact observations, such as context growth, occupancy, and ticket/session rollups.
- **Estimated**: local cost calculations, compaction pre/post values, and any result-token estimate. These are useful signals, not provider billing.
- **Inferred**: a time-nearest legacy route join or another approximation explicitly marked by the adapter.
- **Unavailable**: a value with no supported source. This includes subscription dollars, provider invoices, cache decision internals, hidden MCP/server-side usage, and per-file causal allocation.

The demo uses a local fixture for Claude and codex-gateway evidence. A route record proves route selection, model/backend/effort, and timing. It does not prove a provider request or hidden MCP billing. The report keeps estimated cost labels separate from exact tokens and never claims an invoice amount.

The failure matrix is exercised locally too: observer and exporter failures, retry and outbox replay, duplicate and out-of-order data, schema drops, malformed and rotated adapter inputs, queue saturation gaps, privacy filtering, high-cardinality identifiers, and a session with no `SessionEnd`. Queue overhead is reported as unavailable when the environment cannot measure a real Collector or Docker process.
