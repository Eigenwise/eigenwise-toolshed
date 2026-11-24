# Toolshed

A set of Claude Code plugins that set up your workspace, plan the work with you, and route each kind of work to the right model. Files in your project are the source of truth: tickets, proposals and routing tables are markdown and JSON you can open and edit. You decide what gets built, once, after the agent has read the code and come back with what it found. Changes to your setup only happen with your yes, one at a time, and each one can be rolled back.

> [!NOTE]
> **Know Toolshed v1?** This is version 2, on the `v2` branch, under the marketplace name `toolshed-next`. Version 1 stays on `main` as `eigenwise-toolshed` and is deprecated as of 25 November 2026: no more fixes, no new releases. Your v1 install keeps working and keeps getting v1.
>
> Both can be installed on one machine. To move a project, add v2 with `claude plugin marketplace add Eigenwise/eigenwise-toolshed#v2`, install Quartermaster in that project with `claude plugin install quartermaster@toolshed-next --scope local`, reload plugins and run `/quartermaster:upgrade`. It switches v1 off and v2 on for that project only, converts your old rules and map, and tells you how to undo each step. [UPGRADING.md](UPGRADING.md) has the rest.

## What's in it

| Plugin | In one line |
| --- | --- |
| **quartermaster** | Sets up a workspace, notices what you keep doing by hand, proposes one fix at a time, applies it when you say yes, and checks later whether it helped. |
| **sidequest** | A work board. Give it a problem and it reads the code, pushes back, asks what only you can answer, then splits the work across agents routed to the right model per kind of work. |
| **codebase-mapper** | A map of your codebase as native path-scoped rules, so the right card loads when Claude touches that area. |
| **live-rules** | Write and audit `.claude/rules/` files without guessing the format. |

Each one works alone. Install only Sidequest and you get the board, the planning and model routing with zero setup.

There is no separate quality plugin. The review that runs on finished work checks it against what your project already wrote down (rules files, a contributing or style page, linter config). Where a project has nothing written down, `outfit` offers to write it from what the code already does.

## Install

You need Claude Code 2.1.325 or newer, git, and Node on the PATH (Node 22; the v1 upgrade needs 22.5 or newer).

```bash
claude plugin marketplace add Eigenwise/eigenwise-toolshed#v2
```

```bash
claude plugin install quartermaster@toolshed-next
```

If v1 is still on for all your projects on this machine, install per project with `--scope local` instead. Two plugins with the same name both load, and the upgrade switches the v1 one off in the same step.

You can also install only `sidequest@toolshed-next`. Nothing needs Quartermaster.

## First thing to try

Run `/quartermaster:outfit` in a project, new or existing.

- It looks at what's already there first: the code, your `.claude/` folder, the plugins you have, your session history.
- It proposes only what's missing, one item at a time, and writes nothing without your yes. If you don't have Sidequest, it says it will install it, then asks you to reload plugins once.
- In an empty folder it carries on into Sidequest's `plan` skill, which takes you to a running skeleton of what you want to build.

After that, describe a problem. Sidequest sizes it. Small and exact, it just does it. Bigger or fuzzy, it reproduces the bug or reads the code first and comes back with findings, options, pushback and a short round of questions. `/board` shows the board beside the chat. When the work is done in a repository with a remote, the session pushes a branch and opens a pull request, and where other people commit too, it leaves the merge to you.

`/qm` opens Quartermaster's inbox of proposals, each with Approve, Reject and Later.

## How it works

- **Files are the truth.** The board is `.sidequest/` in your project, one markdown file per ticket. Panes and the band above the prompt only show those files.
- **No servers.** Each plugin is one in-process hooks module. No port, no process per tool call.
- **Routing is one hook and a table.** A spawn whose prompt starts with a ticket id or carries a tag like `[route:hard]` runs on the model and effort its category maps to. Untagged fan-out runs on the `build` category. A spawn that names its own model, a fork, and an agent type that names its own model keep theirs. `/sidequest:setup` changes the table with a preset.
- **You decide what gets built**, once, after the agent has done its homework. Nobody asks you for a go-ahead after that.

## Coming from v1

| | v1 | v2 |
| --- | --- | --- |
| Board store | SQLite behind an MCP server | Markdown files in `.sidequest/` |
| Board view | Web dashboard on a port | Pane and band in the session |
| Tools the model sees | 58 | 4 |
| Routing | 19 generated agent files and a prompt marker | One hook and a table |
| Processes per tool call | Up to 10 | 0 |
| Planning | Autonomous by default | Investigate, push back, ask, then build |
| Gateway | In the path of Claude traffic | None |

Quality Gate and Observability from v1 have no v2 plugin. The upgrade switches them off and says so. The old v1 board stays on your machine as a read-only archive, and the upgrade offers to redraft the open tickets you pick.

## Status

Every plugin is still on a 0.x version, so expect changes between releases.

Found something wrong in v2? Open an issue on [Eigenwise/eigenwise-toolshed](https://github.com/Eigenwise/eigenwise-toolshed/issues) with the label `v2`.

## Longer pages

- Each plugin's own README: [quartermaster](plugins/quartermaster/README.md), [sidequest](plugins/sidequest/README.md), [codebase-mapper](plugins/codebase-mapper/README.md), [live-rules](plugins/live-rules/README.md).
- [UPGRADING.md](UPGRADING.md): moving a project from v1.
- [ARCHITECTURE.md](ARCHITECTURE.md): the design contract.
- [SCOPE.md](SCOPE.md): the bar a new mechanism has to clear. `.out-of-scope/` lists what was decided against, with reasons.

## Developing

```bash
node scripts/check.mjs
```

That validates every plugin, runs every mod's tests and prints the budget table. To try a change live, add your checkout as a local marketplace:

```bash
claude plugin marketplace add <path to your checkout>
```

Plugins from a local folder load in place, so an edit shows up after `/reload-plugins`.

## License

MIT.
