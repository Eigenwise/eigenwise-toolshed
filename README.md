# Toolshed

A set of Claude Code plugins that set up your workspace, plan the work with you, and route each kind of work to the right model. Files in your project are the source of truth: tickets, proposals and routing tables are markdown and JSON you can open and edit. You decide what gets built, once, after the agent has read the code and come back with what it found. Changes to your setup only happen with your yes, one at a time, and each one can be rolled back.

The docs are at [eigenwise.github.io/eigenwise-toolshed](https://eigenwise.github.io/eigenwise-toolshed/).

## What's in it

| Plugin | In one line |
| --- | --- |
| **quartermaster** | Sets up a workspace, notices what you keep doing by hand, proposes one fix at a time, applies it when you say yes, and checks later whether it helped. |
| **sidequest** | A work board. Give it a problem and it reads the code, pushes back, asks what only you can answer, then splits the work across agents routed to the right model per kind of work. |
| **codebase-mapper** | A map of your codebase as native path-scoped rules, so the right card loads when Claude touches that area. |
| **live-rules** | Write and audit `.claude/rules/` files without guessing the format. |
| **observability** | A local record of what each turn cost: one line per finished turn, per project, on your machine. Off until you switch it on. |

Each one works alone. Install only Sidequest and you get the board, the planning and model routing with zero setup.

There is no separate quality plugin. The review that runs on finished work checks it against what your project already wrote down (rules files, a contributing or style page, linter config). Where a project has nothing written down, `outfit` offers to write it from what the code already does.

## Install

You need Claude Code 2.1.325 or newer, git, and Node on the PATH (Node 22.5 or newer: the upgrade and the Live Rules audit need it).

```bash
claude plugin marketplace add Eigenwise/eigenwise-toolshed
```

```bash
claude plugin install quartermaster@eigenwise-toolshed
```

You can also install only `sidequest@eigenwise-toolshed`. Nothing needs Quartermaster.

## First thing to try

Run `/quartermaster:outfit` in a project, new or existing.

- It looks at what's already there first: the code, your `.claude/` folder, the plugins you have, your session history.
- It proposes only what's missing, one item at a time, and writes nothing without your yes. If you don't have Sidequest, it says it will install it, then asks you to reload plugins once.
- In an empty folder it carries on into Sidequest's `plan` skill, which takes you to a running skeleton of what you want to build.

After that, describe a problem. Sidequest sizes it. Small and exact, it just does it. Bigger or fuzzy, it reproduces the bug or reads the code first and comes back with findings, options, pushback and a short round of questions. `/board` shows the board beside the chat. When the work is done in a repository with a remote, the session pushes a branch and opens a pull request, and where other people commit too, it leaves the merge to you.

`/quartermaster` opens Quartermaster's inbox of proposals, each with Approve, Reject, Already handled and Later.

## How it works

- **Files are the truth.** The board is `.sidequest/` in your project, one markdown file per ticket. Panes and the band above the prompt only show those files.
- **No servers.** Each plugin is one in-process hooks module. No port, no process per tool call.
- **Routing is one hook and a table.** A spawn whose prompt starts with a ticket id or carries a tag like `[route:hard]` runs on the model and effort its category maps to. Untagged fan-out runs on the `build` category. A spawn that names its own model, a fork, and an agent type that names its own model keep theirs. `/sidequest:setup` changes the table with a preset.
- **You decide what gets built**, once, after the agent has done its homework. Nobody asks you for a go-ahead after that.

## Coming from v1

This is the rewrite that replaced v1 on `main`. It kept the marketplace name, so a normal plugin update moves your `sidequest`, `quartermaster`, `codebase-mapper`, `live-rules` and `observability` to this version. The update changes nothing in your projects.

This version does not read v1's board, rules or map. In each project, run `/quartermaster:upgrade`. It shows what it found and asks before every change. [UPGRADING.md](UPGRADING.md) has the whole path.

- `observability` updates in place: a project that was recording keeps recording, and its history stays.
- `quality-gate` and `model-gateway` are not in this version.
- Still wired to `model-gateway`? Leave it installed and switched on until the upgrade has unwired it. Removing it first blocks every prompt in that project.
- Want to stay on v1? It lives on the [`v1` branch](https://github.com/Eigenwise/eigenwise-toolshed/tree/v1) and is not maintained. Remove the marketplace, add it again as `Eigenwise/eigenwise-toolshed#v1`, and install your plugins again.
- Installed a plugin from `toolshed-next` as well? Claude Code runs only one copy of a plugin name, with no warning, and lists the skills of both. Uninstall the `toolshed-next` one: `claude plugin uninstall <name>@toolshed-next`.

## Status

This is Toolshed 2. Each plugin keeps its own version number, and those continue from v1's (sidequest 7, quartermaster 2, codebase-mapper 3, live-rules 3, observability 2), so an install's first number says whether it is v1 or this.

Found something wrong? Open an issue on [Eigenwise/eigenwise-toolshed](https://github.com/Eigenwise/eigenwise-toolshed/issues).

## Longer pages

- Each plugin's own README: [quartermaster](plugins/quartermaster/README.md), [sidequest](plugins/sidequest/README.md), [codebase-mapper](plugins/codebase-mapper/README.md), [live-rules](plugins/live-rules/README.md), [observability](plugins/observability/README.md).
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
