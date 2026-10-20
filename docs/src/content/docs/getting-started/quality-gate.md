---
title: Quality Gate
description: Install Quality Gate once and get a quality persona, a turn-end complexity line and a measured review, with no config.
---

Quality Gate keeps new code small, reused and tested. It works the moment it is installed: no config file, no setup question.

## Install

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install quality-gate@eigenwise-toolshed
```

Node 22.5+ and npm are required. The first run installs the TypeScript parser into the plugin by itself; offline, it stops with the one `npm install --prefix <plugin root>` command to run by hand.

## What happens in the first session

- **Persona.** Claude gets a short quality brief: intent-revealing names, no needless code, reuse before writing, and a CRAP score below 6 for new and raised functions. It also sees a list of the definitions already in your project so it can reuse them. The same text reaches executors and subagents.
- **Band line.** Above the prompt, one line shows session cost, the highest function complexity this turn, and the last test result, for example `$0.42 · CC 4 ok · tests pass`. `SPLIT n` appears when `n` new or complexity-raised functions reached complexity 6 or more.
- **Turn-end measurement.** After each turn that edited code, Quality Gate measures the changed functions once. It scores measured CRAP, not a regex over the text.
- **One notice.** Without a coverage report it measures complexity only and says `quality-gate: complexity only, coverage not set up` once per session.

## Review

`/quality-gate:review` reviews your current diff. `/quality-gate:review repo` audits the repository, capped at 20 findings, and `/quality-gate:review debt` lists shortcut markers and the latest receipt. It reads callers and reuse signals, uses existing coverage only, and never runs your tests unasked.

## Switches

- `/quality-gate off` and `/quality-gate on` turn the persona off and on. On is the default.
- `/quality-gate markers off` moves shortcut notes from source comments to the end of Claude's reply. `markers on` is the default.
- `/quality-gate status` prints both.

The choices persist across sessions.

## Upgrade to measured coverage

Complexity alone catches big functions. Coverage lets the gate tell a big, well-tested function from a big, untested one. Write an LCOV report to `coverage/lcov.info` and Quality Gate picks it up. Produce it with your stack's tool:

| Stack | Command |
| --- | --- |
| JavaScript / TypeScript | `c8 --reporter=lcov npm test` |
| Python | `coverage run -m pytest && coverage lcov -o coverage/lcov.info` |
| Go | `go test -coverprofile=coverage.out ./... && gcov2lcov -infile coverage.out -outfile coverage/lcov.info` |
| Rust | `cargo llvm-cov --lcov --output-path coverage/lcov.info` |
| C / C++ | `gcovr --lcov coverage/lcov.info` |
| PHP | `vendor/bin/phpunit --coverage-clover coverage/clover.xml && vendor/bin/clover-to-lcov coverage/clover.xml -o coverage/lcov.info` |
| Ruby | `simplecov-lcov` with `single_report_path = 'coverage/lcov.info'`, then your normal test command |

Java, Kotlin and C# need a conversion step. `/quartermaster:setup` knows those recipes and can wire a coverage command into the project for you.

## If you use ponytail

Quality Gate and ponytail each inject a persona, and the two disagree on the test bar and on where a known shortcut gets recorded. Pick one. Uninstall ponytail when you install Quality Gate.

## Reference

The sections below cover the `crap` command, its configuration and its receipts.

Quality Gate scores runtime function bodies with their measured test coverage. Run its project command from an installed plugin:

```text
node plugins/quality-gate/bin/quality-gate.js crap --project <root> --base <revision>
```

The named project is the tree measured, including a linked worktree. Configure `.claude/quality-gate/crap.json` there with `sources`, `exclude`, `base`, `coverageCommand`, `lcov`, `pythonPolicy` and optional `pythonOracles`. The old `.claude/quartermaster/crap.json` still works with a migration notice.

JavaScript and TypeScript use the TypeScript AST, including JSX and TSX. Types produce no runtime functions. PHP and Vue script sections keep lizard. Rust, Go, Kotlin, Java, C/C++, Swift, Ruby, C# and Scala also accept a local lizard run or `--complexity <lizard.csv>` rows. Lizard complexity-only runs enforce the fixed threshold of 6; LCOV coverage remains UNVERIFIED without an executable-line inventory. Unsupported source-only changes exit 2 with each extension and changed-file count; docs-only changes still exit 0 with `nothing to score`. PHP compares exact bound line-span bytes; Vue compares the bound script AST's owned bytes. Overlapping Lizard spans cannot prove independent ownership for nested or shared-line bodies and stay UNVERIFIED, as do unbound rows. Python uses the versioned stdlib source adapter (python3 or Windows py -3), with independently owned nested methods, closures and callbacks. Each row names its adapter version and source-qualified oracle, fixture/setup or production classification. The default `python-ast-1` preserves its existing qualification and assert-expression convention. Explicit `--python-policy python-radon-6.0.1-oracle-1` (or config `pythonPolicy`) follows pinned native Radon 6.0.1 decisions for ordinary production/setup/fixture/helper bodies, including loop/try else and ordinary asserts that add one without traversing predicate/message expressions. Only qualified oracles drop that surcharge and traverse predicate/message/f-string decisions. Nested class bodies, decorators and bases do not charge enclosing native-policy bodies; their methods and lambdas stay independently owned. Generate Python LCOV with coverage.py. The adapter compiles the exact source to inventory executable lines, excluding nested bodies. Every inventoried line needs a DA record; explicit zero hits stay zero. Missing or excluded records, ambiguous multiline normalization and bodies sharing an executable source line stay unverified.

The opt-in policy's source-name rules require test_* definitions in test_*.py/*_test.py or test_* methods in source-resolved unittest.TestCase. Class membership alone never qualifies helpers. Optional config `pythonOracles` is an authoritative array of exact `{file, name, reason}` entries, for example `{"file":"tests/test_subject.py","name":"_assert_unchanged","reason":"snapshot invariant oracle"}`. Paths are project-relative POSIX .py filenames; names are source-qualified body names. Absent collection uses source-name rules; [] qualifies no oracles; a supplied collection qualifies only its exact bodies, with no fallback for unlisted test names or inheritance by nested children. Fixture/setup rules take precedence. Missing/ambiguous matches, out-of-scope entries, duplicate/conflicting selectors, patterns and empty reasons are refused. The direct source protocol accepts `{text, file, policy?, oracles?}` and validates its own file, without scanning other files. Rows carry measurementPolicy, a concrete oracleReason and the explicit oracleSelector or null. Reports/receipts carry pythonPolicy and a supplied pythonOracles collection. Static source names/imports or selectors prove no runtime collection, unshadowed symbol, intent, assertion execution or coverage. No Radon runtime dependency is added, and choosing a capability does not authorize consumer adoption or permission changes.

The gate enforces CRAP strictly below 6 for every new or complexity-raised owned body. Legacy edits with equal or lower complexity print informational LEGACY rows and never fail the gate. Comment-only and formatting-only edits still count as changed bodies. It compares exact owned source bytes with the base, excluding independently owned nested bodies. Untouched legacy bodies stay outside scope. New and raised bodies remain enforced, and explicit user/project rules remain authoritative. `--cc-only` checks the complexity floor without coverage. An enforced function at complexity 6 fails at any coverage, so more tests cannot make it pass. With a base, only selected files that differ from it or are untracked are parsed; `--base HEAD` scores every selected file. One TypeScript parser process serves the whole run. An empty scoring scope says `nothing to score` and gives the reason.

The CRAP report also prints informational reuse signals after scored rows, including with `--cc-only`. `DUPLICATE? name ≈ other (file:line)` means a new body shares a name (ignoring case, underscores and hyphens) with a top-level JS/TS/Python definition in another source file at HEAD. `CALLERS OPEN name: file:line` lists up to two remaining call sites outside a removed body's old file. Removal uses the existing baseline/body pairing, including deleted files within the selected scope. Tests, fixtures, vendored and generated paths are skipped. These are regex/name checks: nested definitions are missed, and a same-named call in another module can count. They never change the verdict, exit code or receipts. JSON reports put the rows under `signals`; the summary includes the reuse-signal count.

Use `coverageCommand` to capture fresh LCOV while source hashes stay fixed. It gets an empty `QUALITY_GATE_COVERAGE_DIR` (also exposed as `QUARTERMASTER_COVERAGE_DIR`) for its `lcov.info`. `$VAR`, `${VAR}` and `%VAR%` in the command are expanded before it runs, on every platform, so `--reports-dir "$QUALITY_GATE_COVERAGE_DIR"` works under Windows cmd.exe too. Explicit CLI `--lcov` overrides isolated output and config. Otherwise fresh isolated output wins over config `lcov`, which is a fallback (default `coverage/lcov.info`). Without a command, the CLI path, configured path or default is read in that order. A command must rewrite any existing explicit or fallback output it uses. Missing or invalid selected output stays unverified, without silently selecting stale coverage. Existing LCOV needs a matching `<lcov>.sources.json` SHA-256 map saved at coverage capture. Source hashes alone do not prove executable-line completeness. JS/TS rows are measured against an executable-line inventory from the TypeScript AST: the start line of each statement a body owns, excluding nested bodies, decorators and type-only declarations. Every inventoried line needs a DA record, so c8 or Istanbul LCOV works. A missing record, sibling bodies sharing an executable line, or an empty body stays UNVERIFIED. Nested JS/TS callbacks and Python lambdas can share DA hits when parent identities prove ancestry and the descendant's owned lines are contained in its ancestor's, including equal inventories. Each body is scored on its own executable lines. Every affected row states that shared DA hits measure line execution, an upper bound for callback execution, rather than independent callback hits. Lizard adapters have no such inventory and stay UNVERIFIED. JS/TS bodies can also use the `measure` entry with genuine same-session V8 capture. Raw V8 capture from vite-node does not identify source modules.

`--source <path>` narrows configured or default sources for one run without changing config. Repeat it for multiple files or directories, relative to the measured project root, for example `crap --project <root> --source src/changed.py --source src/other.py --cc-only`. Config exclusions still apply; selectors cannot widen configured sources.

Invalid UTF-8, Python syntax errors and lone surrogates produce an informational UNVERIFIED row for that file. Other selected files are still measured.

## New JavaScript helpers outside a repository

```text
node plugins/quality-gate/bin/quality-gate.js measure --project <root> --coverage <V8-directory> --new-external-file <absolute path>
```

Repeat `--new-external-file` for each new external `.js`, `.cjs` or `.mjs` helper. External-only measurement needs no Git repository or base. Repository files still require `--base`, including mixed invocations. All declared external bodies are new and enforced, with canonical absolute identities, raw-byte SHA-256 hashes and resolved Node/TypeScript evaluator versions in their rows.

Use normalized absolute realpaths outside the project root. Aliases, duplicate identities, traversal, unsupported extensions and invalid UTF-8 are refused with a reason and no passing row. BOM source is retained but refused because the current parser's offsets drift. Capture into an empty `QUALITY_GATE_V8_CAPTURE` directory with the canonical `lib/core.mjs` file URL preloaded through inherited `NODE_OPTIONS=--import=<file URL>`. Every child needs both values. Interrupted or unpreloaded children leave missing evidence, which stays UNVERIFIED.

In the inspected Claude Code 2.1.295, a direct worktree-isolated Bash startup assignment `NODE_OPTIONS=--import=<url>` followed by a Node-family command is refused by the host guard, because startup code cannot be shown not to be Git. Quality Gate does not issue that refusal, and no shipped capture-launch command supports that exact boundary. Other contexts, capture methods and versions were not assessed. If you hit that actual refusal, stop; the affected measurements stay UNVERIFIED.

Ordinary CommonJS bodies use exact captured text and AST/runtime ranges. Static methods lacking an exact twin, patched wrappers and unsupported maps stay UNVERIFIED. Compiled TypeScript needs an embedded single-source map with matching source content. Exactly one AST runtime twin must match the exact closing-token end plus one of three start anchors: the body opening, the runtime declaration start after the export prefix, or an exact compiler segment joining the generated and original whole AST declaration starts. Native TypeScript CommonJS can map the generated function start to the original AST start before the erased export prefix. That whole-declaration anchor requires a segment at exactly the generated start, with no nearest-segment interpolation. This also supports erased typed return annotations; body-start support remains for public/private/override modifiers with unmapped declaration starts. Missing or ambiguous anchors and later unmapped coverage boundaries stay UNVERIFIED. Re-indented logical-operator starts and finally keywords can also bind through their own AST syntax inside the unique owned runtime twin. A logical operator needs the same token kind and exact compiler-mapped first and last bytes of its right operand; finally needs its actual TryStatement keyword and exact mapped block braces. Both directions require a unique correspondence. Missing, shifted, duplicate or wrong-owner syntax stays UNVERIFIED; this never joins nearest tokens or changes owned-text denominators. Names, nearest tokens and sibling order never establish ownership. A coverage block that ends on re-indented whitespace before a closing brace binds through that brace's own mapping; a boundary without an exact byte match stays UNVERIFIED. Exact zero-hit bodies measure zero; absent bodies stay UNVERIFIED. Complexity 2 with zero coverage scores 6 and fails. `measure` prints JSON and exits 1 on score failure, unverified rows or a refused declaration.

Exit 0 means passed, empty scope or informational-only rows; exit 1 means a score failure; exit 2 means an unverified enforced function or missing prerequisite. `--json` includes the verdict. Git runs write hash-bound receipts under `.claude/quality-gate/receipts/<head-sha>.json`, including unverified runs. Consumers must check root, HEAD, source hashes and `ccOnly` before accepting a full pass. This command doesn't install hooks or configure your project.
