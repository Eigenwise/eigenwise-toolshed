# 🧰 eigenwise-toolshed

[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin_marketplace-D97757?logo=claude&logoColor=white)](https://claude.com/claude-code)
[![Docs](https://img.shields.io/badge/docs-online-CB7D32)](https://eigenwise.github.io/eigenwise-toolshed/)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](./LICENSE)
[![Last commit](https://img.shields.io/github/last-commit/Eigenwise/eigenwise-toolshed)](https://github.com/Eigenwise/eigenwise-toolshed/commits/main)
[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-EA4AAA?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/Eigenwise)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-support-FF5E5B?logo=kofi&logoColor=white)](https://ko-fi.com/eigenwise)
[![Discord](https://img.shields.io/badge/chat-on_discord-7289DA?logo=discord&logoColor=white)](https://discord.gg/J3W9b5AZJR)
[![GitHub stars](https://img.shields.io/github/stars/Eigenwise/eigenwise-toolshed?style=social)](https://github.com/Eigenwise/eigenwise-toolshed/stargazers)

A small, growing marketplace of [Claude Code](https://claude.com/claude-code) plugins by [Eigenwise](https://eigenwise.io).

## 📖 Read the docs first. Really.

Nobody reads the docs for a plugin. Fair enough, most plugins are one command
and a config key. These are not that.

Sidequest sends your work to different models and runs them in worktrees.
Workbench writes config into your projects. Model Gateway puts other providers
in your `/model` picker. Live Rules injects text into Claude's context on every
prompt. Install these blind and you WILL see behavior you didn't ask for, with
no idea which plugin did it.

Twenty minutes up front saves you that.

**[Read the Eigenwise Toolshed documentation](https://eigenwise.github.io/eigenwise-toolshed/)**

Start with [getting started](https://eigenwise.github.io/eigenwise-toolshed/getting-started/), then the page for whichever plugin you're installing: [Workbench](https://eigenwise.github.io/eigenwise-toolshed/getting-started/workbench/), [Sidequest](https://eigenwise.github.io/eigenwise-toolshed/getting-started/sidequest/), or the [plugin reference](https://eigenwise.github.io/eigenwise-toolshed/reference/) for every skill, hook, and command.

This README is a signpost. The guides are over there.

> Sharp little tools for Claude Code, kept in one shed. 🛠️

## Plugins

| Plugin | What it does |
|--------|--------------|
| [**workbench**](https://eigenwise.github.io/eigenwise-toolshed/getting-started/workbench/) | A user-scope install and the shed's caretaker: Toolshed updates, health checks, and the freshness guard. Use `/update-toolshed` and `/workbench-doctor`. |
| [**quartermaster**](https://eigenwise.github.io/eigenwise-toolshed/getting-started/quartermaster/) | Outfits your workspaces and keeps them earning their keep. `/quartermaster:setup` sets up a project (Toolshed core, stack plugins, rules, permissions) grounded in your actual session history; `/quartermaster:retro` mines recent transcripts for friction and proposes fixes one at a time, then reports next retro whether they worked. |
| [**observability**](https://eigenwise.github.io/eigenwise-toolshed/observability/) | Local, metadata-only telemetry: a loopback observer writing to SQLite on your machine, an optional statusline for live context and usage, and an OpenTelemetry Collector that can forward redacted signals to Grafana. Off until you opt a repository in. |
| [**model-gateway**](https://eigenwise.github.io/eigenwise-toolshed/getting-started/model-gateway/) | Puts ChatGPT/Codex and Grok subscription models in Claude Code's `/model` picker through a local gateway. |
| [**sidequest**](https://eigenwise.github.io/eigenwise-toolshed/getting-started/sidequest/) | The Toolshed's core work board and board-first orchestration loop. Tickets are classified into categories that route each one to a concrete model and reasoning effort, then dispatched to token-gated executors. Side issues you mention mid-task get captured on the spot, and a live, self-hosted Kanban dashboard spans every project you work in. |
| [**codebase-mapper**](https://eigenwise.github.io/eigenwise-toolshed/getting-started/codebase-mapper/) | Keeps a small, self-updating map of your codebase and loads it into every Claude session, so Claude already knows how your project is built when you start working. |
| [**live-rules**](https://eigenwise.github.io/eigenwise-toolshed/getting-started/live-rules/) | Inject your own rules into Claude's context the moment they apply: global rules on every prompt, file-type and directory rules right before an edit, keyword rules when your prompt matches. Edit a rule, it applies on the next prompt. |

*More tools will move into the shed over time.*

## Start here

Use this path for a first install:

1. Add the marketplace:
   ```text
   /plugin marketplace add Eigenwise/eigenwise-toolshed
   ```
2. Install Workbench and Quartermaster at user scope:
   ```text
   /plugin install workbench@eigenwise-toolshed --scope user
   /plugin install quartermaster@eigenwise-toolshed --scope user
   ```
3. Reload the plugins:
   ```text
   /reload-plugins
   ```
4. In any project, run `/quartermaster:setup` or ask **"set up a Claude workspace here"**. It mines your session history, interviews you, then installs and configures every other plugin for that project. You do not need to install them by hand.

| Plugin scope | Use it for |
|--------------|------------|
| **Workbench: user** | It keeps every workspace fresh and healthy. A second project-scoped copy loads its hooks twice. |
| **Quartermaster: user** | Its session tallies, retros, and decision ledger span every project. |
| **Model Gateway: user, required** | Its wiring is global-only and writes `~/.claude/settings.json`. Its keepalive hook must be live in every project and every executor worktree. There is no project-scoped wiring anymore. |
| **Everything else: project** | Sidequest, codebase-mapper, and live-rules keep their config with the repo. `/quartermaster:setup` installs them for you. |

<details>
<summary>Installing by hand instead</summary>

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install workbench@eigenwise-toolshed --scope user
/plugin install quartermaster@eigenwise-toolshed --scope user
/plugin install model-gateway@eigenwise-toolshed --scope user
/plugin install sidequest@eigenwise-toolshed
/plugin install codebase-mapper@eigenwise-toolshed
/plugin install live-rules@eigenwise-toolshed
```

Then run `/reload-plugins` (or restart Claude Code). The marketplace is public, so there is no auth step.
</details>

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

## Why sidequest?

You're mid-task and you toss out a stray issue: *"oh, and the checkout throws on Safari."* Normally
that either derails what Claude is doing or gets forgotten three messages later. sidequest does
neither:

- The Sidequest skill tells Claude to file a separate issue directly as a ticket without stopping the work in progress.
- **Pasted images become attachments.** Paste a screenshot with your message and it's copied into the
  ticket (as real bytes, so it survives Claude Code's ephemeral image cache) and shown on the card.
- Ask *"show me the dashboard"* (or run `/sidequest:board`) and a **live, self-hosted Kanban board**
  opens in your browser. It polls, so new tickets appear and animate in on their own; drag cards
  between To do / Doing / Done, edit, filter, and search.
- When Claude changes the board while you're heads-down elsewhere, you get a **desktop notification**
  and an **unread badge** on that project in the sidebar — but only for Claude's changes, never your
  own dashboard edits.
- Claude (or several agents at once) can **work** the board, not just fill it: a ticket is **claimed
  atomically** before anyone touches it, so two agents never do the same task — it's safe to point
  several sessions at one board.
- Tickets carry **comment threads** — Claude leaves a **question** when it needs your input (and you
  get pinged) and waits for your reply — and **link into dependencies** (`blocks` / `depends-on`), so a
  blocked ticket is shown as blocked and skipped by "grab the next task" until its blocker is done.
- Because claiming is atomic, Claude **fans out over independent ready tickets** — one subagent per
  ticket, in parallel — instead of grinding through them one at a time. And finished work **archives**
  out of the way (a quiet, restorable side view) so the board stays about what's left.
- A persistent **notification inbox** (the bell) keeps every question, comment, and status change
  Claude raised while you were away — read it whenever, it survives a reload or a closed tab. Set a
  **reminder** on any ticket (a preset or a custom time) to get pinged later, and hand a ticket a
  persistent **assignee** — yourself or an agent — filterable right on the board.
- **One board for every project.** Tickets are stored centrally under `~/.claude/sidequest` (keyed by
  project path, never inside your repos), so a single dashboard covers every folder you work in at
  once. The server binds to `127.0.0.1` only — nothing leaves your machine.

Manage it all from chat ("make a ticket for X", "close SQ-3", "what's open") or the bundled CLI. The
[plugin README](./plugins/sidequest) is the full userguide.

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
