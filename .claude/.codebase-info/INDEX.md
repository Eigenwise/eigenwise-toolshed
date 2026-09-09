# Eigenwise Toolshed codebase map

Last Updated: 2026-09-09

Toolshed is a public Claude Code plugin marketplace. It ships six published plugins, with Sidequest as the largest runtime system and its stable executor roster bundled in the plugin package, plus shared test support, docs, examples, and release automation. The current gateway plugin is Model Gateway. `plugins/whittle/` is an unregistered optional style-mode core, not a published plugin or marketplace entry. `sandbox/windows/` is a maintainer-only, gitignored Windows Sandbox clean-room harness — not published, not linked from docs.

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
