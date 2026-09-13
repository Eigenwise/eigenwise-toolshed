# Eigenwise Toolshed codebase map

Last Updated: 2026-09-13

Toolshed is a public Claude Code plugin marketplace with six registered plugins. Sidequest is the largest runtime system and bundles its stable executor roster in the plugin package. The repository also has shared test support, docs, examples, and protected-branch release automation. Model Gateway owns gateway routing. `sandbox/windows/` is a maintainer-only, gitignored Windows Sandbox clean-room setup, not published or linked from docs.

- [Architecture](architecture.md)
- [Tech landscape](tech-landscape.md)
- [Directory structure](directory-structure.md)
- [Entry points](entry-points.md)
- [Modules and plugin catalog](modules.md)
- [Patterns](patterns.md)
- [Coding style](coding-style.md)
- [Onboarding](onboarding.md)
- [Release and publishing](release-publishing.md)

## How to use and maintain this map

Read this index first, then the smallest linked document that answers the question. Paths and symbols are the source of truth. Refresh the map after structural or workflow changes with `/update-codebase-map`; regenerate documents from current files, update `Last Updated`, and replace `.map-state.json` last with hashes of the exact final bytes.
