---
name: inspect
description: Read-only health check of the installed Toolshed plugins. Use when something seems not to work, routing looks wrong, or before trusting a setup.
---

# Inspect

Prove each Toolshed capability is installed, loaded in this session and exercised. Installed alone proves nothing. This skill changes nothing: no installs, no settings edits, no restarts. Every line you report is one observed fact plus the one next move.

## 1. Each installed plugin

The plugin list covers the whole machine, hundreds of rows on a busy one. Keep only this project's:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/inspect-facts.mjs" plugins --project "${CLAUDE_PROJECT_DIR}"
```

It runs `claude plugin list --json` itself, in the `--project` folder, because the listing says enabled or disabled for the folder it runs in. It runs the same in a POSIX shell and in PowerShell, and the quotes keep a path with a space whole. The first line says how many rows apply and how many it left out; say both numbers in your report. Our plugins and the older Toolshed share the marketplace `eigenwise-toolshed`, so each row of ours ends with which it is: `(this version)`, `(the older Toolshed: ...)` by its version, `(the older Toolshed, not in this version: ...)` for `quality-gate` and `model-gateway`, or `(this version under its earlier name: ...)` for `toolshed-next`. Take the rows of this version and of the earlier name. For each, find three rungs:

- **Installed**: the row exists and is enabled. Note version and scope.
- **Loaded**: this session can see what it ships. Its skills show in your skill list, its `/` commands exist, its tools are in your tool list (`mcp__quartermaster__evidence`, `mcp__sidequest__board` and so on). Installed but not loaded usually means it was installed after this session started.
- **Exercised**: `mcp__quartermaster__evidence` shows its skills used in this project. With no evidence tool, say exercised is unknown. Never guess.

An `enabledPlugins` entry with no install row is a dead entry. Report it as such.

A row marked the older Toolshed is not updated yet: report it with the move, `/quartermaster:upgrade`, which gives the two update commands. A row marked not in this version is never updated: `/quartermaster:upgrade` offers to uninstall it, the gateway only once nothing is wired to it. Then look at the rows from every other marketplace that apply to this project. A plugin with the same name as one of ours that is also enabled (a fork, or this version under both names at once) is a clash: both load, their skills share one namespace, and the other one's hooks fire on our work. Report each clash with both scopes, and say which of the two this session's skills and tools actually come from.

## 2. Routing killers

These silently defeat per-category model routing. Check each one in the process environment (`printenv <NAME>` in Bash) and in the `env` block of `~/.claude/settings.json`, `.claude/settings.json` and `.claude/settings.local.json`:

- `CLAUDE_CODE_EFFORT_LEVEL`: when set at all, the Agent tool loses its `effort` parameter, so every routed effort is ignored.
- `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`: when set, the Agent tool loses its `model` parameter and every subagent runs on one model.
- `availableModels` in any of those settings files: compare it against the models routing uses (`.sidequest/board.json` tiers, or the defaults `sonnet`, `opus`, `fable`). A blocked alias steps down to an allowed model or inherits the parent, with only a warning.

Name the file or the environment as the source. Only report what is set.

## 3. Hook failures

Count the cancelled and timed-out hooks in the newest transcript of this project, by hook name:

```sh
node "${CLAUDE_PLUGIN_ROOT}/scripts/inspect-facts.mjs" hooks --project "${CLAUDE_PROJECT_DIR}"
```

It reads the newest `<config dir>/projects/<slug>/*.jsonl` (`CLAUDE_CONFIG_DIR` or `~/.claude`) and prints one line per hook with its count. A hook that died is invisible to the model otherwise, so this is the only place it shows.

## 4. Boards

Only when Sidequest is installed. Boards made by accident (a session started in a temp folder or a home folder) stay on disk, so list them:

```sh
node "<Sidequest install path>/scripts/boards.mjs"
```

The install path is the `installPath` of the Sidequest row from step 1. It is read-only: it lists the boards in the project folders the installed-plugins record names for Sidequest and in the folders sessions ran in, with ticket counts, the last change and whether each is in a git repository, marked rows first and a count line last. Report the marked ones with their folders. Never remove one from here: it only goes with the person's yes, as `--remove=<project folder>`.

## 5. Report

One line per finding, grouped by plugin, then routing, then hooks, then boards. Each line names the fact and the move:

- "sidequest 0.1.0: installed at project scope, not loaded in this session. Run `/reload-plugins`."
- "`CLAUDE_CODE_EFFORT_LEVEL=high` set in `.claude/settings.json` env: routed effort is ignored. Remove it or accept one effort for every agent."
- "sidequest is enabled twice: ours at local scope and one from another marketplace at local scope. Both load. If the other one is `toolshed-next`, `/quartermaster:upgrade` moves it; for any other marketplace `/quartermaster:outfit` offers to disable one."
- "sidequest 6.10.3 at user scope is the older Toolshed. `/quartermaster:upgrade` gives the two commands that update it."
- "live-rules: loaded, never exercised in 23 sessions. Worth a `retire` proposal from `/quartermaster:resupply`."
- "3 cancelled hooks in the newest transcript: 2 `PreToolUse:Bash`, 1 `Stop`. Check those hooks' timeouts."

End with what is healthy in one line. When a fix is a change to the setup, point at `/quartermaster:resupply` or `/quartermaster`. Never make the change from here.
