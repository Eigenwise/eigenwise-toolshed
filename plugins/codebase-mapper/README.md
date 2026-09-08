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

Claude reads the project and creates the useful map documents under `.claude/.codebase-info/`. It leaves `CLAUDE.md` alone. Outside an explicit no-commit instruction, the mapping skill commits the generated documents and `.map-state.json` so the map is available to future sessions.

## Keep it current

The plugin checks after code changes. It assesses whether documented behavior, structure, interfaces, dependencies, or conventions changed, then acts without waiting for a separate approval:

- A genuine no-op leaves the map and state alone.
- A warranted incremental update edits only affected documents, refreshes `.map-state.json`, and commits the map outside shared-tree artifact mode.
- A larger remap or structural drift can use an optional Sidequest artifact handoff when the live `codebase-exploration` contract is available. The artifact writer leaves `.claude/.codebase-info/` in the working tree for the invoking session to verify and commit.
- Without Sidequest, Codebase Mapper runs the same work inline. Standalone Mapper does not require Sidequest.

If you explicitly say not to commit, the skill leaves the verified map changes in the working tree and tells you what still needs review or committing. The map is available automatically when a session starts, and dispatched Sidequest executors and general-purpose subagents get it too.

You can also ask directly:

> Update the codebase map for the changes in this session.

## If something looks wrong

- **No map exists:** Ask Claude to map the codebase.
- **The map is stale:** Ask Claude to update it after the latest changes, or let the post-change assessment handle it.
- **A section is missing:** Name the area you want checked and ask Claude to update the map.
- **The map is missing for teammates:** Check whether an explicit no-commit instruction left it uncommitted, then review and commit `.claude/.codebase-info/`.

Codebase Mapper works with existing and greenfield projects. It leaves `CLAUDE.md` alone.

## Support

Optional support is welcome through [Ko-fi](https://ko-fi.com/eigenwise) or [GitHub Sponsors](https://github.com/sponsors/Eigenwise).

## License

MIT
