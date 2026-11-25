# Quality Gate: out of v2 until it measures many languages out of the box

2026-11-22

**Asked:** complexity and reuse signals beside the work, for any project.

**Evidence:** the plugin measured JavaScript and TypeScript only, and only where the project had a `typescript` package in its own `node_modules` and a git repository with at least one commit. Everywhere else its band said `not measured`. A blind review the same day reproduced three false signals on top of that: an agent's edit in its own worktree reported against the main checkout, a function moved to another file reported as removed but still called, and `not measured` shown on every editing turn in a project it could not measure. The work it was meant for is in many languages, so it covered almost none of it.

**Decision (2026-11-22):** a quality plugin that can't cover a wide range of languages out of the box isn't worth having. The plugin (`plugins/quality-gate`) is out of the tree and out of the marketplace file. Outfit does not offer it. The upgrade treats the older version's plugin of that name as having no v2 counterpart.

**What would bring it back:** measuring a wide range of languages out of the box, with nothing for the person to install per language. One language family is not enough.

**What stays:** nothing depends on it. The state key `quality-gate.signals` is gone with it.
