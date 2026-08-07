# Observability

[![Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FEigenwise%2Feigenwise-toolshed%2Fmain%2Fplugins%2Fobservability%2F.claude-plugin%2Fplugin.json&query=%24.version&label=version&color=blue)](.claude-plugin/plugin.json)
[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-D97757?logo=claude&logoColor=white)](https://claude.com/claude-code)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](../../LICENSE)

*Part of the [eigenwise-toolshed](../../README.md), a small marketplace of Claude Code plugins by [Eigenwise](https://eigenwise.io).*

Local, metadata-only telemetry for Claude Code. A bundled observer records lifecycle events into SQLite on your machine, an optional statusline shows live context and usage, and an OpenTelemetry Collector can forward redacted signals to Grafana, generic OTLP, or PostHog.

Prompt and response text, code and file contents, tool inputs and results, raw request bodies, credentials, and environment values are never recorded. Every sink beyond local SQLite is opt-in, and everything is off until you consent.

> Start with the [observability guide](https://eigenwise.github.io/eigenwise-toolshed/observability/), then see the [full docs site](https://eigenwise.github.io/eigenwise-toolshed/).

## Install

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install observability@eigenwise-toolshed --scope user
```

`/workbench:init-workspace` offers it during setup, so manual installation is the fallback.

User scope matters: the observer is one process per machine, and a second project-scoped copy would double-load its hooks.

## Skills

- **`enable-project-telemetry`** (`/enable-project-telemetry`) asks for consent, enables or disables metadata-only telemetry for the enclosing repository, and verifies it. Enable merges only that repository's `.claude/settings.local.json` files, starts the local observer and Collector setup, and records the machine-local project registry. Disable removes only values this flow added and leaves shared processes and historical data alone. New sessions are required after settings changes.

## Commands and bundled programs

The programs are under `${CLAUDE_PLUGIN_ROOT}/bin` and can be run with Node.

| Program | Purpose and main options |
| --- | --- |
| `setup-observability.js` | Installs or updates the loopback observer and Collector configuration. `--project`, `--sink grafana-lgtm\|otlp\|posthog\|none`, `--sink-endpoint`, `--dashboard`/`--no-dashboard`, `--lgtm`, four port options, `--check`, `--disable`, and `--delete-data` control setup and teardown. Remote OTLP requires HTTPS and explicit provider settings. |
| `project-telemetry.js` | Enables or disables telemetry for `--project <absolute-path>`. Add `--disable` to remove this project's wiring and registry entry. |
| `verify-project-telemetry.js` | Checks whether the configured project has native `claude_code_*` samples. `--project <path>` selects the repository, `--audit` explains unwired or half-wired session directories, and `--window <hours>` changes the query window. |
| `install-otel-collector.js` | Validates and writes a Collector config to the path passed as its argument, then prints the `otelcol-contrib --config` command. |
| `observer.js` | Runs the canonical local observer. It accepts `--db`, `--host`, `--port`, `--config`, and `--outbox-endpoint`; hooks send it metadata-only observations. |
| `token-usage-report.js` | Prints the local SQLite usage report. Use `--format text\|json`, `--db`, `--sidequest-home`, and `--project`. It includes queue, drop, schema, conflict, SessionEnd, and newest-event health data. |
| `prune-observability.js` | Prunes observations older than 90 days by default. Use `--retention-days <days>` to change the window and `--dry-run` to print rows and estimated reusable space before deleting. SQLite keeps the file size until a manual `VACUUM`, which needs roughly the database's current size in free disk space. |
| `statusline.js` | Statusline shim for current usage and local context. Setup registers it for Claude Code. |

The observer's OpenTelemetry service name is `workbench-observer` and its attributes carry a `workbench_` prefix. Those are wire identifiers baked into every shipped Grafana query and into data already on disk, so they did not change when the plugin split out of Workbench.

## Hooks

[hooks/hooks.json](hooks/hooks.json) registers these commands. Every hook is fail-open and uses short timeouts.

- **SessionStart (`startup|resume`)** runs `lib/observability/ensure.js --launch`. The ensure worker adopts or repairs enabled local observability.
- **SessionStart (all matches)**, **SessionEnd**, **UserPromptSubmit**, **PreToolUse**, **PostToolUse**, **Stop**, **SubagentStart**, and **SubagentStop** each run `observability.js` and record metadata-only lifecycle observations.
- **PreToolUse (`Agent|Task`)** also runs `request-body-preflight.js`, which reads the gateway's per-session request high-water record and warns near the 32 MB request limit before spawning a subagent.

The observer records event type and bounded metadata such as project identity, permission mode, effort, tool facets, recipient, status, and error type.

## Local telemetry

Usage telemetry is opt-in per repository. Run `/enable-project-telemetry` from the project you want to include. It writes the telemetry environment to the repository root and any subdirectories hosting Claude Code sessions, using a sanitized project name and SHA-256 repository ID, then records the local opted-in-project registry. A new Claude Code session is required before native metrics appear. `found` means the verification query saw the project metric; `not-found` is reported honestly until activity and dashboard data exist.

SQLite is the source of truth and works without Docker. Run `prune-observability.js --retention-days <days>` to retain a bounded history, with 90 days as the default window. The supported sinks are `grafana-lgtm`, `otlp`, `posthog`, and `none`. `none` keeps SQLite and local reports only. Grafana and generic OTLP receive the same redacted signals through the Collector. PostHog emits content-free `workbench.*` events and requires an explicit HTTPS regional host, `phc_` project key, and remote-egress opt-in. Remote OTLP requires HTTPS and keeps credentials in config headers rather than project settings.

After consent, the fail-open SessionStart ensure hook keeps the observer, Collector, and opted-in dashboard alive without prompts or OS services. It is a silent no-op without enabled consent, adopts healthy loopback listeners, heals managed version drift, and leaves startup through a detached worker. The observer drains hook spool and downstream outbox without overlapping flushes.

The optional `observability/grafana` viewer is a loopback-only `grafana/otel-lgtm:0.11.0` Docker demo with persistent `/data`, seven-day demo retention, and configurable local ports. Start it with:

```sh
docker compose -f plugins/observability/observability/grafana/compose.yaml up -d
docker compose -f plugins/observability/observability/grafana/compose.yaml down -v
```

The `observability/otel-collector` reference config receives OTLP/HTTP on `127.0.0.1:4318`, strips content-bearing attributes, batches through persistent file storage, sends to the observer at `127.0.0.1:14319`, and optionally fans out to the declared sink. It requires the OpenTelemetry Collector Contrib distribution. The generated config is installed with `install-otel-collector.js`.

Sink implementations and their local setup notes are in `observability/sinks/`: `grafana` for the managed viewer, `otlp` for a generic HTTPS endpoint, `posthog` for explicit remote analytics, and `none` for local-only storage. `observability/sinks/index.js` selects the configured provider.

## Library surface

- `lib/project-settings.js` reads project settings and reports when project `env` masks the global agent-teams setting.
- `lib/observability/ensure.js` starts, adopts, stops, and health-checks managed observer, Collector, and dashboard processes.
- `schema.js` defines the SQLite schema and migrations; `store.js` persists canonical events; `ingest.js` validates and ingests redacted observations; `resolve.js` builds report queries; `report.js` builds and formats token-usage reports.
- `hook-spool.js` writes bounded hook events for later drain; `outbox.js` queues downstream exports; `otlp.js` sends redacted OTLP batches; `sdk.js` and `sdk-query.js` observe Agent SDK messages without this plugin owning the SDK dependency.
- `request-body.js` reads the gateway request high-water record used by the preflight hook; `board-cost.js` attributes Sidequest board work and gateway costs.
- `adapters/codex-gateway.js` reads gateway cost observations; `adapters/sidequest.js` reads Sidequest board and executor observations.

## Agent SDK observability

`lib/observability/sdk-query.js` wraps the real async iterator from `@anthropic-ai/claude-agent-sdk` without making this plugin install or own that dependency. It was verified against `0.3.215`.

```js
const { query } = require('@anthropic-ai/claude-agent-sdk');
const { observeQuery } = require('./lib/observability/sdk-query.js');

for await (const message of observeQuery({
  query,
  prompt: 'Inspect this repository.',
  options: { cwd: process.cwd() },
  traceparent: activeSpanTraceparent,
  tracestate: activeSpanTracestate,
})) {
  if (message.type === 'result') console.log(message.subtype);
}
```

Omit `traceparent` and `tracestate` to leave automatic OpenTelemetry propagation alone. When trace context is supplied, the adapter merges `process.env`, caller `options.env`, and the W3C variables. Without trace context, `options.env` remains the SDK's replacement subprocess environment.

## Tests

```bash
node --test "test/*.test.js"
```

## License

[MIT](../../LICENSE) © Kenny Vaneetvelde
