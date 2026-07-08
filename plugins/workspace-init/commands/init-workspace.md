---
description: Set up a complete Claude Code workspace for this project (interview, .claude/ files, map, verify)
---

Set up a Claude Code workspace for the current project by running the **init-workspace** skill.

Invoke the `init-workspace` skill now and follow it end to end: assess whether this is a new or
existing project and whether it's a codebase, interview me for what I can't infer, write the
pre-reload files (`.claude/settings.json`, `.claude/live-rules.md`, structure notes, optionally
`CLAUDE.md` via `/init`), then pause at the reload boundary so I can run `/reload-plugins`. After I
reload, continue: build the codebase map, bring up the sidequest board, and verify each hook is
actually firing before calling it done.

If the user passed any arguments, treat them as context for the interview: $ARGUMENTS
