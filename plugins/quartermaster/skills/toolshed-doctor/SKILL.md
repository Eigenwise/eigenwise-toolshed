---
name: toolshed-doctor
description: >-
  Run a read-only health check for Quartermaster and installed Toolshed plugins. Use to diagnose Toolshed,
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

For Model Gateway, report the audit finding exactly. It distinguishes a missing checker, a spawn error, a three-second startup timeout, a nonzero doctor result, and empty output. A nonzero doctor result includes one bounded, secret-filtered diagnostic line and is never a missing-checker finding. The SessionStart warning uses the same cause in compact form. These checks only report observed health; do not call the gateway healthy because a later command happened to pass.

An `enabledPlugins` entry only selects an installed plugin. If the audit says a plugin's hooks are not running,
that settings file enables a plugin with no matching install row. Offer to install it at the reported project or
user scope, or remove the dead `enabledPlugins` entry from the named file. Do not call that plugin configured or
healthy until one of those actions is complete.

When `staleProcesses` has rows, report each PID, start time, and stale worktree path. They are read-only findings: do not kill any process from the doctor.

## Observability, when that plugin is installed

Read the installed-plugin registry at `<claude config dir>/plugins/installed_plugins.json`.
The config directory is `CLAUDE_CONFIG_DIR` when set, otherwise `~/.claude`.
A matching `observability@eigenwise-toolshed` install row identifies an installed plugin;
use the row for the current project/scope and its `installPath` as `<OBS_ROOT>`.
Do not require a particular plugin file to recognize an install, or infer installation from
`enabledPlugins`. With no matching row, say "Observability is not installed" and skip this section.

Report the current project's recording state with the read-only command:

```text
/observability:track status
```

The command in `<OBS_ROOT>/hooks/register.ts` reads the engine plugin store's
`track:<project.root>` key, where the root comes from the session repository or, outside a
repository, the session working directory. Only boolean true opts in. The engine owns this
store; no opt-in JSON filename is part of Observability's public contract. Do not infer consent
from an existing ledger. If the command is unavailable, report recording state as unknown.
For an installed plugin with recording off, say in one line: "Observability is installed; this
project is not opted in." Do not enable recording or change settings.

Inspect local files read-only, including when recording is off:

- Resolve `<claude config dir>/observability/ledger/<project-slug>.jsonl` with the same project
  root and slug algorithm exported by `<OBS_ROOT>/hooks/ledger.ts` (`projectSlug`). Report the
  absolute ledger path, whether it exists, its byte size, and the newest valid row's `at`
  timestamp. An empty ledger has no newest timestamp. Report malformed rows or unreadable
  files as findings rather than calling them empty or healthy. Missing history does not prove
  recording is disabled.
- Report whether `<claude config dir>/observability/board.html` exists. Its absence means no
  generated board is present. The registered `/observability:board` command rebuilds and opens
  it, so do not run that command during this read-only check.

Do not install, rebuild the board, delete history, or run recording changes from the doctor.

## Agent teams

Check whether a project-level `env` block masks the global agent-teams setting. This is read-only and prints nothing when the project has no `env` block or already enables teams:

```sh
node -e "const { agentTeamsWarning } = require(process.env.CLAUDE_PLUGIN_ROOT + '/lib/project-settings.js'); const warning = agentTeamsWarning(process.cwd()); if (warning) console.log(warning);"
```

If it prints a warning, report it with the one-line remedy verbatim. Do not fix it from the doctor.

## Codex auto-compact window

Check the effective `autoCompactWindow` from user and project settings. This is read-only; the project
setting wins when both files set the key:

```sh
node -e "const { compactionWindowFinding } = require(process.env.CLAUDE_PLUGIN_ROOT + '/lib/project-settings.js'); console.log(compactionWindowFinding(process.cwd()));"
```

Report the finding verbatim. Explicit user or project values are reported and preserved. When neither
sets the key, an installed Model Gateway owns the policy: the finding reads its saved context-window
file through the installed gateway reader and report formatter, including its defaults and saved
compact-at maximum. Without the gateway, compaction follows the model default; its `context-window`
command is the supported policy control once installed. Do not recommend a fixed global window,
write settings, or offer to fix them from the doctor.

Report all results together. Explain each concrete problem and give the smallest next step. This skill does
not update, install, uninstall, reload, or edit anything. If freshness is proven stale, tell the user to run
`/quartermaster:update-toolshed`, then `/reload-plugins` or restart before retrying the blocked work.
