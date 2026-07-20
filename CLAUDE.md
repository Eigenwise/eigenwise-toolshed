# Eigenwise Toolshed — project rules

## Documentation stays current, and an agent owns that

The docs site (https://eigenwise.github.io/eigenwise-toolshed/, source under `docs/`) has two kinds of pages, with different update rules:

1. **Generated pages** (`docs/src/content/docs/reference/`): built by `docs/scripts/generate-reference.mjs` from plugin manifests, SKILL.md frontmatter, hooks.json, and the marketplace file. NEVER hand-edit these — they regenerate on every docs deploy, and the deploy workflow triggers on plugin manifest/skill/hook changes, so they cannot drift. If a generated page is wrong, fix the generator or the source manifest.

2. **Prose pages** (getting started, setup guides, observability, architecture): these are maintained BY THE AI AGENT working the change, as part of the change. The rule: any ticket that alters user-facing behavior — a new or renamed skill, a changed setup flow, new config, a new dashboard section, changed CLI surface — includes updating the affected prose page(s) under `docs/src/content/docs/` in the same story, or files a linked `docs-writing` ticket on the board before the ship closes. A user-facing change whose docs ticket doesn't exist is not done.

When shipping (orchestrator publish flow), the integration checklist includes: "does this change what a user sees or does? → prose docs updated or docs ticket filed."

## Screenshots

Documentation screenshots come ONLY from the committed pipeline (`docs/screenshots/`, `npm run screenshots`), which renders isolated, synthetically-seeded instances. Never screenshot live boards or dashboards for docs — real project names, session ids, and costs must never appear in committed imagery. Ad-hoc verification captures are gitignored (`/*.png`, `.playwright-mcp/`); keep them out of commits.
