# Observability setup

`init-workspace` can set up metadata-only local telemetry after the normal plugin-selection interview. Workbench is the only manual prerequisite: it must already be installed at user scope.

## Ask one compact question

After the plugin choices, ask:

> Set up local telemetry too? It stores safe metadata in local SQLite. You can also start the optional local Grafana viewer with Docker. Choose **SQLite only**, **SQLite + LGTM**, or **skip**.

Do not ask for a token, endpoint, Docker credential, or any content-capture setting. Docker is optional. SQLite capture and reports work without it.

## Pre-reload setup

When the user chooses either telemetry option:

1. Confirm `claude --version` is at least `2.1.212`.
2. Run the resumable setup helper from the installed Workbench root:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/bin/setup-observability.js" --project "<absolute-project-dir>" --sink none
   ```

   Use `--sink grafana-lgtm` for the SQLite + LGTM choice. `--lgtm` remains an alias. The helper downloads and checksum-verifies the pinned Collector Contrib release, writes its loopback-only config, stores the sink choice in the private Workbench `observability.json`, preserves `.claude/settings.json`, and wraps an existing status-line renderer rather than replacing it. Workbench's plugin hooks already contribute the metadata-only lifecycle hooks, so do not hand-write or duplicate hook entries.
3. If any setup step fails, stop before writing dependent workspace artifacts or requesting reload. Keep the same command as the recovery path. It is safe to rerun.

The private config also supports `otlp` and reserves `posthog`. Do not offer remote setup during the normal init interview. A user who explicitly asks for generic OTLP must set the HTTPS base endpoint and any headers under `observability.sinks.otlp`; secrets do not belong in project settings or command arguments.

The helper enables only local OTLP/HTTP at `127.0.0.1:4318`, all three signal exporters, beta traces, and the pseudonymous telemetry path. Leave these content settings unset: `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT`, and `OTEL_LOG_RAW_API_BODIES`.

It stores the SQLite database, queues, cursors, salts, and any local bearer material in user application data (`%LOCALAPPDATA%\Eigenwise\Workbench` on Windows) with current-user-only permissions. Never print secret values or add plugin-registry entries yourself.

## Reload and verify

Treat telemetry as another pre-reload step. Ask for the single normal reload only after the installer and all other pre-reload work succeed:

> The selected plugins, workspace files, and local telemetry are ready. Run **`/reload-plugins`**, then tell me to continue. If Claude Code refuses because the reload changes MCP or LSP servers, run **`/reload-plugins --force`**. Restart Claude Code only if reload still does not load them.

After the reload, verify exactly:

```sh
claude --version
curl http://127.0.0.1:14319/health
node "${CLAUDE_PLUGIN_ROOT}/bin/token-usage-report.js"
```

For LGTM, also open `http://127.0.0.1:3000`. It is loopback-only, uses the pinned `grafana/otel-lgtm:0.11.0` image, mounts persistent `/data`, and retains its demo data for seven days. SQLite remains the report source of truth when Docker is stopped.

## Retention and deletion

Safe detailed facts are retained for 30 days. Daily rollups are retained for 365 days. Acknowledged spool/outbox rows are retained for under 24 hours. LGTM data is retained for seven days. Use the observer's project, session, or time-range deletion commands when a user requests deletion; never delete the application-data directory wholesale.
