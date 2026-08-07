# Eigenwise Toolshed — project rules

## Documentation stays current, and an agent owns that

Most of what this repo ships is read by agents, not by people. An orchestrator or executor mid-run never opens the docs site; it learns what is true from tool schemas, refusal messages, briefings, skill text, and live-rules. So a change has two audiences, and they are not equally expensive to get wrong.

1. **Agent-facing surfaces** (MCP tool schemas and descriptions, refusal and guidance strings, briefing text, agent/skill definitions, CLI help, live-rules): these are the contract. An agent acts on them immediately, so drift here costs a dispatch every time it is hit. Update them IN the same change, never as a follow-up ticket. If a behavior changed and the string that tells an agent about it did not, the change is not done. When a value is enumerated in code, that enum is the source of truth and every surface repeating it must be checked against it.

2. **Generated pages** (`docs/src/content/docs/reference/`): built by `docs/scripts/generate-reference.mjs` from plugin manifests, SKILL.md frontmatter, hooks.json, and the marketplace file. NEVER hand-edit these — they regenerate on every docs deploy, and the deploy workflow triggers on plugin manifest/skill/hook changes, so they cannot drift. If a generated page is wrong, fix the generator or the source manifest.

3. **Prose pages** (getting started, setup guides, observability, architecture): written for a human reading about the system, not for an agent operating it. These are maintained BY THE AI AGENT working the change: any ticket that alters observable behavior — a new or renamed skill, a changed setup flow, new config, a new dashboard section, changed CLI surface — updates the affected page(s) under `docs/src/content/docs/` in the same story, or files a linked `docs-writing` ticket on the board before the ship closes. A behavior change whose docs ticket doesn't exist is not done. Stale prose is a correctness bug, but it is not an outage; do not let it outrank a drifting agent-facing surface.

When shipping (orchestrator publish flow), the integration checklist includes: "does this change what an agent is told, or what a human reads? → agent-facing strings updated in this change, prose docs updated or docs ticket filed."

## Release guidance

Conditional release and manifest rules live in `.claude/live-rules/`. They are injected for matching manifest edits and release-related prompts.

## Screenshots

Documentation screenshots come ONLY from the committed pipeline (`docs/screenshots/`, `npm run screenshots`), which renders isolated, synthetically-seeded instances. Never screenshot live boards or dashboards for docs — real project names, session ids, and costs must never appear in committed imagery. Ad-hoc verification captures are gitignored (`/*.png`, `.playwright-mcp/`); keep them out of commits.
