---
title: Workbench setup
description: Set up and maintain a Claude Code workspace with Workbench.
---

Workbench sets up a Claude Code workspace, keeps Eigenwise Toolshed plugins current, and checks workspace health.

## Install

Run these in Claude Code:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install workbench@eigenwise-toolshed --scope user
```

Reload plugins or start a new Claude Code session. Workbench belongs at user scope because it is the workspace manager you use across projects.

## Set up a project

From the project directory, tell Claude:

> Set up this project as a Claude Code workspace with Workbench.

Workbench asks about telemetry, the project, and the plugins and workspace choices that fit. After you approve the plan, it installs the selected plugins, writes the project `.claude/` files, asks for one plugin reload, and verifies the setup. It keeps existing Claude configuration and rules when it adds its own files.

If you choose telemetry, Claude handles the Observability setup and tells you when a restart is needed. You can also decline and continue without it.

## Daily use

Tell Claude what you want to do:

> Update my Eigenwise Toolshed plugins.

> Check whether this workspace and its Toolshed plugins are healthy.

> Why is this session using an older Workbench version?

Claude uses the bundled update or doctor skill, tells you what it found, and asks you to reload or restart when the installed code is newer than the session. Updates cover the Eigenwise Toolshed marketplace and Model Gateway when it is installed. Third-party plugins are left alone. The health check also identifies an `enabledPlugins` entry that has no matching install, because its hooks are not running. Claude can install the plugin at the reported scope or remove the dead entry from the named settings file.

## Code intelligence

Workbench includes a local `code-intel` MCP server with three pull-only tools: `definition`, `references`, and `diagnostics`. The file extension selects among C++, TypeScript and JavaScript, and Python language servers. Each call binds to an explicit project root. For TypeScript and JavaScript, Workbench searches from that root upward for a language server and can fall back to a global wrapper. TypeScript 7 projects use the native TypeScript language server. TypeScript 5 projects use `typescript-language-server` instead.

C and C++ files use `clangd`. Python files use `pyright`. Workbench resolves a project or global pyright server and chooses an interpreter from an explicit override, an activated `VIRTUAL_ENV` that contains the file, a nearest `.venv` or `venv`, or `PATH`. Before the tools can answer, provide a current `compile_commands.json` covering the queried translation unit. A CMake project emits one by adding `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON` to its own configure command, or `CMAKE_EXPORT_COMPILE_COMMANDS` to the preset's `cacheVariables`. Workbench never runs that step for you, and it will not guess your preset or generator.

Point Workbench at the database and tell it how to rebuild one:

```text
WORKBENCH_CODE_INTEL_CPP_COMPILE_COMMANDS=build-ninja/compile_commands.json
WORKBENCH_CODE_INTEL_CPP_REGENERATE_COMMAND=cmake --preset your-preset -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
```

The database defaults to `compile_commands.json` at the project root. Setting the regenerate command is optional, and worth it: refusals name that command instead of describing the general case.

The server reads these settings from the environment:

| Variable | Purpose |
| --- | --- |
| `WORKBENCH_CODE_INTEL_CPP_COMPILE_COMMANDS` | Path to the C or C++ `compile_commands.json`; defaults to the bound project root. |
| `WORKBENCH_CODE_INTEL_CPP_REGENERATE_COMMAND` | Command named in C++ refusal messages for regenerating the compilation database. Workbench never runs it. |
| `WORKBENCH_CODE_INTEL_CPP_LANGUAGE_SERVER` | Override the `clangd` executable. |
| `WORKBENCH_CODE_INTEL_NATIVE_SERVER` | Override the native TypeScript language-server executable. It cannot be set together with `WORKBENCH_CODE_INTEL_LANGUAGE_SERVER`. |
| `WORKBENCH_CODE_INTEL_LANGUAGE_SERVER` | Override the `typescript-language-server` wrapper. It cannot be set together with `WORKBENCH_CODE_INTEL_NATIVE_SERVER`. |
| `WORKBENCH_CODE_INTEL_PYRIGHT_SERVER` | Override the `pyright` language-server path. |
| `WORKBENCH_CODE_INTEL_PYTHON_INTERPRETER` | Override the Python interpreter path. |
| `WORKBENCH_CODE_INTEL_TIMEOUT_MS` | Request timeout in milliseconds; defaults to 45,000. |
| `WORKBENCH_CODE_INTEL_IDLE_MS` | Idle client lifetime in milliseconds; defaults to 300,000 (5 minutes). |
| `WORKBENCH_CODE_INTEL_SWEEP_MS` | Client sweep interval in milliseconds; defaults to 60,000 (1 minute). |
| `VIRTUAL_ENV` | Python discovery uses this environment when the queried file is inside it. |
| `PATH` or `Path` on Windows | Fallback discovery for Python, TypeScript, `pyright`, and `clangd`. |

Workbench refuses a missing, invalid, stale, or incomplete database rather than guessing a toolchain or emitting misleading diagnostics. C++ reference results can be marked incomplete while clangd is building its background index. Retry or narrow the query.

This replaces the official `typescript-lsp` plugin. Its push diagnostics are process-global and cannot tell which agent owns them, so diagnostics from parallel isolated worktrees can land in the wrong transcript. If it is installed, remove it and reload plugins:

```text
/plugin uninstall typescript-lsp@claude-plugins-official
```

The TypeScript and JavaScript queries need a TypeScript language server available from the project or a global wrapper, for example:

```text
npm install -D typescript@latest
```

For a TypeScript 5 project, install `typescript-language-server` instead.

## If something stops working

- **Setup stopped before the workspace was ready:** tell Claude to resume or rerun the Workbench workspace setup and include the last error.
- **A prompt says the Toolshed is stale:** ask Claude to update the Toolshed, then run `/reload-plugins` or restart Claude Code before resubmitting the prompt.
- **A plugin or workspace check fails:** say which plugin or workflow failed and ask Claude to run a Workbench health check. It will give you the smallest next step.
- **New plugin skills are missing after an install:** reload plugins or start a new session.

The [generated Workbench reference](/reference/workbench/) contains the agent-facing skill and command details.
