---
name: update-toolshed
description: >-
  Update every installed Eigenwise Toolshed plugin across user, project, and local scopes; refresh the
  marketplace; update codex-gateway's claude-code-proxy through its supported setup command; check
  gateway health; and say which Claude Code sessions must reload. Use when the user asks to update the
  toolshed, update all Toolshed plugins, refresh the Eigenwise marketplace, or check Toolshed versions.
---

# Update Toolshed

Run the portable updater from this plugin installation:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/update-toolshed.js"
```

It reads Claude Code's installed-plugin registry, refreshes `eigenwise-toolshed`, updates every recorded
Toolshed installation from the matching scope and project directory, then runs `codex-gateway setup` and
`doctor` when that plugin is installed. It continues after individual failures and prints the failing
commands.

Before changing anything, use this for a read-only report:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/update-toolshed.js" --check
```

Use this to show every command without changing anything:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/update-toolshed.js" --dry-run
```

## Reload boundary

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
