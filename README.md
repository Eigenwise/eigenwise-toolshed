# 🧰 eigenwise-toolshed

A small, growing marketplace of [Claude Code](https://claude.com/claude-code) plugins.

> Sharp little tools for Claude Code, kept in one shed. 🛠️

## Plugins

| Plugin | What it does |
|--------|--------------|
| [**codebase-mapper**](./plugins/codebase-mapper) | Keeps a small, self-updating map of your codebase and loads it into every Claude session, so Claude already knows how your project is built when you start working. |
| [**live-rules**](./plugins/live-rules) | Inject your own rules into Claude's context the moment they apply: global rules on every prompt, file-type and directory rules right before an edit, keyword rules when your prompt matches. Edit a rule, it applies on the next prompt. |

*More tools will move into the shed over time.*

## Install

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install codebase-mapper@eigenwise-toolshed
/plugin install live-rules@eigenwise-toolshed
```

Then run `/reload-plugins` (or restart Claude Code) and you're set. It's a public marketplace, so there's no auth to deal with.

## Why codebase-mapper?

On any non-trivial repo, a fresh Claude session starts blind. It greps for the architecture, hunts down the entry points, and re-learns your conventions before it can do anything useful, then starts from scratch again the next session. codebase-mapper does that work **once** and keeps it:

- It writes a set of small, atomic Markdown docs under `.claude/.codebase-info/` (architecture, modules, entry points, patterns, dependencies, and so on).
- A bundled `UserPromptSubmit` hook re-injects the map on every prompt, so it stays in context deep into a long session and Claude keeps consulting and updating it as you work.
- A companion skill refreshes only the docs your changes actually touch, so the map stays current.
- It works on any language or stack, and on both new and existing projects.

Two skills run it: `map-codebase` builds the map and `update-codebase-map` refreshes it. The [plugin README](./plugins/codebase-mapper) has the full details.

## Why live-rules?

`CLAUDE.md` is a static, always-on brief. But a lot of guidance is **conditional**: a React rule only
matters when you touch a `.tsx` file, a deploy checklist only matters when you deploy. Put it all in
`CLAUDE.md` and it is either permanently in your context or quietly buried. live-rules fixes that:

- You keep your rules in one Markdown file (`.claude/live-rules.md`, or wherever `LIVE_RULES_PATH`
  points), each a short frontmatter block saying **when** it applies (global, a file glob, a directory,
  or a prompt keyword).
- Two bundled hooks inject only the rules that apply, right when they apply: global and keyword rules on
  every prompt, file and directory rules the moment Claude is about to edit a matching file.
- Rules are read fresh every time, so editing one takes effect on the **next prompt**, no restart.
- A rule can also `include:` a live file, so its current contents ride along every prompt. That makes
  live-rules a general way to keep any file in front of Claude, a codebase map included: it is the same
  mechanism codebase-mapper uses, so a single rule reproduces that auto-loading.
- Commit the file and the whole team shares the same rules.

Two skills help: `add-rule` writes a rule from a plain-English request, and `manage-rules` lists,
audits, and toggles them. Hand-editing works just as well. The [plugin README](./plugins/live-rules)
is a full userguide.

## About

Built by **Kenny Vaneetvelde** (AKA Eigenwise).

- 🌐 Writing & projects — [eigenwise.io](https://eigenwise.io)
- 𝕏 — [@Kenny_V](https://x.com/Kenny_V)
- 🧱 Check out [Atomic Agents](https://github.com/eigenwise/atomic-agents)

## Support

These plugins are **free and open**. If they save you time, [a coffee](https://ko-fi.com/eigenwise) or [a GitHub sponsorship](https://github.com/sponsors/Eigenwise) genuinely helps me keep building and maintaining them.

| Ko-fi | GitHub Sponsors |
|:-----:|:---------------:|
| <a href="https://ko-fi.com/eigenwise"><img height="32" alt="Support me on Ko-fi" src="https://ko-fi.com/img/githubbutton_sm.svg"></a> | <a href="https://github.com/sponsors/Eigenwise"><img height="32" alt="Sponsor on GitHub" src="https://img.shields.io/badge/Sponsor-EA4AAA?style=for-the-badge&logo=githubsponsors&logoColor=white"></a> |

## License

[MIT](./LICENSE) © Kenny Vaneetvelde
