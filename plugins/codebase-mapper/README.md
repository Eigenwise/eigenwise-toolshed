# codebase-mapper

[![Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FEigenwise%2Feigenwise-toolshed%2Fmain%2Fplugins%2Fcodebase-mapper%2F.claude-plugin%2Fplugin.json&query=%24.version&label=version&color=blue)](.claude-plugin/plugin.json)
[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-D97757?logo=claude&logoColor=white)](https://claude.com/claude-code)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](../../LICENSE)
[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-EA4AAA?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/Eigenwise)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-support-FF5E5B?logo=kofi&logoColor=white)](https://ko-fi.com/eigenwise)
[![Discord](https://img.shields.io/badge/chat-on_discord-7289DA?logo=discord&logoColor=white)](https://discord.gg/J3W9b5AZJR)

*Part of the [eigenwise-toolshed](../../README.md), a small marketplace of Claude Code plugins by [Eigenwise](https://eigenwise.io).*

A self-maintaining **codebase map** for Claude Code: small Markdown docs under
`.claude/.codebase-info/` that describe how your project is built, re-injected into context on every
prompt so Claude starts each session already knowing the layout instead of grepping around blind.

You install one plugin, run one skill, and get a map generated from your actual code: a compact
`INDEX.md` hub plus the detailed docs your project warrants. A bundled hook keeps that hub in front of
Claude on every prompt, and a second skill keeps the docs current as the code changes. So every
session starts oriented, and **the map maintains itself** instead of going stale the week after you
write it.

## Where it came from: live-rules

codebase-mapper grew out of a smaller plugin, [live-rules](../live-rules), and that foundation is worth
seeing, because you can rebuild a basic version of codebase-mapper with live-rules by hand.

live-rules is built on one trick: a `UserPromptSubmit` hook that reads a Markdown file and injects it
into Claude's context **every time you submit a prompt**. Because it runs every turn, the file stays in
front of the model instead of getting buried as the session grows. One of its fields, `include:`,
appends the **live contents** of another file under a rule, read fresh on every injection. So a rule
can carry whatever a separate file currently says, not just the text you typed into it.

## The by-hand version

Put those two pieces together and you have a codebase map with nothing but live-rules installed. It
takes:

1. Some Markdown docs describing your project, committed in the repo (say under
   `.claude/.codebase-info/`, with an `INDEX.md` as the hub).
2. One live-rules rule that loads them on every prompt:

```markdown
---
description: Codebase map protocol
include: .claude/.codebase-info/INDEX.md
---
This repo has a maintained codebase map. Before starting any task, say which
doc(s) from .claude/.codebase-info/ you will read, and read them first. After
changing code, review whether the map needs updating.
```

That single rule is a self-loading codebase map. The body tells Claude to consult and update the map,
and `include:` re-injects the hub doc on every prompt so it stays salient deep into a long session.
Write the docs once, add the rule, commit, and the map works with nothing else installed. This is the
worked example in the [live-rules README](../live-rules#including-a-live-file), and **your own repo can
be the example.**

## Why install the plugin

The by-hand version works well for one repo you are happy to tend yourself. It does not scale across
repos, though: you still write the docs in the first place, and update them as the code changes, in
every project, forever. That is the work codebase-mapper takes over. It is the same hook idea, plus the
skills that build and maintain the map for you:

- **Generates the map** from your actual code, picking the docs the project warrants (the
  `map-codebase` skill).
- **Keeps it current** as the code changes, adding and pruning docs as the project grows (the
  `update-codebase-map` skill).
- **Loads it on every prompt** through its own bundled hook, so you do not need live-rules installed at
  all.

So the choice is about reuse. For one repo where you will maintain the docs yourself, use live-rules
and the rule above. When you want the map generated for you, kept in sync automatically, and the same
setup repeatable across every project, install codebase-mapper.

The [haiku-jar example](../../examples/haiku-jar) is a small project with a full generated map
committed beside it, so you can see what the docs look like in practice.

## Install

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install codebase-mapper@eigenwise-toolshed
```

## Skills

| Skill | Invoke with | Does |
|-------|-------------|------|
| `map-codebase` | "map the codebase", "onboard me", or `/codebase-mapper:map-codebase` | Builds the full atomic map |
| `update-codebase-map` | "update the codebase map", or `/codebase-mapper:update-codebase-map` | Refreshes only the docs affected by recent changes |

Works on any stack, and on both existing and brand-new (greenfield) projects.

## What it creates

A set of atomic docs in `.claude/.codebase-info/`, and only the ones your project actually warrants.
The usual set is `INDEX.md`, `architecture.md`, `tech-landscape.md`, `directory-structure.md`,
`entry-points.md`, `modules.md`, `communication.md`, `database.md`, `dependencies.md`, `patterns.md`,
`coding-style.md`, `docker.md`, and `onboarding.md`. A project with no database or containers gets no
`database.md` or `docker.md`, and a project with a major aspect none of those cover gets a doc of its
own (say `ml-pipeline.md`). There is also a `.map-state.json` the update skill uses to detect what
changed since the last map.

`INDEX.md` is the compact hub that gets injected every prompt; the detailed docs are read on demand.

## Auto-loading

A bundled, Node-based `UserPromptSubmit` hook re-injects `INDEX.md` on every prompt when a map exists,
so it stays salient deep into a long session and Claude keeps consulting and updating it as you work.
It is silent in projects that have no map, and it never touches your `CLAUDE.md`.

Commit `.claude/.codebase-info/` so the whole team and every future session share the map.

## Clean up

- Docs: delete `.claude/.codebase-info/`.
- Plugin: `/plugin uninstall codebase-mapper@eigenwise-toolshed`.

## Support

codebase-mapper is free and MIT-licensed. If it saves you time, [a coffee](https://ko-fi.com/eigenwise) or [a GitHub sponsorship](https://github.com/sponsors/Eigenwise) genuinely helps me keep building and maintaining these tools.

| Ko-fi | GitHub Sponsors |
|:-----:|:---------------:|
| <a href="https://ko-fi.com/eigenwise"><img height="32" alt="Support me on Ko-fi" src="https://ko-fi.com/img/githubbutton_sm.svg"></a> | <a href="https://github.com/sponsors/Eigenwise"><img height="32" alt="Sponsor on GitHub" src="https://img.shields.io/badge/Sponsor-EA4AAA?style=for-the-badge&logo=githubsponsors&logoColor=white"></a> |

## License

MIT © Eigenwise
