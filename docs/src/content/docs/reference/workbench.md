---
title: workbench
description: "Set up and maintain a Claude Code workspace: initialize project-side configuration, check and update Toolshed plugins, diagnose local health, and run retrospectives."
---

<!-- AUTO-GENERATED — do not edit; run npm run generate -->
# workbench

Set up and maintain a Claude Code workspace: initialize project-side configuration, check and update Toolshed plugins, diagnose local health, and run retrospectives.

**Version:** `0.48.0`

## Skills

- - `enable-project-telemetry`: Opt this project into local Claude Code usage telemetry. Writes only this project's private settings, prepares Workbench's loopback observer and Collector, records the local project registry, and verifies whether metrics arrive. Use when the user asks to enable, disable, or verify project telemetry.
- - `init-workspace`: Set up a complete Claude Code workspace for a project, new or existing. Runs a short interview, installs the selected project plugins, then writes .claude/ end to end: live rules, a codebase map, and structure notes, wired around the plugin-reload boundary and verified firing. Use for WHOLE-workspace setup: "set up a Claude workspace", "init/bootstrap this project for Claude", "configure Claude Code for this repo", "set up .claude / the toolshed here", "get this project ready for Claude Code". Holistic orchestrator: it sequences codebase-mapper, live-rules, sidequest, skill-creator, and the built-in /init. Prefer it whenever the user wants the whole setup (for only a map use map-codebase; for only one rule use add-rule).
- - `retro`: Run a structured retrospective on the current session: review the work for recurring friction, then propose and apply concrete improvements to the workspace so the same friction is cheaper or impossible next time. Use when the user asks to "do a retro", "run a retrospective", "reflect on this session", "what did we learn", "improve the workspace", "what slowed us down", or after a long or painful task when it's worth capturing the lessons. This is the deep, on-demand half of the workspace self-improvement loop (the lightweight always-on half is a live rule installed by init-workspace). Turns friction into durable fixes: live rules, codebase-map updates, CLAUDE.md notes, or new skills via skill-creator.
- - `update-toolshed`: Update every installed Eigenwise Toolshed plugin across user, project, and local scopes; refresh the marketplace; update codex-gateway's claude-code-proxy through its supported setup command; check gateway health; and say which Claude Code sessions must reload. Use when the user asks to update the toolshed, update all Toolshed plugins, refresh the Eigenwise marketplace, or check Toolshed versions.
- - `workbench-doctor`: Run a read-only health check for the Workbench and installed Toolshed plugins. Use when the user asks to diagnose Toolshed, check workspace health, inspect plugin freshness without updating, or troubleshoot a stale-plugin warning.

## Hooks

- **SessionStart** (startup|resume): `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/lib/observability/ensure.js" --launch`
- **SessionStart** (startup|resume): `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-freshness.js"`
- **SessionStart** (startup|resume): `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/billing-path-check.js"`
- **SessionStart**: `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/observability.js"`
- **SessionEnd**: `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/observability.js"`
- **UserPromptSubmit**: `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/user-prompt-freshness.js"`
- **UserPromptSubmit**: `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/observability.js"`
- **PreToolUse** (*): `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/observability.js"`
- **PreToolUse** (Agent|Task): `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/request-body-preflight.js"`
- **PostToolUse** (*): `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/observability.js"`
- **Stop**: `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/observability.js"`
- **SubagentStart**: `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/observability.js"`
- **SubagentStop**: `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/observability.js"`

## Bin entrypoints

- `install-otel-collector.js`
- `install-workspace-plugins.js`
- `project-telemetry.js`
- `setup-observability.js`
- `token-usage-report.js`
- `update-toolshed.js`
- `verify-project-telemetry.js`
- `workbench-observer.js`
- `workbench-statusline.js`

[Source on GitHub](https://github.com/Eigenwise/eigenwise-toolshed/tree/main/plugins/workbench)
