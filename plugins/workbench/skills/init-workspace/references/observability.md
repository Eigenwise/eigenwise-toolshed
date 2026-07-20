# Observability setup

`init-workspace` owns the observability interview. Workbench is the only manual prerequisite and must already be installed at user scope.

## Ask one compact question

Ask:

> Enable usage observability? It downloads a pinned Collector, edits this project's `settings.local.json`, and can add a local dashboard through Docker.

Never install without a clear yes. If `%LOCALAPPDATA%\Eigenwise\Workbench\observability.json` already exists, run the check pass first and show its current enabled state, sink, dashboard choice, and ports. Let the user keep it, switch sink, toggle the dashboard, change ports, or disable it. Disabling must ask whether to keep or delete observability data.

Do not ask for content-capture settings, Docker credentials, tokens, or remote endpoints during the normal interview. Docker is optional. SQLite capture and reports work without it.

## Check, then apply

Run the desired command with `--check` first. Show the reported current state and delta, then rerun it without `--check` after the user confirms.

Bare setup enables observability and adds the dashboard when Docker is available. Without Docker it prints one skip line and keeps SQLite observability running:

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

The helper checksum-verifies the pinned Collector, writes loopback-only config, stores consent plus sink/dashboard/ports in the single private `observability.json`, and preserves existing project or user status-line settings. When no status line exists, it installs a stable `~/.claude/workbench-statusline.js` shim that resolves the current Workbench cache entry at runtime. Workbench's hooks already capture metadata-only lifecycle events, so never hand-write duplicate hook entries.

After consent, every startup/resume launches a fail-open background ensure pass. It restores the observer and Collector when their configured ports are quiet, adopts or heals the configured dashboard container when Docker is present, and refreshes managed runtime files after a Workbench update. The observer drains its spool and downstream outbox continuously. Users do not start these processes manually.

The helper enables only local OTLP/HTTP and the pseudonymous telemetry path. Leave these content settings unset: `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT`, and `OTEL_LOG_RAW_API_BODIES`.

It stores the SQLite database, queues, cursors, salts, logs, and pid files in user application data (`%LOCALAPPDATA%\Eigenwise\Workbench` on Windows) with current-user-only permissions. Never print secret values or add plugin-registry entries yourself.

## Reload and verify

Treat an enable or settings change as another pre-reload step. Ask for the single normal reload only after the installer and all other pre-reload work succeed:

> The selected plugins, workspace files, and usage observability are ready. Run **`/reload-plugins`**, then tell me to continue. If Claude Code refuses because the reload changes MCP or LSP servers, run **`/reload-plugins --force`**. Restart Claude Code only if reload still does not load them.

After reload, use the configured observer port and verify:

```sh
claude --version
curl http://127.0.0.1:14319/health
node "${CLAUDE_PLUGIN_ROOT}/lib/observability/ensure.js" --health
node "${CLAUDE_PLUGIN_ROOT}/bin/token-usage-report.js"
```

For the dashboard, open its configured loopback URL (default `http://127.0.0.1:3000`). It uses the pinned `grafana/otel-lgtm:0.11.0` image and persistent Docker data. SQLite remains the report source of truth while Docker is unavailable or stopped.

## Retention and deletion

Workbench does not automatically age-prune SQLite observations or resolved reports. Acknowledged hook-spool and OTLP outbox rows are deleted as soon as they drain. Dashboard data is retained for seven days. `--disable` stops managed processes and the dashboard container, removes Workbench's project env wiring, and keeps data by default. Add `--delete-data` only after the user chooses deletion.
