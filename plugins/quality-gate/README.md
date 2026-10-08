# Quality Gate

Quality Gate owns AST complexity, stable function identities and per-function CRAP scoring. It uses TypeScript 7 from the scored project first, then the plugin's installed dependency. Install the plugin's dependencies with `npm install` in this directory if neither has the supported parser API.

## Project CRAP gate

```text
node plugins/quality-gate/bin/quality-gate.js crap --project <root> --base <revision>
```

`--project` selects the tree measured, including a linked worktree, independently of cwd. Without it the command uses cwd's Git root. Configuration comes from that tree's `.claude/quality-gate/crap.json`. The old `.claude/quartermaster/crap.json` is a fallback with a one-line migration notice. Every key is optional; flags override config:

```json
{
  "sources": ["src"],
  "exclude": ["**/*.test.*"],
  "base": "main",
  "lcov": "coverage/lcov.info",
  "coverageCommand": "your coverage command"
}
```

Defaults: sources `.`, no exclusions, `coverage/lcov.info`, no coverage command, local `develop`, `main` or `master` as the base. If none exists, or `--base HEAD` is selected, all selected bodies are scored. `--base` uses the merge base with HEAD. `--ratchet` and config `ratchet` remain accepted with a deprecation notice. `max` is accepted only as 6. Directory scans skip `.git`, `node_modules` and `.claude`; explicitly named files still work.

Each changed body is `new`, `modified-raised` (complexity increased) or `legacy-unchanged` (complexity held or fell). Only new and modified-raised functions must score strictly below 6. Legacy rows are informational. Scores are compared before display rounding. Functions unchanged at the base don't enter the scoring scope; an empty scope says `nothing to score` and why.

JS/TS `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`, `.jsx` and `.tsx` use runtime function definitions from the AST. Type aliases and interfaces aren't functions. Nested bodies own their decisions independently. PHP and Vue script sections use lizard; install it with `uv tool install lizard`, `pipx install lizard` or `pip install lizard`. A row that cannot be bound to a source definition is informational-unverified. `--complexity <lizard.csv>` accepts existing PHP/Vue CSV rows only; it never supplies a JS/TS score. Python currently reports `Python adapter not installed in this version`, informational-unverified with exit 0. Its versioned real-source adapter is separate work.

`--cc-only` measures the complexity floor without touching coverage. Complexity 6 or more fails at any coverage; split the function, more tests cannot help. This mode rejects explicit `--lcov` and `--coverage-command` and ignores the configured coverage command. It cannot prove a full CRAP pass.

## Same-byte coverage

`--coverage-command` runs in the measured tree with a 5-minute timeout. Sources are hashed before and after; a source edit invalidates the run. `QUALITY_GATE_COVERAGE_DIR` and the compatible `QUARTERMASTER_COVERAGE_DIR` name a fresh empty report directory. Write `lcov.info` there, leaving config `lcov` unset. An explicit LCOV path wins; otherwise isolated output wins over `coverage/lcov.info`. Existing fallback or explicit output must be rewritten during the command.

For pre-existing LCOV, supply a sibling `<lcov>.sources.json` containing SHA-256 hashes captured alongside that coverage, keyed by project-relative source path:

```json
{ "src/example.ts": "<sha256 of the scored source bytes at coverage capture>" }
```

A missing or differing hash makes coverage unverified. Generating hashes later against arbitrary old coverage does not establish provenance. LCOV line records are joined to AST spans, excluding independently owned nested body lines. Zero hits is measured zero coverage; missing executable lines are unverified.

Vitest projects need their own coverage provider's LCOV output, for example through an installed matching `@vitest/coverage-v8`. Raw `NODE_V8_COVERAGE` from vite-node can contain only `evalmachine.<anonymous>` entries, which cannot identify scored sources. Missing coverage stays unverified, with the reason and complexity shown.

Exit codes: 0 for passed, nothing to score or informational-only rows; 1 for a score failure; 2 for a missing prerequisite or unverified enforced row. `--json` prints rows, hashes, class counts, verdict and receipt path. `--help` lists the flags and next actions.

## Receipts for hook consumers

Every completed Git gate run writes `.claude/quality-gate/receipts/<head-sha>.json`, replacing that HEAD's previous run atomically. Prerequisite and unverified runs also write a receipt when HEAD exists. No receipt is written outside a repository with a committed HEAD.

Schema: `gateVersion` (`crap-1`), `project` (measured root), `base`, `head`, `files` (relative path to SHA-256 map), `rowCounts` (`new`, `modified-raised`, `legacy-unchanged`, `unverified`), `verdict`, `timestamp`, `ccOnly` and `reasons`. Verdicts are `passed`, `failed`, `unverified` or `nothing to score`. Informational-unverified rows still produce an unverified receipt, even with exit 0. A prerequisite receipt has an empty file map and its reason.

Hooks aren't installed here. A consumer must compare the receipt's root, HEAD and file hashes with the current tree; it must not accept `ccOnly`, `nothing to score`, failed or unverified as a full CRAP pass. The Q3 consumers report unverified receipts once per session, avoiding repeated blocking loops.

## Existing V8 measurement entry

```text
node plugins/quality-gate/bin/quality-gate.js measure --project <root> --base <revision> --coverage <V8-directory> <files...>
```

This command consumes existing V8 coverage and prints JSON. It runs no tests and installs no hooks. The Toolshed repository gate continues using this shared AST/V8 core and its existing CLI/report format.
