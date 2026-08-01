# Workbench

[![Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FEigenwise%2Feigenwise-toolshed%2Fmain%2Fplugins%2Fworkbench%2F.claude-plugin%2Fplugin.json&query=%24.version&label=version&color=blue)](.claude-plugin/plugin.json)
[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-D97757?logo=claude&logoColor=white)](https://claude.com/claude-code)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](../../LICENSE)

*Part of the [eigenwise-toolshed](../../README.md), a small marketplace of Claude Code plugins by [Eigenwise](https://eigenwise.io).*

Workbench owns the lifecycle of a Claude Code workspace: set it up, keep its plugins current, check local health, and improve the workflow after real use. Version `0.75.0` is declared in [plugin.json](.claude-plugin/plugin.json).

> Start with the [workbench guide](https://eigenwise.github.io/eigenwise-toolshed/getting-started/workbench/), then see the [full docs site](https://eigenwise.github.io/eigenwise-toolshed/).

## Install

Install Workbench by hand first at user scope. It stays outside generated project settings, so a workspace never loads a second project-scoped copy or duplicate hooks.

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install workbench@eigenwise-toolshed --scope user
```

Reload plugins or restart Claude Code after installing.

## Skills

Bare skill names work as usual. Qualified invocations use `/workbench:<skill>` when needed.

- **`init-workspace`** (`/init-workspace`) is the one bootstrap entrypoint for a project-side `.claude/` directory. It asks for telemetry consent before inspecting the project, asks about project intent, offers the current marketplace catalog, assesses the repository, interviews for stack and workspace choices, installs the selected plugins at project scope by default, writes rules and other artifacts, pauses for one reload, then builds the map, brings up Sidequest, and verifies every selected plugin works. Workbench itself remains user-scoped.
  - Its compaction step asks for both settings before writing. `autoCompactWindow` is a global user setting in `~/.claude/settings.json`: recommended `350000` (trigger about `317k`), aggressive `250000` (about `217k`), leave default, or a custom value clamped to `100000..1000000`. A leftover project-level window is offered for removal because it overrides the global choice.
  - `SIDEQUEST_COMPACTION_POLICY` is per-project in the project `env` block. Choose `pin` (safe default), `veto` (experimental), or `off`. An unset policy behaves like `pin`, but the setup still asks and records an explicit choice. Gateway wiring is global and is not a setup choice.
- **`update-toolshed`** (`/update-toolshed`) refreshes only the Eigenwise Toolshed marketplace and updates only its recorded user, project, and local installs. It runs model-gateway setup and doctor when that plugin is installed, reports failures, reconciles global gateway wiring, and prints reload advice. It never runs automatically from SessionStart because it mutates installs and downloads dependencies.
- **`workbench-doctor`** (`/workbench-doctor`) is read-only. It combines updater check mode, the session freshness and Sidequest mapping audit, observability health, project telemetry attribution, agent-teams masking checks, and the local token-usage report. It reports the smallest next repair and never edits settings or installs anything.
- **`enable-project-telemetry`** (`/enable-project-telemetry`) asks for consent, enables or disables metadata-only telemetry for the enclosing repository, and verifies it. Enable merges only that repository's `.claude/settings.local.json` files, starts the local observer and Collector setup, and records the machine-local project registry. Disable removes only values this flow added and leaves shared processes and historical data alone. New sessions are required after settings changes.
- **`retro`** (`/retro`) reviews recurring friction in the current session, proposes the cheapest durable fix, waits for approval, and applies approved changes through the owning tool. Cross-session or subagent transcript mining belongs to the `skill-retro` plugin, not this skill.

## Commands and bundled programs

The programs are under `${CLAUDE_PLUGIN_ROOT}/bin` and can be run with Node.

| Program | Purpose and main options |
| --- | --- |
| `update-toolshed.js` | Performs the updater. `--check` is read-only, `--dry-run` prints commands, and `--migrate-model-gateway --confirm-sessions-closed` migrates retired `codex-gateway` installs after every Codex session is closed. `--claude <command>` selects the Claude Code executable. |
| `install-workspace-plugins.js` | Applies the JSON plan built by `init-workspace`. `--plan <file>` is required; `--check` inventories without mutation and `--dry-run` prints planned mutations. `--claude <command>` selects the executable. |
| `project-telemetry.js` | Enables or disables telemetry for `--project <absolute-path>`. Add `--disable` to remove this project's wiring and registry entry. |
| `verify-project-telemetry.js` | Checks whether the configured project has native `claude_code_*` samples. `--project <path>` selects the repository, `--audit` explains unwired or half-wired session directories, and `--window <hours>` changes the query window. |
| `setup-observability.js` | Installs or updates the loopback observer and Collector configuration. `--project`, `--sink grafana-lgtm\|otlp\|posthog\|none`, `--sink-endpoint`, `--dashboard`/`--no-dashboard`, `--lgtm`, four port options, `--check`, `--disable`, and `--delete-data` control setup and teardown. Remote OTLP requires HTTPS and explicit provider settings. |
| `install-otel-collector.js` | Validates and writes a Collector config to the path passed as its argument, then prints the `otelcol-contrib --config` command. |
| `workbench-observer.js` | Runs the canonical local observer. It accepts `--db`, `--host`, `--port`, `--config`, and `--outbox-endpoint`; hooks send it metadata-only observations. |
| `token-usage-report.js` | Prints the local SQLite usage report. Use `--format text\|json`, `--db`, `--sidequest-home`, and `--project`. It includes queue, drop, schema, conflict, SessionEnd, and newest-event health data. |
| `workbench-statusline.js` | Statusline shim for current usage and local Workbench context. The observability setup can register it for Claude Code. |

## Hooks

[hooks/hooks.json](hooks/hooks.json) registers these commands. Every hook is fail-open and uses short timeouts.

- **SessionStart (`startup|resume`)** runs `lib/observability/ensure.js --launch`, then `session-start-freshness.js` and `billing-path-check.js`. The ensure worker adopts or repairs enabled local observability. Freshness checks installed Toolshed plugins, marketplace cache age, gateway health, required Node and Claude Code versions, and Sidequest board-to-install mappings. Billing-path-check warns once per session when an API key overrides an available Pro, Max, Team, or Enterprise subscription seat.
- **SessionStart (all matches)** runs `observability.js` and records a metadata-only session-start observation.
- **SessionEnd** runs `observability.js` and records session end metadata.
- **UserPromptSubmit** runs `user-prompt-freshness.js`, which warns about available updates and blocks only when this session loaded an older Workbench than the installed copy. Maintenance prompts remain usable for recovery. It also runs `observability.js`.
- **PreToolUse (all tools)** runs `observability.js`. **PreToolUse (`Agent|Task`)** also runs `request-body-preflight.js`, which reads the gateway's per-session request high-water record and warns near the 32 MB request limit before spawning an executor.
- **PostToolUse (all tools)** runs `observability.js`.
- **Stop**, **SubagentStart**, and **SubagentStop** each run `observability.js`.

The observer records event type and bounded metadata such as project identity, permission mode, effort, tool facets, recipient, status, and error type. It never records prompt or response text, code or file contents, tool inputs or results, raw request bodies, credentials, or environment values.

## Local observability

Usage telemetry is opt-in per repository. Run `/enable-project-telemetry` from the project you want to include. It writes the telemetry environment to the repository root and any subdirectories hosting Claude Code sessions, using a sanitized project name and SHA-256 repository ID, then records the local opted-in-project registry. A new Claude Code session is required before native metrics appear. `found` means the verification query saw the project metric; `not-found` is reported honestly until activity and dashboard data exist.

SQLite is the source of truth and works without Docker. Local observability data stays until you delete it. The supported sinks are `grafana-lgtm`, `otlp`, `posthog`, and `none`. `none` keeps SQLite and local reports only. Grafana and generic OTLP receive the same redacted signals through the Collector. PostHog emits content-free `workbench.*` events and requires an explicit HTTPS regional host, `phc_` project key, and remote-egress opt-in. Remote OTLP requires HTTPS and keeps credentials in config headers rather than project settings.

After consent, the fail-open SessionStart ensure hook keeps the observer, Collector, and opted-in dashboard alive without prompts or OS services. It is a silent no-op without enabled consent, adopts healthy loopback listeners, heals managed version drift, and leaves startup through a detached worker. The observer drains hook spool and downstream outbox without overlapping flushes.

The optional `observability/grafana` viewer is a loopback-only `grafana/otel-lgtm:0.11.0` Docker demo with persistent `/data`, seven-day demo retention, and configurable local ports. Start it with:

```sh
docker compose -f plugins/workbench/observability/grafana/compose.yaml up -d
docker compose -f plugins/workbench/observability/grafana/compose.yaml down -v
```

The `observability/otel-collector` reference config receives OTLP/HTTP on `127.0.0.1:4318`, strips content-bearing attributes, batches through persistent file storage, sends to the observer at `127.0.0.1:14319`, and optionally fans out to the declared sink. It requires the OpenTelemetry Collector Contrib distribution. The generated config is installed with `install-otel-collector.js`.

Sink implementations and their local setup notes are in `observability/sinks/`: `grafana` for the managed viewer, `otlp` for a generic HTTPS endpoint, `posthog` for explicit remote analytics, and `none` for local-only storage. `observability/sinks/index.js` selects the configured provider.

## Library surface

The internal library is split into settings and observability modules:

- `lib/project-settings.js` reads project settings and reports when project `env` masks the global agent-teams setting.
- `lib/observability/ensure.js` starts, adopts, stops, and health-checks managed observer, Collector, and dashboard processes.
- `schema.js` defines the SQLite schema and migrations; `store.js` persists canonical events; `ingest.js` validates and ingests redacted observations; `resolve.js` builds report queries; `report.js` builds and formats token-usage reports.
- `hook-spool.js` writes bounded hook events for later drain; `outbox.js` queues downstream exports; `otlp.js` sends redacted OTLP batches; `sdk.js` and `sdk-query.js` observe Agent SDK messages without Workbench owning the SDK dependency.
- `request-body.js` reads the gateway request high-water record used by the preflight hook; `board-cost.js` attributes Sidequest board work and gateway costs.
- `adapters/codex-gateway.js` reads gateway cost observations; `adapters/sidequest.js` reads Sidequest board and executor observations.

## Agent SDK observability

`lib/observability/sdk-query.js` wraps the real async iterator from `@anthropic-ai/claude-agent-sdk` without making Workbench install or own that dependency. It was verified against `0.3.215`.

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

## License

[MIT](../../LICENSE) © Kenny Vaneetvelde
