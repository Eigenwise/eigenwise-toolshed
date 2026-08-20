# Codebase Mapper

Codebase Mapper gives Claude a current map of your project, so future sessions can find the right files and understand the main flows without starting from zero.

[Setup guide](https://eigenwise.github.io/eigenwise-toolshed/getting-started/codebase-mapper/) · [Generated reference](https://eigenwise.github.io/eigenwise-toolshed/reference/codebase-mapper/) · [Toolshed marketplace](../../README.md)

## Install

Run these in Claude Code:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install codebase-mapper@eigenwise-toolshed --scope project
```

Then ask Claude:

> Map this codebase for future sessions.

Claude reads the project and creates the useful map documents under `.claude/.codebase-info/`. Review and commit that directory so your team and future sessions share the map.

## Keep it current

After a meaningful change, ask:

> Update the codebase map for the changes in this session.

Claude checks whether the map needs work and updates only the affected documents. The map is available automatically when a session starts, and dispatched Sidequest executors and general-purpose subagents get it too.

## If something looks wrong

- **No map exists:** Ask Claude to map the codebase.
- **The map is stale:** Ask Claude to update it after the latest changes.
- **A section is missing:** Name the area you want checked and ask Claude to update the map.
- **The map is missing for teammates:** Commit `.claude/.codebase-info/` and share that change.

Codebase Mapper works with existing and greenfield projects. It leaves `CLAUDE.md` alone.

## License

MIT
