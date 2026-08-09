# Playbook

Playbook gives Claude practical guidance for choosing models, splitting work, verifying changes, and learning from repeated friction.

[Setup guide](https://eigenwise.github.io/eigenwise-toolshed/getting-started/playbook/) · [Generated reference](https://eigenwise.github.io/eigenwise-toolshed/reference/playbook/) · [Toolshed marketplace](../../README.md)

## Install

Run these in Claude Code:

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install playbook@eigenwise-toolshed --scope project
```

Then describe the task in front of you. For example:

> I need to change several independent areas. Should we split this across agents?

Claude recommends whether parallel work is worth it and explains the split. If one owner is the better choice, it says so.

## Ask for help

Use plain-language requests:

- "Which model fits this task, and why?"
- "Give me a narrow verification check for this change, then the final full check."
- "Should I fan this work out, or keep one owner?"
- "Run a retro on this session and show me the fixes before applying anything."
- "What do I keep redoing across recent sessions?"

The session retro uses the current conversation. The cross-session retro looks for repeated work across recent sessions and subagents, then suggests the smallest durable fix. Claude shows proposed workspace changes before applying them.

## If the result is not useful

- **The advice misses your constraint:** Say what matters, such as keeping one owner or minimizing test time.
- **Verification is too broad:** Ask for a file-scoped check first and one full check at the end.
- **A retro needs wider history:** Ask for a broader cross-session review and name the projects or period that matter.
- **You want reminders:** Ask Claude to enable Playbook's project reminder. It stays off unless you turn it on.

## License

MIT
