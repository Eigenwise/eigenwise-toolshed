---
name: toolshed-doctor
description: >-
  Run a read-only health check for Workbench and installed Toolshed plugins. Use to diagnose Toolshed,
  check workspace health, or troubleshoot stale plugins.
---

# Toolshed Doctor

Run the updater in check mode first. It only reads the installed-plugin registry and runs the Codex gateway
health check when that plugin is installed:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/update-toolshed.js" --check
```

Then run the same read-only session health audit used at startup:

```sh
node -e "const { audit } = require(process.env.CLAUDE_PLUGIN_ROOT + '/hooks/session-start-freshness.js'); const result = audit({ currentProject: process.cwd() }); console.log(JSON.stringify({ problems: result.problems, boards: result.mappings, staleProcesses: result.staleProcesses }, null, 2));"
```

An `enabledPlugins` entry only selects an installed plugin. If the audit says a plugin's hooks are not running,
that settings file enables a plugin with no matching install row. Offer to install it at the reported project or
user scope, or remove the dead `enabledPlugins` entry from the named file. Do not call that plugin configured or
healthy until one of those actions is complete.

When `staleProcesses` has rows, report each PID, start time, and stale worktree path. They are read-only findings: do not kill any process from the doctor.

## Observability, when that plugin is installed

Telemetry lives in the separate Observability plugin. Its files are under a different plugin root, so resolve
that root first and skip this whole section when the plugin is absent:

```sh
node -e "const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const reg=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.claude','plugins','installed_plugins.json'),'utf8'));const installs=reg?.plugins?.['observability@eigenwise-toolshed']||[];const hit=installs.map(i=>i?.installPath).filter(Boolean).find(p=>fs.existsSync(path.join(p,'bin','setup-observability.js')));console.log(hit||'');"
```

An empty result means observability is not installed. Say so in one line and move on. Otherwise use that path
as `<OBS_ROOT>` in the commands below.

Read the consent/config record and report the managed observability health. This command is read-only and uses the configured ports/container:

```sh
node "<OBS_ROOT>/lib/observability/ensure.js" --health
```

If it reports `configured: false`, observability was never consented to and needs no repair. If it reports `enabled: false`, say it is deliberately disabled. For an enabled record, report observer health, Collector listening state, selected sink, configured ports, dashboard/Docker state, and the `storage` block. Treat a listening observer with a failed `/health` response as unhealthy, and a configured dashboard without Docker as optional/unavailable rather than a pipeline failure.

Report `storage.overDatabaseLimit: true` or `storage.overWalLimit: true` as a real finding with the two byte counts, not as a note. Over the database limit means retention pruning alone cannot get back under the cap, so the file only grows; the next prune reclaims by dropping the oldest days and that runs a `VACUUM`, which blocks the observer while it works. Say how long that will take from the current size before recommending it.

When the observer is healthy, audit project attribution. Hook events reach the observer from any directory,
but the `claude_code_*` metrics only exist where Claude Code found the telemetry env in the settings of the
directory the session started in. A project with observer events and no native samples in the same window is
half-wired, and its dashboard reads empty rather than broken. This command is read-only:

```sh
node "<OBS_ROOT>/bin/verify-project-telemetry.js" --audit --project "<absolute-current-project-dir>"
```

Report every `UNWIRED` session directory by name, every `half-wired:` line, and the printed `fix:` command
verbatim, adding that each affected session has to restart before its metrics appear. `native-samples=unknown`
means Grafana was unreachable or unconfigured, so say the check could not run instead of calling it healthy. A
`not opted in:` line is a hint, not a fault: those project names never opted in.

Then run the local report too:

```sh
node "<OBS_ROOT>/bin/token-usage-report.js" --format json
```

From the JSON report, call out outbox queue depth/capacity, drops, schema drops, telemetry conflicts, sessions missing `SessionEnd`, and the newest event/source. The SessionStart ensure hook repairs stopped managed processes on the next startup/resume; if immediate repair is requested, rerun `/observability:enable-project-telemetry` and keep the current observability choices.

## Agent teams

Check whether a project-level `env` block masks the global agent-teams setting. This is read-only and prints nothing when the project has no `env` block or already enables teams:

```sh
node -e "const { agentTeamsWarning } = require(process.env.CLAUDE_PLUGIN_ROOT + '/lib/project-settings.js'); const warning = agentTeamsWarning(process.cwd()); if (warning) console.log(warning);"
```

If it prints a warning, report it with the one-line remedy verbatim. Do not fix it from the doctor.

Report all results together. Explain each concrete problem and give the smallest next step. This skill does
not update, install, uninstall, reload, or edit anything. If freshness is proven stale, tell the user to run
`/update-toolshed`, then `/reload-plugins` or restart before retrying the blocked work.
