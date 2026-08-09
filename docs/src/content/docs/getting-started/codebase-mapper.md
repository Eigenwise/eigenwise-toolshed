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

Claude reads the project, creates the useful map documents under `.claude/.codebase-info/`, and records their state. It leaves `CLAUDE.md` alone. Review the generated files and commit `.claude/.codebase-info/` so your team and future sessions share the same map.

## Daily use

After a meaningful structural or behavioral change, tell Claude:

> Update the codebase map for the changes in this session.

Claude checks whether the map needs work, updates only the affected documents, and keeps the map's document list and state current. If nothing documented changed, it leaves the map alone.

The map is available automatically when a session starts, so you can begin with the task instead of explaining the repository layout again.

## If the map needs attention

- **There is no map yet:** Ask Claude to map the codebase. It will create the initial map.
- **The map is stale:** Ask Claude to update it after the latest changes.
- **A section is missing or wrong:** Name the area or behavior you want checked, then ask Claude to update the map. Review the cited paths before committing it.
- **Your team does not see the map:** Commit `.claude/.codebase-info/` and pull that change in the other checkout.

See the generated [Codebase Mapper reference](../reference/codebase-mapper/) for the agent-facing skill details.
