# Coding style

Last Updated: 2026-08-10

- Match the surrounding JavaScript or TypeScript style. Sidequest source is TypeScript with strict checking and no emitted typecheck output; other plugin hooks are JavaScript.
- Keep public behavior at the shared store or named module boundary, then make CLI/MCP/dashboard adapters thin.
- Codegraph uses strict TypeScript with explicit graph model types, file-owned facts, normalized project-relative paths, typed runtime acquisition boundaries, and provider-specific extraction. Pyright internals stay isolated behind `src/lib/extractors/python/pyright-adapter.ts`.
- Use explicit file paths and bounded reads in maintainer scripts. Do not include secrets, local state, caches, or generated output in docs.
- Keep hooks small and event-specific. Register them in `hooks/hooks.json` and test Windows subprocess behavior with `plugins/test-support/windows-hide.js` where relevant.
- Treat generated reference docs as outputs. User-facing behavior changes require prose docs or a linked docs-writing ticket, as required by `CLAUDE.md`.
- Prefer names that express the operation and preserve existing error handling and validation patterns. Comments should explain a constraint or reason, not restate code.
- PowerShell sandbox scripts (`sandbox/windows/`, gitignored, maintainer-only) should keep destructive host actions out of the guest flow, preserve read-only mapping, and remain covered by `sandbox/windows/Test-ToolshedSandbox.ps1`.
