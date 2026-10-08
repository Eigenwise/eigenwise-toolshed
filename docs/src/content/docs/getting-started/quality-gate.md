---
title: Quality Gate
description: Run a per-project CRAP gate with AST-backed JavaScript and TypeScript scoring.
---

Quality Gate scores runtime function bodies with their measured test coverage. Run its project command from an installed plugin:

```text
node plugins/quality-gate/bin/quality-gate.js crap --project <root> --base <revision>
```

The named project is the tree measured, including a linked worktree. Configure `.claude/quality-gate/crap.json` there with `sources`, `exclude`, `base`, `coverageCommand` and `lcov`. The old `.claude/quartermaster/crap.json` still works with a migration notice.

JavaScript and TypeScript use the TypeScript AST, including JSX and TSX. Types produce no runtime functions. PHP and Vue script sections keep lizard; rows it cannot bind are informational-unverified. Python is informational-unverified until its source adapter ships.

The gate enforces CRAP strictly below 6 for new functions and functions whose complexity rose against the base. Touched legacy functions with equal or lower complexity are informational. `--cc-only` checks the complexity floor without coverage. A function at complexity 6 fails at any coverage, so more tests cannot make it pass. An empty scoring scope says `nothing to score` and gives the reason.

Use `coverageCommand` to capture fresh LCOV while source hashes stay fixed. It gets an empty `QUALITY_GATE_COVERAGE_DIR` (also exposed as `QUARTERMASTER_COVERAGE_DIR`) for its `lcov.info`. Existing LCOV needs a matching `<lcov>.sources.json` SHA-256 map saved at coverage capture. Vitest projects need their provider's LCOV; raw V8 capture from vite-node doesn't identify source modules.

Exit 0 means passed, empty scope or informational-only rows; exit 1 means a score failure; exit 2 means an unverified enforced function or missing prerequisite. `--json` includes the verdict. Git runs write hash-bound receipts under `.claude/quality-gate/receipts/<head-sha>.json`, including unverified runs. Consumers must check root, HEAD, source hashes and `ccOnly` before accepting a full pass. This command doesn't install hooks or configure your project.
