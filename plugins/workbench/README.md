# Workbench

[![Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FEigenwise%2Feigenwise-toolshed%2Fmain%2Fplugins%2Fworkbench%2F.claude-plugin%2Fplugin.json&query=%24.version&label=version&color=blue)](.claude-plugin/plugin.json)
[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-D97757?logo=claude&logoColor=white)](https://claude.com/claude-code)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](../../LICENSE)

*Part of the [eigenwise-toolshed](../../README.md), a small marketplace of Claude Code plugins by [Eigenwise](https://eigenwise.io).*

Workbench owns the lifecycle of a Claude Code workspace: set it up, keep its plugins current, check local health, and improve the workflow after real use.

## Install

Install Workbench once at user scope. It stays outside generated project settings, so a workspace never loads a second project-scoped copy or duplicate hooks.

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install workbench@eigenwise-toolshed --scope user
```

Reload plugins or restart Claude Code after installing.

## Skills

- **`init-workspace`** is the one bootstrap entrypoint for a project-side `.claude/` directory. It runs a short stack interview, proposes core and stack plugins, installs the selected plugins at project scope by default, then writes rules, structure notes, and a codebase map where appropriate. It asks for one reload and verifies every selected plugin works. Workbench stays user-scoped and never appears in generated project settings.
- **`update-toolshed`** refreshes marketplaces, updates recorded user, project, and local installs, checks the Codex gateway, and prints reload advice. Run it first with `--check` for a read-only report.
- **`workbench-doctor`** is the read-only health check. It combines updater check mode with the session health audit and reports the next useful repair step. When local telemetry is configured it also reports observer, Collector, optional LGTM, queue, drop, schema-conflict, and missing-SessionEnd health.
- **`retro`** reviews recurring session friction and proposes small, durable workspace improvements.

Bare skill names work as usual: `/init-workspace`, `/update-toolshed`, `/workbench-doctor`, and `/retro`. Qualified invocations use `/workbench:<skill>` when needed.

## Update and health

The updater changes installed plugins, so it is always user-invoked rather than automatic:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/update-toolshed.js" --check
node "${CLAUDE_PLUGIN_ROOT}/bin/update-toolshed.js"
```

After updates, reload every session that had an affected plugin loaded.

## Local observability

During `/init-workspace`, Workbench asks once whether to enable metadata-only usage observability. The setup downloads a checksummed pinned Collector, writes only project-local telemetry env keys to `.claude/settings.local.json`, and offers an optional loopback dashboard through Docker. Bare setup chooses the dashboard when Docker is available and skips it cleanly when Docker is absent. Run `/init-workspace` again at any time to show and change the sink, dashboard, or ports, or to disable observability and keep/delete its data.

Consent, enabled state, sink, dashboard choice, ports, and private provider settings live together in the current-user-only `observability.json`. The supported sinks are `grafana-lgtm`, `otlp`, `posthog`, and `none`. For Grafana and generic OTLP, the collector fans the same redacted signals out to the canonical observer and the selected backend. `none` keeps only SQLite plus local reports. The PostHog provider is reserved but remains disabled until its event mapping is defined. Remote OTLP requires HTTPS and keeps credentials in config headers instead of project settings.

After consent, a fail-open SessionStart ensure hook keeps the observer, Collector, and opted-in dashboard alive without prompts or OS services. It is a silent no-op when no enabled consent record exists, adopts healthy loopback listeners, heals managed version drift, and leaves startup immediately through a detached worker. The observer continuously drains both hook spool and downstream outbox without overlapping flushes.

SQLite is the source of truth and works without Docker. The optional `grafana/otel-lgtm:0.11.0` viewer uses the managed `workbench-otel-lgtm` container, a persistent `/data` volume, configurable loopback-only ports, and seven-day demo retention. Safe detailed facts are retained for 30 days, rollups for 365 days, and acknowledged spool rows for under 24 hours. No prompt, response, tool-content, raw-body, credential, or environment-value capture is enabled.

## Agent SDK observability

`lib/observability/sdk-query.js` wraps the real async iterator from `@anthropic-ai/claude-agent-sdk` without making Workbench install or own that dependency. This integration was verified against `@anthropic-ai/claude-agent-sdk` `0.3.215`.

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
  if (message.type === 'result') {
    console.log(message.subtype);
  }
}
```

Omit `traceparent` and `tracestate` to leave the SDK's automatic OpenTelemetry propagation alone. The SDK treats `options.env` as a replacement subprocess environment, not a merge. When supplying trace context, the adapter merges `process.env`, the caller's `options.env`, and the W3C variables. If you set `options.env` without trace context, include the environment variables the SDK process needs yourself.

## License

[MIT](../../LICENSE) © Kenny Vaneetvelde
