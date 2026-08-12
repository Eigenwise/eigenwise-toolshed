# Workbench

Workbench sets up a Claude Code workspace, keeps Eigenwise Toolshed plugins current, and checks workspace health.

[Setup guide](https://eigenwise.github.io/eigenwise-toolshed/getting-started/workbench/) · [Generated reference](https://eigenwise.github.io/eigenwise-toolshed/reference/workbench/) · [Toolshed marketplace](../../README.md)

## Install

Run these in Claude Code:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install workbench@eigenwise-toolshed --scope user
```

Reload plugins or start a new Claude Code session, then tell Claude:

> Set up this project as a Claude Code workspace with Workbench.

Claude asks about the project and the workspace tools you want, installs the selected plugins, writes the project `.claude/` files, and verifies the result. Workbench stays at user scope so it is available across projects.

## Daily use

Tell Claude what you need:

> Update my Eigenwise Toolshed plugins.

> Check whether this workspace and its Toolshed plugins are healthy.

Workbench updates only Eigenwise Toolshed plugins and Model Gateway when installed. It leaves third-party plugins alone and tells you when an affected session needs `/reload-plugins` or a restart.

## Code intelligence

Workbench ships a local `code-intel` MCP server with three pull-only tools: `definition`, `references`, and `diagnostics`. The file extension selects the language server. Every call binds to an explicit project root and talks to that project's own TypeScript install (the native TypeScript 7 language server, or `typescript-language-server` for TypeScript 5 projects). TypeScript 7 diagnostics use the server's pull endpoint; the TypeScript 5 fallback has no pull endpoint, so Workbench triggers a fresh check and harvests the push that answers it, correlated to the requested file and version, one call at a time. Results come back only in the response to the call that asked; a location is returned only when its native realpath (symlinks and junctions resolved) is an existing file inside the bound root, everything else (non-file URIs included) is withheld and counted, and every other pushed diagnostic is discarded, so parallel agents working in isolated worktrees never see each other's results, and nothing leaves the machine.

C++ and C files use `clangd`. Before Workbench can answer, provide a current `compile_commands.json` that covers the queried translation unit. Set `WORKBENCH_CODE_INTEL_CPP_COMPILE_COMMANDS` to its path when it is outside the project root. A CMake project emits one by adding `-DCMAKE_EXPORT_COMPILE_COMMANDS=ON` to its own configure command, or `CMAKE_EXPORT_COMPILE_COMMANDS` to the preset's `cacheVariables`; set `WORKBENCH_CODE_INTEL_CPP_REGENERATE_COMMAND` to that command so refusals name it. Workbench refuses a missing, invalid, stale, or incomplete database instead of guessing a toolchain or running CMake. Initial C++ reference results may be marked incomplete while clangd builds its background index; retry or narrow the query.

This replaces the official `typescript-lsp` plugin, whose push diagnostics are process-global and blind to which agent owns them. If you have it installed, remove it:

```text
/plugin uninstall typescript-lsp@claude-plugins-official
```

The tools need TypeScript resolvable from the project: `npm install -D typescript@latest`, or a `typescript-language-server` install for TypeScript 5 projects.

## If something stops working

Tell Claude the symptom and ask it to run a Workbench health check. For a stale-plugin warning, ask Claude to update the Toolshed, then reload plugins or restart Claude Code before retrying. If setup stopped with an error, include that error when you ask Claude to resume or rerun the setup.

## License

MIT
