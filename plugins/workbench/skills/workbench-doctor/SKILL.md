---
name: workbench-doctor
description: >-
  Run a read-only health check for the Workbench and installed Toolshed plugins. Use when the user asks to
  diagnose Toolshed, check workspace health, inspect plugin freshness without updating, or troubleshoot
  a stale-plugin warning.
---

# Workbench Doctor

Run the updater in check mode first. It only reads the installed-plugin registry and runs the Codex gateway
health check when that plugin is installed:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/update-toolshed.js" --check
```

Then run the same read-only session health audit used at startup:

```sh
node -e "const { audit } = require(process.env.CLAUDE_PLUGIN_ROOT + '/hooks/session-start-freshness.js'); const result = audit(); console.log(JSON.stringify({ problems: result.problems, boards: result.mappings }, null, 2));"
```

Then run the observability checks if the local Workbench database exists. They are read-only; Docker is optional:

```sh
curl http://127.0.0.1:14319/health
node "${CLAUDE_PLUGIN_ROOT}/bin/token-usage-report.js" --format json
```

Treat a failed observer health request as observer-down, rather than zero telemetry. Check the pinned Collector
process/config separately, and if Docker is installed check `workbench-otel-lgtm-demo` plus its loopback ports.
From the JSON report, call out outbox queue depth/capacity, drops, schema drops, telemetry conflicts, sessions
missing `SessionEnd`, and the newest event/source. Report Docker/LGTM as optional: SQLite capture and reports must
remain useful while it is stopped.

Report all results together. Explain each concrete problem and give the smallest next step. This skill does
not update, install, uninstall, reload, or edit anything. If freshness is proven stale, tell the user to run
`/update-toolshed`, then `/reload-plugins` or restart before retrying the blocked work.
