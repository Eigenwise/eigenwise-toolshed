# 🧰 claude-toolshed

A small, growing marketplace of [Claude Code](https://claude.com/claude-code) plugins.

> Sharp little tools for Claude Code, kept in one shed. 🛠️

## Plugins

| Plugin | What it does |
|--------|--------------|
| [**codebase-mapper**](./plugins/codebase-mapper) | A self-maintaining, language-agnostic map of your codebase that auto-loads into every Claude session — so Claude starts *grounded* in how your project is built instead of re-discovering it every time. |

*More tools will move into the shed over time.*

## Install

```text
/plugin marketplace add Eigenwise/claude-toolshed
/plugin install codebase-mapper@claude-toolshed
```

Reload with `/reload-plugins` (or restart Claude Code) and you're set — it's a public marketplace,
no auth required.

## Why codebase-mapper?

A fresh Claude session starts blind on any non-trivial repo: it re-greps the architecture, re-finds
the entry points, and re-learns your conventions — every single time. codebase-mapper fixes that:

- **Maps once** into small, atomic Markdown docs under `.claude/.codebase-info/` (architecture,
  modules, entry points, patterns, dependencies, …).
- **Auto-loads every session** via two complementary mechanisms — a `CLAUDE.md` import *and* a
  `SessionStart` hook — so the map is always in context without re-injecting it on every prompt.
- **Stays in sync** — a companion skill refreshes only the docs your changes actually affect.
- **Works anywhere** — any language or stack, and both brand-new and existing projects.

Two skills do the work: `map-codebase` (build it) and `update-codebase-map` (refresh it). Full
details in the [plugin README](./plugins/codebase-mapper).

## About

Built by **Kenny Vaneetvelde** — 15+ years building software, now deep in AI. I make open source
(most notably [Atomic Agents](https://github.com/eigenwise/atomic-agents)) and write about building
real things with AI.

- 🌐 Writing & projects — **[eigenwise.io](https://eigenwise.io)**
- 𝕏 — [@Kenny_V](https://twitter.com/Kenny_V)
- 🧱 Atomic Agents — [github.com/eigenwise/atomic-agents](https://github.com/eigenwise/atomic-agents)

## Support

If the toolshed saves you time, you can follow along with — and support — the work over at
**[eigenwise.io](https://eigenwise.io)**. 🙏

## License

[MIT](./LICENSE) © Kenny Vaneetvelde
