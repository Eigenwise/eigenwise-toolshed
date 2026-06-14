# 🧰 claude-toolshed

A small, growing marketplace of [Claude Code](https://claude.com/claude-code) plugins.

> Sharp little tools for Claude Code, kept in one shed. 🛠️

## Plugins

| Plugin | What it does |
|--------|--------------|
| [**codebase-mapper**](./plugins/codebase-mapper) | Keeps a small, self-updating map of your codebase and loads it into every Claude session, so Claude already knows how your project is built when you start working. |

*More tools will move into the shed over time.*

## Install

```text
/plugin marketplace add Eigenwise/claude-toolshed
/plugin install codebase-mapper@claude-toolshed
```

Then run `/reload-plugins` (or restart Claude Code) and you're set. It's a public marketplace, so there's no auth to deal with.

## Why codebase-mapper?

On any non-trivial repo, a fresh Claude session starts blind. It greps for the architecture, hunts down the entry points, and re-learns your conventions before it can do anything useful, then starts from scratch again the next session. codebase-mapper does that work **once** and keeps it:

- It writes a set of small, atomic Markdown docs under `.claude/.codebase-info/` (architecture, modules, entry points, patterns, dependencies, and so on).
- It loads the map into every session two ways, a `CLAUDE.md` import and a `SessionStart` hook, so the context is there without re-injecting it on every prompt.
- A companion skill refreshes only the docs your changes actually touch, so the map stays current.
- It works on any language or stack, and on both new and existing projects.

Two skills run it: `map-codebase` builds the map and `update-codebase-map` refreshes it. The [plugin README](./plugins/codebase-mapper) has the full details.

## About

Built by **Kenny Vaneetvelde** (AKA Eigenwise).

- 🌐 Writing & projects: [eigenwise.io](https://eigenwise.io)
- 𝕏: [@Kenny_V](https://x.com/Kenny_V)
- 🧱 Atomic Agents: [github.com/eigenwise/atomic-agents](https://github.com/eigenwise/atomic-agents)

## Support

These plugins are **free and open**. If they save you time, a coffee or a GitHub sponsorship genuinely helps me keep building and maintaining them.

[![Support me on Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/eigenwise) or [sponsor me on GitHub](https://github.com/sponsors/Eigenwise).

## License

[MIT](./LICENSE) © Kenny Vaneetvelde
