---
name: workbench-doctor
description: >-
  Run a read-only health check for Workbench and installed Toolshed plugins. Use to diagnose Toolshed,
  check workspace health, or troubleshoot stale plugins.
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

Then read the consent/config record and report the managed observability health. This command is read-only and uses the configured ports/container:

```sh
node "${CLAUDE_PLUGIN_ROOT}/lib/observability/ensure.js" --health
```

If it reports `configured: false`, observability was never consented to and needs no repair. If it reports `enabled: false`, say it is deliberately disabled. For an enabled record, report observer health, Collector listening state, selected sink, configured ports, and dashboard/Docker state. Treat a listening observer with a failed `/health` response as unhealthy, and a configured dashboard without Docker as optional/unavailable rather than a pipeline failure.

When the observer is healthy, audit project attribution. Hook events reach the observer from any directory,
but the `claude_code_*` metrics only exist where Claude Code found the telemetry env in the settings of the
directory the session started in. A project with observer events and no native samples in the same window is
half-wired, and its dashboard reads empty rather than broken. This command is read-only:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/verify-project-telemetry.js" --audit --project "<absolute-current-project-dir>"
```

Report every `UNWIRED` session directory by name, every `half-wired:` line, and the printed `fix:` command
verbatim, adding that each affected session has to restart before its metrics appear. `native-samples=unknown`
means Grafana was unreachable or unconfigured, so say the check could not run instead of calling it healthy. A
`not opted in:` line is a hint, not a fault: those project names never opted in.

Then check whether a project-level `env` block masks the global agent-teams setting. This is read-only and prints nothing when the project has no `env` block or already enables teams:

```sh
node -e "const { agentTeamsWarning } = require(process.env.CLAUDE_PLUGIN_ROOT + '/lib/project-settings.js'); const warning = agentTeamsWarning(process.cwd()); if (warning) console.log(warning);"
```

If it prints a warning, report it with the one-line remedy verbatim. Do not fix it from the doctor.

Then run the local report too:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/token-usage-report.js" --format json
```

From the JSON report, call out outbox queue depth/capacity, drops, schema drops, telemetry conflicts, sessions missing `SessionEnd`, and the newest event/source. The SessionStart ensure hook repairs stopped managed processes on the next startup/resume; if immediate repair is requested, rerun `/init-workspace` and keep the current observability choices.

Report all results together. Explain each concrete problem and give the smallest next step. This skill does
not update, install, uninstall, reload, or edit anything. If freshness is proven stale, tell the user to run
`/update-toolshed`, then `/reload-plugins` or restart before retrying the blocked work.
