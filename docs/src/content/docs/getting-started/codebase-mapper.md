---
title: Codebase Mapper
description: Give Claude a current map of your project so sessions can get oriented quickly.
---

Codebase Mapper creates a project map that helps Claude understand where things live, how the main pieces fit together, and where to start when you ask for work. It works with existing and new projects.

## Install

Run these in Claude Code:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install codebase-mapper@eigenwise-toolshed --scope project
```

Then ask Claude:

> Map this codebase for future sessions.

Claude reads the project, creates the useful map documents under `.claude/.codebase-info/`, and records their state. It leaves `CLAUDE.md` alone. Outside an explicit no-commit instruction, the mapping skill commits the generated documents and `.map-state.json` so the map is available to future sessions.

## Daily use

After code changes, the installed Mapper hook tells Claude to assess whether the map needs work and to run `update-codebase-map` immediately when it does. It does not wait for a separate approval.

The assessment has a few paths:

- **Genuine no-op:** no documented behavior, structure, interface, dependency, or convention changed, so the map and state stay untouched.
- **Incremental update:** only affected documents are edited, the document list and `.map-state.json` are refreshed, and the map is committed outside shared-tree artifact mode.
- **Larger remap:** a larger structural drift can use an optional Sidequest artifact handoff when its live contract is available. The shared-tree artifact writer leaves `.claude/.codebase-info/` in the working tree for the invoking parent session to verify and commit.
- **Standalone fallback:** when Sidequest is absent or its artifact contract is unavailable, Mapper completes the work inline. Standalone Codebase Mapper does not require Sidequest.

If you explicitly say not to commit, the skill leaves verified map changes in the working tree and tells you what still needs review or committing. You can also ask directly:

> Update the codebase map for the changes in this session.

The map is available automatically when a session starts. Dispatched Sidequest executors and general-purpose subagents get it too, so delegated work starts oriented as well.

## If the map needs attention

- **There is no map yet:** Ask Claude to map the codebase. It will create the initial map.
- **The map is stale:** Ask Claude to update it after the latest changes, or let the post-change assessment handle it.
- **A section is missing or wrong:** Name the area or behavior you want checked, then ask Claude to update the map.
- **Your team does not see the map:** Check whether an explicit no-commit instruction left it uncommitted, then review and commit `.claude/.codebase-info/`.

See the generated [Codebase Mapper reference](../../reference/codebase-mapper/) for the agent-facing skill details.
