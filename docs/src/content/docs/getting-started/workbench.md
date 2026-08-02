---
title: Workbench setup
description: Set up and maintain a Claude Code workspace with Workbench.
---

Workbench handles workspace setup, plugin updates, and local health checks. It is the only plugin you install by hand before anything else, and it is the entry point to the rest of the marketplace. Telemetry and the statusline moved to [Observability](/eigenwise-toolshed/observability/setup/); retrospectives and working practice moved to [Playbook](/eigenwise-toolshed/getting-started/playbook/).

Install it for your user account:

```text
/plugin install workbench@eigenwise-toolshed --scope user
```

User scope matters because Workbench is the workspace manager you want in every project. A second project-scoped copy would double-load its hooks, and `/workbench:init-workspace` requires the user-scope install.

Reload Claude Code after installing. From a project directory, run `/workbench:init-workspace`. The setup interview proceeds in these steps:

1. Setup starts with telemetry consent before it inspects the project.
2. It enables Claude Code agent teams in that project's `.claude/settings.local.json`, preserving any existing project environment keys.
3. If you opt in, it installs the Observability plugin, configures and verifies local telemetry, then stops so you can restart Claude Code and run `/workbench:init-workspace` again; the completed telemetry setup is remembered on re-entry. See [Observability setup](/eigenwise-toolshed/observability/setup/) for what that plugin does.
4. If you decline, it asks what the project is for, then shows a recommendation-bearing plugin picker built from the current Toolshed marketplace catalog.
5. With Sidequest selected, it also asks you to confirm a routing profile and whether dispatched executors should use isolated git worktrees (the default) or always share the checkout. Shared checkout is for outputs that must appear there or projects where parallel worktrees have caused trouble, and the chosen setting is saved to the board config.
6. It assesses the project, interviews you about the setup, installs the selected plugins, and writes the `.claude/` configuration, including live rules.
7. It can also seed a lightweight `CLAUDE.md` for static project context if you choose that during the interview.

The reload boundary matters because Claude Code discovers plugin skills and hooks when a session starts.

### Compaction configuration

`/workbench:init-workspace` asks how much context to keep before Claude Code auto-compacts. The window is a user preference stored in `~/.claude/settings.json`, so it applies to every project. The recommended window is `350000` tokens, which means compaction starts at roughly `317000` tokens. The aggressive option is `250000` (roughly `217000`), and custom values can range from `100000` to `1000000`. The practical trigger is the selected window minus about `33000` tokens. Leaving the setting at its default removes `autoCompactWindow`; on models pinned to a 1M-token context window, auto-compaction effectively never fires. You can also change the global window with `/autocompact`.

The same setup step asks for a project-specific `SIDEQUEST_COMPACTION_POLICY`:

- `pin` preserves active board state in the compaction summary. Unset has the same behavior.
- `off` disables the Sidequest compaction policy.
- `veto` preserves board state and can delay compaction during unsafe moments. Veto is experimental and should stay disabled until the spike confirms that hook blocks do not trip Claude Code's auto-compact failure breaker.

Workbench writes the policy to the project's `.claude/settings.local.json` and preserves the rest of that file. Project environment blocks mask global environment values, so global settings cannot reliably carry this policy. If setup finds an older project-local `autoCompactWindow`, it tells you that it overrides the global preference and offers to remove it.

At session start, Workbench can tell you when the loaded Workbench version is behind the installed version. Run `/reload-plugins` to pick up the installed version, or restart Claude Code if reload does not work. It can also report Toolshed updates available from its cached marketplace data. That cached signal is not a live network check: run `/update-toolshed`, then `/reload-plugins` to refresh the plugins and load them in the current session.

## Hooks and bundled commands

Workbench hooks are fail-open and short-lived. `SessionStart` runs the freshness and billing-path checks; `UserPromptSubmit` checks plugin freshness. Workbench records nothing itself. The lifecycle observation hooks belong to the [Observability](/eigenwise-toolshed/observability/setup/) plugin, and installing that plugin is what turns them on.

The bundled commands live under the plugin's `bin/` directory: `update-toolshed --check` is read-only, and `install-workspace-plugins --check` inventories a plan without mutating anything.

`/workbench:workbench-doctor` is the read-only health check. It covers updater state, session freshness, Sidequest board mappings, and agent-teams masking, and it adds observer, collector, registry, and statusline checks when the Observability plugin is installed.

## Updates

Use `/workbench:update-toolshed` to refresh installed Toolshed plugins and the gateway proxy. It leaves third-party marketplaces and plugins alone, then tells you which affected Toolshed sessions to reload.

It removes registry entries for deleted Sidequest agent worktrees, writes a timestamped registry backup first, and reports every removal. Other missing project directories are still skipped and reported without changing the registry.

Gateway wiring is global and has no mode to choose: `env --write-user` writes `~/.claude/settings.json` once and reaches every project and executor worktree. The hosts file is machine-wide, which is why RC-compatibility uses global wiring. Remote Control and the Codex/Grok rows in `/model` cannot both work. Compatibility hides the gateway rows, but `/model claude-gpt-5.6-terra` still works and persists as the default. Disabling compatibility restores the rows. `/workbench:update-toolshed` writes that block and reconciles leftover wiring from older installs.
