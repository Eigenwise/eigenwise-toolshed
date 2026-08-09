---
title: Playbook
description: Choose a good way to work with Claude Code, then turn repeated friction into a lasting fix.
---

Playbook gives Claude practical guidance for choosing models, splitting work, verifying changes, and learning from repeated friction. You ask for the outcome you want; Claude chooses the bundled practice that fits.

## Install

Run these in Claude Code:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install playbook@eigenwise-toolshed --scope project
```

Then ask Claude for help with the task in front of you. For example:

> I need to change several independent areas. Should we split this across agents?

Claude can recommend whether parallel work is worth it and explain the split. If the work is better handled in one session, it will say so.

## Daily use

Use plain-language requests such as:

- "Which model fits this task, and why?"
- "Give me a narrow verification check for this change, then the final full check."
- "Should I fan this work out, or keep one owner?"
- "Run a retro on this session and show me the fixes before applying anything."
- "What do I keep redoing across recent sessions?"

Playbook covers model selection, parallel work, verification discipline, an in-context session retro, and a cross-session transcript retro. Claude applies approved workspace changes through the tool that owns them, rather than silently changing your setup.

The two retro requests answer different questions. A session retro uses what is in the current conversation. A cross-session retro looks for repeated work across recent sessions and subagents, then suggests the smallest durable fix.

## If the result is not useful

- **Claude chose the wrong practice:** Say what you want to achieve and what constraint matters, such as keeping one owner or minimizing test time.
- **The verification advice is too broad:** Ask for a file-scoped check first and a single full check at the end.
- **A retro missed older or other-project patterns:** Ask Claude for a broader cross-session retro and name the projects or time range that matter.
- **You want periodic reminders:** Ask Claude to enable Playbook's project reminder. It stays off unless you turn it on.

See the generated [Playbook reference](/reference/playbook/) for the agent-facing skills and CLI details.
