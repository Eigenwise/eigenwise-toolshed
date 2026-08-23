---
title: Live Rules setup
description: Add project rules that Claude Code injects when they apply.
---

Live Rules keeps project instructions in front of Claude Code when they apply to a prompt or edit. Use it for conventions, guardrails, and reminders that should follow the project instead of relying on memory.

## Install

Run these in Claude Code from the project where the rules should live:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install live-rules@eigenwise-toolshed --scope project
```

Reload plugins or start a new Claude Code session. If you use Quartermaster to set up a workspace, it can install and configure Live Rules as part of that setup.

## Add your first rule

From the project directory, tell Claude what should happen and when:

> Add a rule that runs the linter before every commit.

Claude writes the rule with the right scope. Global rules land at session start. A file, directory, or keyword rule arrives the first time it matches. After that, a rule comes back only when its text changes, so rules do not repeat on every prompt. Ask Claude to add a narrower scope when a rule should not affect the whole project.

Try the workflow by submitting another prompt or editing a matching file. Rule content changes apply on the next prompt or relevant edit, with no restart. Commit the project rules so your team gets the same guidance.

## Daily use

Tell Claude what you need:

> List and audit the live rules in this project.

> Which rules are active when you edit `src/api/client.ts`?

> Disable the strict lint rule for now.

Use `add-rule` when the instruction itself needs to change. Use `manage-rules` to list, audit, explain, enable, or disable rules. Live Rules does not edit `CLAUDE.md`.

## If something stops working

- **A rule does not appear:** ask Claude to explain which rules are active for the prompt or file you are working on. The rule may be scoped to a different trigger.
- **No rules appear at all:** check that Live Rules is enabled and that the project has its rules file, then reload plugins or restart Claude Code.
- **Rules worked earlier but stopped after installing or updating the plugin:** reload plugins or start a new session so Claude loads the current hooks.
- **A rule is malformed or two rules run together:** ask Claude to audit and repair the live rules, then commit the resulting project files.

The [generated Live Rules reference](../../reference/live-rules/) contains the agent-facing format and hook details.
