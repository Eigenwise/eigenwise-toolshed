# Observability setup

This skill owns the observability interview. `/quartermaster:setup` hands off to it after telemetry
consent, and it also runs standalone. Install this plugin at any scope (user, project, or local). The observer,
Collector, and dashboard container are machine-shared regardless of the install scope used by the launching
session. Machine service consent and repository opt-in are separate choices: consenting to the shared service
does not mean every repository should send telemetry.

The state directory (`%LOCALAPPDATA%\Eigenwise\Workbench` on Windows), the OpenTelemetry service name
`workbench-observer`, and the `workbench_` attribute prefix all kept their names when this plugin split out
of Workbench. They are on-disk and on-the-wire identifiers baked into shipped Grafana queries and existing
data. Renaming them orphans it.

## Ask two compact questions

Ask for the shared service first:

> Enable the shared local usage service? It downloads a pinned Collector and can add a local dashboard through Docker.

Then ask separately:

> Should this repository opt in to the shared service's metadata telemetry?

Never install the shared service without a clear yes, and never treat service consent as approval for every repository. If `%LOCALAPPDATA%\Eigenwise\Workbench\observability.json` already exists, run the check pass first and show its current enabled state, sink, dashboard choice, and ports. Let the user keep it, switch sink, toggle the dashboard, change ports, or disable it. Disabling must ask whether to keep or delete observability data.

Do not ask for content-capture settings, Docker credentials, tokens, or remote endpoints during the normal interview. Docker is optional. SQLite capture and reports work without it. The intended repository opt-in policy currently has a bounded enforcement limitation: hook events can enter the shared spool and ingest path before the opt-in check. State that limitation plainly and do not claim this setup fixes it.

## Check, then apply

Run the desired command with `--check` first. Show the reported current state and delta, then rerun it without `--check` after the user confirms.

Bare setup enables the shared SQLite observer with no dashboard. It does not request Docker. Use `--dashboard` when the user explicitly wants the Docker-backed loopback dashboard. If Docker is unavailable for that explicit choice, setup reports the skip and keeps SQLite observability running:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/setup-observability.js" --project "<absolute-project-dir>" --check
node "${CLAUDE_PLUGIN_ROOT}/bin/setup-observability.js" --project "<absolute-project-dir>"
```

Explicit choices:

```sh
# SQLite only
node "${CLAUDE_PLUGIN_ROOT}/bin/setup-observability.js" --project "<absolute-project-dir>" --sink none --no-dashboard

# SQLite plus the loopback dashboard
node "${CLAUDE_PLUGIN_ROOT}/bin/setup-observability.js" --project "<absolute-project-dir>" --dashboard

# Custom managed ports
node "${CLAUDE_PLUGIN_ROOT}/bin/setup-observability.js" --project "<absolute-project-dir>" --dashboard --collector-port 4318 --observer-port 14319 --dashboard-port 3000 --dashboard-otlp-port 14318

# Disable and keep data
node "${CLAUDE_PLUGIN_ROOT}/bin/setup-observability.js" --project "<absolute-project-dir>" --disable

# Disable and delete observability data
node "${CLAUDE_PLUGIN_ROOT}/bin/setup-observability.js" --project "<absolute-project-dir>" --disable --delete-data
```

`--lgtm` remains a compatibility alias for `--dashboard`; use dashboard language with users. The private config also supports `otlp` and reserves `posthog`. A user who explicitly asks for generic OTLP must set the HTTPS base endpoint and any headers under `observability.sinks.otlp`; secrets do not belong in project settings or command arguments.

The helper checksum-verifies the pinned Collector, writes loopback-only config, stores consent plus sink/dashboard/ports in the single private `observability.json`, and preserves existing project or user status-line settings. When no status line exists, it installs a stable `~/.claude/workbench-statusline.js` shim that resolves the current plugin cache entry at runtime, preferring this plugin and falling back to a pre-split Workbench install. This plugin's hooks already capture metadata-only lifecycle events, so never hand-write duplicate hook entries.

After consent, every startup/resume launches a fail-open background ensure pass. It restores the observer and Collector when their configured ports are quiet, adopts or heals the configured dashboard container when Docker is present, and refreshes managed runtime files after a plugin update. The newest running observer records its own PID and plugin version as soon as it binds. Treat that record as the runtime authority even when `/health` reports a downstream failure: an older open session must leave the newer observer and its dashboard files alone. The observer drains its spool and downstream outbox continuously. Users do not start these processes manually.

The helper enables only local OTLP/HTTP and the pseudonymous telemetry path. Leave these content settings unset: `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT`, and `OTEL_LOG_RAW_API_BODIES`.

It stores the SQLite database, queues, cursors, salts, logs, and pid files in user application data (`%LOCALAPPDATA%\Eigenwise\Workbench` on Windows) with current-user-only permissions. Never print secret values or add plugin-registry entries yourself.

## Reload and verify

Treat an enable or settings change as another pre-reload step. Ask for the single normal reload only after the installer and all other pre-reload work succeed:

> The selected plugins, workspace files, and usage observability are ready. Run **`/reload-plugins`**, then tell me to continue. If Claude Code refuses because the reload changes MCP or LSP servers, run **`/reload-plugins --force`**. Restart Claude Code only if reload still does not load them.

Environment wiring is read when a Claude Code process starts. After setup or project opt-in, restart every affected same-project session in the directories the command listed before creating activity or running verification. Reloading plugins alone does not apply the new environment.

After the restart and fresh activity, use the configured observer port and verify:

```sh
claude --version
curl http://127.0.0.1:14319/health
node "${CLAUDE_PLUGIN_ROOT}/lib/observability/ensure.js" --health
node "${CLAUDE_PLUGIN_ROOT}/bin/token-usage-report.js"
```

For the dashboard, open its configured loopback URL (default `http://127.0.0.1:3000`). It uses the pinned `grafana/otel-lgtm:0.11.0` image and persistent Docker data. SQLite remains the report source of truth while Docker is unavailable or stopped. After dashboard reprovisioning or reset, fully reload the browser tab. Grafana Refresh reruns queries already loaded in the page and does not load a newly generated dashboard definition.

## Dashboard reset recovery

`--reset-dashboards` removes generated dashboard definitions and records a reset boundary. It does not disable telemetry or delete local history. After a reset, create fresh Claude Code activity, run setup or let SessionStart reprovision the dashboards, fully reload the Grafana browser tab, and verify the project. Report `found` or `not-found` from the verifier as-is.

## Deletion

Local observations are pruned automatically after the retention window (30 days by default), and storage pressure can prune older whole days within that window. The user can also delete local data manually (the Grafana demo dashboard keeps seven days). `--disable` stops managed processes and the dashboard container, removes this plugin's project env wiring, and keeps data by default. Add `--delete-data` only after the user chooses deletion.
