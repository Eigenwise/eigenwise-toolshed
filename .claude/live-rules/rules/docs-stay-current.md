---
description: Prose docs stay current with the code
globs: ["plugins/*/**", "docs/src/content/docs/**"]
---
- A change to any skill, hook, CLI/MCP surface, setup flow, or config needs its affected prose page under `docs/src/content/docs/` updated in the same change, or a linked `docs-writing` ticket filed before the story closes.
- Never hand-edit `docs/src/content/docs/reference/`; `docs/scripts/generate-reference.mjs` owns it. Fix the generator or the source manifest/skill instead.
- Before calling docs-affecting work done, verify the prose still matches: correct paths, commands, model/plugin names, and behavior. Run `npm --prefix docs run check`.
