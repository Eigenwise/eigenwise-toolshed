---
name: update-toolshed
description: >-
  Update installed Eigenwise Toolshed plugins and model-gateway, or check their status. Use to update
  Toolshed, refresh the marketplace, or check versions.
---

# Update Toolshed

Run the portable updater from this plugin installation:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/update-toolshed.js"
```

It reads Claude Code's installed-plugin registry, refreshes only `eigenwise-toolshed`, and updates only Toolshed plugins from that marketplace at their recorded scope and project directory. It does not inspect, refresh, or update third-party marketplaces or plugins. Before gateway setup, it prints each recorded version transition and warns that the gateway worker will restart while its listener stays available. In-flight requests drain or retry, and the authenticated proxy stays up unless its binary changed. Claude Code's registry has versions but not release notes or commit history, so the updater says that plainly instead of guessing at a changelog. It then runs `model-gateway setup` and `doctor` when that plugin is installed. In the default local gateway mode it also writes every recorded
project's `.claude/settings.local.json`, moves only gateway-owned legacy keys out of `settings.json`, and
removes the old user block only after every project succeeds. Unrecorded projects stay unwired until
`model-gateway env --write-project` runs there. Gateway wiring changes apply to new Claude Code sessions,
so restart affected sessions. It continues after individual failures and prints the failing commands.

## Gateway rename migration

If the updater finds the retired `codex-gateway` install, it stops before refreshing plugins, running setup, or changing wiring. Close every Claude Code session using Codex. From a terminal, run the updater's deferred migration command from the installed Workbench plugin:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/update-toolshed.js" --migrate-model-gateway --confirm-sessions-closed
```

It installs `model-gateway` at each legacy scope, moves only `~/.claude/codex-gateway` state, runs setup, ensure, and doctor, rewires recorded projects, then retires the legacy registry rows. The confirmation is deliberate: the command does not stop the shared gateway or change its state while another session may still use it.

Before changing anything, use this for a read-only report:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/update-toolshed.js" --check
```

Use this to show every command without changing anything:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/update-toolshed.js" --dry-run
```

## Freshness guard and reload boundary

Workbench runs the prompt freshness check for active Toolshed plugins. When it knows an active install is behind, it blocks the prompt before Claude sees it. Run this updater, then `/reload-plugins` or restart Claude Code and resubmit the prompt. The guard allows `/update-toolshed`, `/reload-plugins`, and exact `/plugin` maintenance commands so recovery works. For an emergency only, start Claude Code with `EIGENWISE_TOOLSHED_FRESHNESS_BYPASS=1`; remove that override once updates are possible.

An update does not replace the plugin code already loaded by an open Claude Code session. Tell the user
exactly what the updater reports: run `/reload-plugins` in each affected session, or restart Claude Code
if reload does not pick up the new version. User-scoped installs affect every open session; project and
local installs affect sessions open in their recorded project directories.

## Keep normal updates automatic

Marketplace auto-update is the normal path. In `/plugin`, open **Marketplaces**, select
`eigenwise-toolshed`, and choose **Enable auto-update**. Claude Code checks after session start with a
random delay of up to 10 minutes. Third-party marketplaces start with auto-update off, and an already-open
session still needs `/reload-plugins` or a restart after an update lands.

Do not add this updater to SessionStart. It intentionally changes installed plugins and downloads the
codex gateway dependency, so automatic startup work stays non-mutating.
