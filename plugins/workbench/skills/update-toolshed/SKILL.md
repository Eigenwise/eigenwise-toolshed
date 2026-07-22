---
name: update-toolshed
description: >-
  Update installed Eigenwise Toolshed plugins and codex-gateway, or check their status. Use to update
  Toolshed, refresh the marketplace, or check versions.
---

# Update Toolshed

Run the portable updater from this plugin installation:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/update-toolshed.js"
```

It reads Claude Code's installed-plugin registry, refreshes only `eigenwise-toolshed`, and updates only Toolshed plugins from that marketplace at their recorded scope and project directory. It does not inspect, refresh, or update third-party marketplaces or plugins. It then runs `codex-gateway setup` and
`doctor` when that plugin is installed. In the default local gateway mode it also writes every recorded
project's `.claude/settings.local.json`, moves only gateway-owned legacy keys out of `settings.json`, and
removes the old user block only after every project succeeds. Unrecorded projects stay unwired until
`codex-gateway env --write-project` runs there. Gateway wiring changes apply to new Claude Code sessions,
so restart affected sessions. It continues after individual failures and prints the failing commands.

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
