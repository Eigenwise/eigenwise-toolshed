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
node -e "const { audit } = require(process.env.CLAUDE_PLUGIN_ROOT + '/hooks/session-start-freshness.js'); const result = audit(); console.log(JSON.stringify({ problems: result.problems, boards: result.mappings }, null, 2));"
```

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

## TypeScript code intelligence

Workbench serves TypeScript/JavaScript definition, references, and diagnostics through its own pull-only
`code-intel` MCP server (`typescript_definition`, `typescript_references`, `typescript_diagnostics`). Check
that a language server backend is reachable from the current project. This is read-only:

```sh
node -e "const { locateLanguageServer } = require(process.env.CLAUDE_PLUGIN_ROOT + '/lib/code-intel/language-server-locator.js'); const outcome = locateLanguageServer(process.cwd()); console.log(outcome.error || ('ok: ' + outcome.backend + ' at ' + outcome.command));"
```

An `ok:` line means the tools work here. An error line is not a Workbench fault: report it verbatim, it
already names the fix (install TypeScript 7 in the project, or typescript-language-server for TypeScript 5
projects). When the backend is `typescript-language-server`, mention that TypeScript 5 ships no pull
endpoint, so diagnostics come from a push the server sends for exactly the requested file and version,
harvested into that one response; per-call behavior is identical, the first result on a cold project just
takes longer. Skip this whole check for projects with no TypeScript or JavaScript source.

Also check whether the official native LSP plugin is still installed:

```sh
node -e "const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const reg=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.claude','plugins','installed_plugins.json'),'utf8'));console.log((reg?.plugins?.['typescript-lsp@claude-plugins-official']||[]).length?'installed':'not installed');"
```

If it prints `installed`, report that `typescript-lsp@claude-plugins-official` pushes diagnostics
process-wide and blind to which agent owns them, so diagnostics from parallel isolated worktrees land in
the wrong transcript, and that Workbench's pull-only tools replace it. Recommend removing it with
`/plugin uninstall typescript-lsp@claude-plugins-official` and a reload. Do not uninstall it from the
doctor; only report.

## Agent teams

Check whether a project-level `env` block masks the global agent-teams setting. This is read-only and prints nothing when the project has no `env` block or already enables teams:

```sh
node -e "const { agentTeamsWarning } = require(process.env.CLAUDE_PLUGIN_ROOT + '/lib/project-settings.js'); const warning = agentTeamsWarning(process.cwd()); if (warning) console.log(warning);"
```

If it prints a warning, report it with the one-line remedy verbatim. Do not fix it from the doctor.

Report all results together. Explain each concrete problem and give the smallest next step. This skill does
not update, install, uninstall, reload, or edit anything. If freshness is proven stale, tell the user to run
`/update-toolshed`, then `/reload-plugins` or restart before retrying the blocked work.
