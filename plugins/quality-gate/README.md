# Quality Gate

```text
/plugin marketplace add Eigenwise/eigenwise-toolshed
/plugin install quality-gate@eigenwise-toolshed
```

The first run installs the parser; nothing to do by hand. Node 22.5+ and npm are required. Quality Gate keeps TypeScript 7 in the plugin, with a shared installation lock and a 180-second deadline. `quality-gate provision` installs only the parser, or exits 0 when it is present. Offline or missing npm exits 2 with `npm install --prefix <plugin root>` as the remedy.

Quality Gate owns AST complexity, stable function identities and per-function CRAP scoring. No config is required. Without LCOV at `coverage/lcov.info`, `crap` checks complexity only and prints a coverage setup notice. Explicit LCOV and coverage commands still require authentic measured coverage.

`--source <path>` narrows configured or default sources for one run without changing config. Repeat it for multiple files or directories, relative to the measured project root, for example `crap --project <root> --source src/changed.py --source src/other.py --cc-only`. Config exclusions still apply; selectors cannot widen configured sources.

Invalid UTF-8, Python syntax errors and lone surrogates produce an informational UNVERIFIED row for that file. Other selected files are still measured.

The CRAP report also prints informational reuse signals after scored rows, including with `--cc-only`. `DUPLICATE? name ≈ other (file:line)` means a new body shares a name (ignoring case, underscores and hyphens) with a top-level JS/TS/Python definition in another source file at HEAD. `CALLERS OPEN name: file:line` lists up to two remaining call sites outside a removed body's old file. Removal uses the existing baseline/body pairing, including deleted files within the selected scope. Tests, fixtures, vendored and generated paths are skipped. These are regex/name checks: nested definitions are missed, and a same-named call in another module can count. They never change the verdict, exit code or receipts. JSON reports put the rows under `signals`; the summary includes the reuse-signal count.

## Live measurement

The hooks module records edits and test-command results by working directory. After each turn with edits, it runs the plugin's CLI once per edited working directory to measure changed function complexity and reuse signals, then publishes the report with test pass/fail and stale status. Each CLI run has a 20-second timeout; tool calls never launch measurement. Subagent worktrees stay separate. Without coverage, it shows `quality-gate: complexity only, coverage not set up` once per session. Measurement failures leave the previous report untouched. Above the prompt, a single line stacks above other bands: `$<cost> · CC <max> <ok|SPLIT n> · tests <pass|fail|none>[ stale]`. SPLIT counts new or complexity-raised bodies at CC 6 or higher. The first unverified report adds `· coverage not set up`, then the status line keeps the reminder. The band yields to surveys and disappears with `/quality-gate off` or before the first report.

## Turn measurement and inventory

```text
quality-gate turn --json --project <root>
quality-gate turn --json --project <root> --since 2026-10-18T08:00:00Z
quality-gate inventory --project <root> --bytes 2048
```

`turn` measures staged, unstaged and untracked JS/TS/Python edits against HEAD. `--since` selects tracked and untracked files by modification time instead. It returns `{bodies, signals, unverified, lcov}`; each body has `{file, name, cc, state, verdict}`. States are `new`, `modified-raised`, `legacy-unchanged`; verdicts are `pass`, `fail`, `unverified`. Signals have `{kind, file, name, detail}` with kinds `duplicate` or `open-callers`. Coverage is never run or claimed: `unverified` is true and `lcov` is the detected default path or null.

`inventory` reuses the name-based top-level definition inventory at HEAD (JS/TS/Python, excluding tests and generated/vendor paths). Each line is `name file`; truncated output ends with `… N more`. The byte limit includes that line; budgets too small for the omission line produce no output.

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
  "pythonPolicy": "python-ast-1",
  "lcov": "coverage/lcov.info",
  "coverageCommand": "your coverage command"
}
```

Defaults: tracked JS/TS/Python files from `git ls-files`, excluding node_modules, dist, build, coverage, vendor and `**/test/fixtures/**`, `coverage/lcov.info`, no coverage command, local `develop`, `main` or `master` as the base. If none exists, or `--base HEAD` is selected, all selected bodies are scored. `--base` uses the merge base with HEAD, and only selected files that differ from it (or are untracked) are parsed, so unchanged files never cost a parse. One TypeScript parser process serves the whole run and has exited before the report returns. `--ratchet` and config `ratchet` remain accepted with a deprecation notice. `max` is accepted only as 6. Directory scans skip `.git`, `node_modules` and `.claude`; explicitly named files still work.

Each changed body is `new`, `modified-raised` (complexity increased) or `legacy-unchanged` (complexity held or fell). New and complexity-raised bodies must score strictly below 6 with measured coverage. Legacy edits with equal or lower complexity are informational LEGACY rows, with their measured numbers; they never fail the gate. Exact owned source bytes determine change, so comments and formatting count. Nested owned bodies are excluded from their parent's fingerprint. Explicit user/project rules remain authoritative. Scores are compared before display rounding. Functions unchanged at the base don't enter the scoring scope; an empty scope says `nothing to score` and why.

JS/TS `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`, `.jsx` and `.tsx` use runtime function definitions from the AST. Type aliases and interfaces aren't functions. Nested bodies own their decisions independently. PHP and Vue script sections use lizard; install it with `uv tool install lizard`, `pipx install lizard` or `pip install lizard`. PHP uses exact bytes in its bound Lizard line span; Vue uses the bound script AST's owned bytes. Overlapping Lizard spans (nested or shared-line bodies) cannot establish independent ownership and are UNVERIFIED. A row that cannot be bound to a source definition is informational-unverified. `--complexity <lizard.csv>` accepts existing rows for all Lizard languages, including Rust, Go, Kotlin, Java, C/C++, Swift, Ruby, C# and Scala. These languages can also use a local lizard run. It never supplies a JS/TS or Python score. Lizard complexity-only runs enforce the fixed threshold; LCOV coverage stays UNVERIFIED because these adapters have no executable-line inventory. Unsupported source-only changes report each extension and changed-file count and exit 2; docs-only changes still exit 0 with "nothing to score". Python uses the stdlib AST adapter described below, with no radon or pip dependency at runtime.

`--cc-only` measures the complexity floor without touching coverage. Complexity 6 or more fails at any coverage; split the function, more tests cannot help. This mode rejects explicit `--lcov` and `--coverage-command` and ignores the configured coverage command. It cannot prove a full CRAP pass.

## Python measurement policies

`lib/python/policies.json` is the supported policy enum. `--python-policy` overrides config `pythonPolicy`. The default is `python-ast-1`; no filename, project or consumer policy automatically selects another convention. The direct adapter stdin protocol is `{text, file, policy?, oracles?}` using exact original source and its project-relative POSIX filename. Node callers use `pythonDescriptors(text, file, root, policy?, oracles?)`. Unknown policies and malformed selectors are refused.

### Default: python-ast-1

Oracle qualification from source: test_* functions in test_*.py or *_test.py, Test* class methods and unittest.TestCase methods, each with an explicit reason string in the row; fixtures and setup (pytest fixtures, setUp/tearDown, conftest bodies) classified separately and never as oracles; nested classes, methods, closures and callbacks are independently owned rows that qualify only on their own merits, never by their parent; the assertion-statement surcharge is removed only on qualified oracle rows, and every decision inside an assert predicate or message is counted on every row.

The shipped `lib/python/crap_adapter.py` walks actual source with Python's stdlib `ast`. Node invokes the project's `python3` or Windows `py -3` from its root. Python 3.10 or newer is needed for match syntax. The adapter version is included in every Python JSON row and text row, with `oracleClassification` (`oracle`, `fixture-setup` or `production`), `oracleReason`, assertion count, decision count and qualified body name. Named lambda assignments include their assignment name; unnamed callbacks use `<lambda>` and a per-parent ordinal identity.

A body starts at 1. Add one for each `if`, conditional expression, `for`/`async for`, `while` and exception handler; one per short-circuit boolean operator; one per comprehension generator and filter; one per non-wildcard match case and per guard. Assertions add one except on qualified oracle bodies. Traversal still enters their predicates and messages, including f-string expressions. Nested bodies own their decisions and fingerprints, so editing only a closure doesn't raise its enclosing body's score. Decorators are preserved in source fingerprints; they do not add body decisions.

Test filename patterns qualify test functions and Test* methods; source-resolved `unittest.TestCase` bases also qualify methods outside those filenames. Import aliases for `pytest.fixture` and `unittest.TestCase` are recognized. Setup/teardown names in test modules or TestCase methods and every conftest body remain fixture/setup, retaining their assert surcharge. A Session class nested inside a test function gets production methods, not inherited oracle status.

### Opt-in: python-radon-6.0.1-oracle-1

Ordinary production, setup, fixture and helper bodies follow the inspected Radon 6.0.1 visitor decisions: loops add one plus a nonempty else; try adds its handlers plus a nonempty else; match adds its case count minus any wildcard, with no separate guard surcharge. Predicate decisions in match guards still count. Ordinary asserts add one and stop traversal of their predicates/messages, exactly as native Radon does. Qualified oracle asserts drop only that statement surcharge and retain decisions in predicates, messages, comprehensions and f-strings. Nested classes isolate their body assertions and decisions from enclosing bodies, including decorators and bases. Methods and lambdas within those classes are still discovered and scored independently. Independent nested method/closure/lambda ownership remains the shared source adapter's contract. Radon is neither installed nor executed at runtime.

Without an explicit collection, source-name qualification requires a test_* definition in test_*.py or *_test.py, or a test_* method of a source-resolved unittest.TestCase subclass. Test*/TestCase membership alone never qualifies a helper. Fixture/setup rules take precedence. These static filename/name/import rules establish no runtime collection, unshadowed symbols, human intent or assertion execution.

Config `pythonOracles`, Node option `pythonOracles` and protocol `oracles` accept an optional authoritative allowlist for this policy only:

```json
{
  "pythonPolicy": "python-radon-6.0.1-oracle-1",
  "pythonOracles": [
    { "file": "tests/test_subject.py", "name": "_assert_unchanged", "reason": "snapshot invariant oracle" },
    { "file": "tests/test_subject.py", "name": "TestSubject.test_replacement", "reason": "replacement invariant oracle" }
  ]
}
```

An absent collection uses source-name rules. A supplied empty array qualifies no oracles. A supplied collection qualifies only its exact independently owned bodies; unlisted test_* names and nested children use native ordinary semantics. Each entry must contain exactly file/name/reason as nonempty strings, with an exact relative POSIX .py path and source-qualified body name, no patterns or traversal. Duplicate/conflicting entries, missing/ambiguous body matches and attempts to select fixtures/setup are refused. The full gate also refuses entries outside its selected source scope; it never scans unrelated sources. A direct single-file packet ignores entries for other files, and validates matches for its own file. Baseline analysis restricts the same allowlist to bodies present in that baseline, allowing genuinely new selected bodies.

Every Python row includes `measurementPolicy`, concrete `oracleReason` and `oracleSelector` (the exact explicit entry, or null for source-name/ordinary rows). The top-level gate report and Git receipt carry `pythonPolicy` and a supplied `pythonOracles` collection. The adapter identity remains python-ast-1 separately from the selected measurement policy. Explicit selection establishes qualification only, never execution or coverage. Consumer adoption/settings/permissions and fresh independent exact-source acceptance remain separate authorities.

Python compiles the exact parsed source with optimization disabled to inventory executable bytecode lines, then attributes that inventory to each body's owned AST lines, excluding nested bodies. Every inventoried line needs an explicit DA record. Sibling bodies on the same executable source line are unverified because line coverage cannot separate them. Ancestor/descendant bodies with contained owned-line inventories share DA hits, with an explicit note that line execution is an upper bound for callback execution. Put those bodies on separate lines for per-function proof. Missing records, excluded statements and ambiguous multiline normalization are unverified, never guessed zero or full coverage. An explicit zero-hit DA record is measured zero. Docstrings and optimized-away statements that produce no bytecode lines do not enter the denominator; an empty inventory remains unverified. Python keeps the same hash proof, strict threshold and physical base comparison.

Use locally installed `coverage.py` (for example `pipx install coverage`) to generate LCOV with `coverage run script.py` then `coverage lcov -o <path>`. A coverageCommand can write its data file and LCOV into `QUALITY_GATE_COVERAGE_DIR`. The live regression skips with an explicit UNVERIFIED reason when coverage.py is absent; the adapter itself needs only Python.

## Upgrade to measured coverage

`--coverage-command` runs in the measured tree with a 5-minute timeout. Sources are hashed before and after; a source edit invalidates the run. `QUALITY_GATE_COVERAGE_DIR` and the compatible `QUARTERMASTER_COVERAGE_DIR` name a fresh empty report directory. Write `lcov.info` there. `$VAR`, `${VAR}` and `%VAR%` in the command are expanded from its environment before it is spawned, so one command works under cmd.exe and sh alike; an unset name stays as written. Explicit CLI `--lcov` wins over isolated output and config. Otherwise isolated output wins over config `lcov`, which is a fallback (default `coverage/lcov.info`). Without a command, the CLI path, configured path or default is read in that order. Existing fallback or explicit output must be rewritten during the command. Missing or invalid selected output stays unverified; a stale configured file never replaces fresh isolated output.

For pre-existing LCOV, supply a sibling `<lcov>.sources.json` containing SHA-256 hashes captured alongside that coverage, keyed by project-relative source path:

```json
{ "src/example.ts": "<sha256 of the scored source bytes at coverage capture>" }
```

A missing or differing hash makes coverage unverified. Generating hashes later against arbitrary old coverage does not establish provenance. Source hashes prove byte identity, not executable-line completeness or coverage exclusions. Python requires its exact-source bytecode inventory and complete DA records. JS/TS inventories each body's executable lines from the TypeScript AST: the start line of every statement the body owns (an expression-bodied arrow counts its expression), excluding nested bodies, decorators, blocks, empty statements, type aliases, interfaces and `declare` statements. Coverage is hit lines over that inventory. Every inventoried line needs a DA record (c8 and Istanbul both emit one per statement line); a missing record, sibling bodies sharing an executable line and an empty body stay UNVERIFIED. When parent identities prove ancestry and the descendant's owned lines are contained in the ancestor's (including equal inventories), each body uses its own executable lines, including shared DA hits. Every affected row includes a `coverageNote`: DA counts measure line execution, an upper bound for callback execution, rather than independent callback hits. This applies to JS/TS callbacks and Python lambdas; sibling callbacks on one line still require separate lines. Lizard adapters (PHP, Vue and the rest) have no executable-line inventory and return UNVERIFIED even when all supplied hits are positive or zero. The `measure` entry with genuine same-session V8 capture stays available for exact byte-range JS/TS coverage.

Vitest projects need their own coverage provider's LCOV output, for example through an installed matching `@vitest/coverage-v8`. Raw `NODE_V8_COVERAGE` from vite-node can contain only `evalmachine.<anonymous>` entries, which cannot identify scored sources. Missing coverage stays unverified, with the reason and complexity shown.

Exit codes: 0 for passed, nothing to score or informational-only rows; 1 for a score failure; 2 for a missing prerequisite or unverified enforced row. `--json` prints rows, hashes, class counts, verdict and receipt path. `--help` lists the flags and next actions.

## Receipts for hook consumers

Every completed Git gate run writes `.claude/quality-gate/receipts/<head-sha>.json`, replacing that HEAD's previous run atomically. Prerequisite and unverified runs also write a receipt when HEAD exists. No receipt is written outside a repository with a committed HEAD.

Schema: `gateVersion` (`crap-1`), `pythonPolicy`, optional `pythonOracles`, `project` (measured root), `base`, `head`, `files` (relative path to SHA-256 map), `rowCounts` (`new`, `modified-raised`, `legacy-unchanged`, `unverified`), `verdict`, `timestamp`, `ccOnly` and `reasons`. Verdicts are `passed`, `failed`, `unverified` or `nothing to score`. Informational-unverified rows still produce an unverified receipt, even with exit 0. A prerequisite receipt has an empty file map and its reason.

The live measurement hook publishes informational turn reports, not acceptance receipts. A receipt consumer must compare the receipt's root, HEAD and file hashes with the current tree; it must not accept `ccOnly`, `nothing to score`, failed or unverified as a full CRAP pass. The Q3 consumers report unverified receipts once per session, avoiding repeated blocking loops.

## Existing V8 measurement entry

```text
node plugins/quality-gate/bin/quality-gate.js measure --project <root> --base <revision> --coverage <V8-directory> <files...>
```

This command consumes an existing same-session V8 capture and prints JSON. It runs no tests and installs no hooks. Capture with `QUALITY_GATE_V8_CAPTURE=<empty directory>` and the canonical realpath file URL of `lib/core.mjs` in `NODE_OPTIONS=--import=<file URL>`. Children must inherit both environment values; a command-line `--import` alone does not preload children. The preload uses Node's inspector to save precise coverage and `Debugger.getScriptSource` bytes from the same session. Keep that capture unchanged. In the inspected Claude Code 2.1.295, a direct worktree-isolated Bash startup assignment `NODE_OPTIONS=--import=<url>` followed by a Node-family command is refused by the host guard, because startup code cannot be shown not to be Git. Quality Gate does not issue that refusal, an immutable URL or hash did not change it, and no shipped capture-launch command supports that exact boundary. Other contexts, capture methods and versions were not assessed. After that actual refusal, stop: the measurement stays UNVERIFIED, and do not retry, reword, split the command or route around it. Raw `NODE_V8_COVERAGE` reports lack executed-byte binding and return UNVERIFIED; hashing today's files alongside old reports does not repair them.

### Changed-hunk branch checks

`measure` keeps function coverage unchanged and also reads precise block counts for conditions in `--base` changed hunks. New and complexity-raised bodies fail when an if/else, ternary, logical short-circuit, switch arm or loop outcome never executed. Legacy bodies with equal/lowered complexity report the same evidence informationally. Untouched condition lines do not enter this check. Explicit external-new files check every condition.

Each JSON row includes `branches: [{line, text, untaken}]`. Only untaken or UNVERIFIED conditions appear. The JSON `summary` and stderr summary count branch failures, informational conditions and UNVERIFIED conditions. Add a test for the other side, or delete the dead branch, to clear a measured failure.

The preload observes child environments without changing them. If any child drops the canonical core preload or capture directory, changed conditions are conservatively named UNVERIFIED across the capture, because the missing process might have exercised them. Captures from before this observation was added also need recapture for branch evidence. Loops containing `break`, `return` or `throw` have ambiguous condition outcomes and stay named UNVERIFIED. These limits do not change function-level coverage.

### Explicit new external JavaScript

```text
node plugins/quality-gate/bin/quality-gate.js measure --project <root> --coverage <V8-directory> --new-external-file <absolute path> --new-external-file <another absolute path>
```

Repeat `--new-external-file` for each new helper outside the project. External-only measurement needs neither Git nor `--base`. Mixed repository/external measurement still requires `--base` for the repository files. Every declared external body uses an empty baseline and is enforced as `new`; repository bodies still use their base comparison. The JavaScript API is `measureFiles(files, { projectRoot, base, coverageDirectory, externalNewFiles })`, with `externalNewFiles` defaulting to `[]`.

Declarations must name normalized absolute canonical regular `.js`, `.cjs` or `.mjs` files outside the project root. Relative/traversal paths, missing files, symlink/junction/short-name/case aliases, duplicate identities and unsupported extensions are refused with the path and reason, without a passing row. External bytes are decoded as strict UTF-8 and hashed directly. BOM bytes are retained and refused because current parser offsets drift; source text is never reshaped to make a capture match. Each external row has `admission: "external-new"`, an absolute canonical `relativePath`, raw-byte `sourceHash` (SHA-256), and `evaluatorVersions` naming the resolved TypeScript version and running Node version.

Ordinary CommonJS exports, nested callbacks, object/getter/async and instance methods use the existing exact AST/runtime ranges. Static methods without an exact runtime twin stay UNVERIFIED. Patched wrappers and unsupported or ambiguous compiler maps also stay UNVERIFIED. Exact uncalled records measure zero; absent bodies and interrupted or unpreloaded child captures stay UNVERIFIED. Complexity 2 at zero coverage scores 6 and fails the strict threshold.

Function names never establish runtime ownership. Exact runtime function ranges are matched to the AST of the captured executable bytes. Direct-source text must match the scored text. Transformed text needs its own embedded single-source compiler map naming the scored file with matching `sourcesContent` and exact body/boundary correspondence. A runtime body needs exactly one AST twin with an exact closing-token end plus one of three start anchors: the exact body opening, the exact runtime declaration start after the export prefix, or an exact compiler segment joining the generated and original whole AST declaration starts. Native TypeScript return annotations can erase the body-opening mapping. CommonJS emission can also erase the export prefix, so the generated function start maps to the original AST start before export. That whole-declaration anchor must be a compiler segment at exactly the generated start, with no nearest-segment interpolation; its original coordinate must be the scored AST declaration start. The matching closing token and unique runtime twin are still required. Body-opening matching stays supported for TypeScript-only public/private/override modifiers whose declaration start is unmapped. All supported start anchors missing, ambiguous twins and later unmapped coverage boundaries stay UNVERIFIED. Re-indented logical-operator starts and finally keywords can also bind through their own AST syntax inside the unique owned runtime twin. A logical operator needs the same token kind and exact compiler-mapped first and last bytes of its right operand; finally needs its actual TryStatement keyword and exact mapped block braces. Both directions require a unique correspondence. Missing, shifted, duplicate or wrong-owner syntax stays UNVERIFIED; this never joins nearest tokens or changes owned-text denominators. names and nearby tokens never supply a fallback. Compilers re-indent the whitespace before a closing token, so a coverage block end whose last byte has no exact correspondence binds through the compiler-mapped token at that end instead, and only when that token's own byte matches the source. Missing or ambiguous correspondence is UNVERIFIED. Generated export getters and functions with duplicate names keep separate ranges; an exact recorded body with zero hits stays at zero. An absent owned runtime range stays UNVERIFIED; other sessions can supply a present exact record. Coverage intervals are clipped to each body's owned text, excluding nested functions. No proportional source/output scaling or sibling-order fallback is used. The installed tsx emits maps with null source content; those captures stay UNVERIFIED. Read-only parser probes can run without capture; a capture process needs write access to its output directory. The Toolshed repository gate uses this shared core and its existing CLI/report format.

## What the model is told

The only persona text is [`skills/quality/PERSONA.md`](skills/quality/PERSONA.md). The hooks module reads that file into the last session-scoped system-prompt section, including teammate renders. It appends the reuse inventory once at session start when the CLI succeeds. Parser provisioning starts in the background; a missing CLI or failed inventory is silently skipped.

Install with `/plugin install quality-gate --marketplace Eigenwise/eigenwise-toolshed`.

- `/quality-gate on` or `/quality-gate off` switches persona injection (on by default).
- `/quality-gate markers on` or `/quality-gate markers off` switches source shortcut comments to reply-end shortcut limits (markers on by default).
- `/quality-gate status` prints both switches on one line.

The switches persist across sessions. Organization-managed Claude Code runs prompt-compose hooks only for plugins allowed by managed settings.

Ponytail’s persona contradicts this one on the test bar and the marker. Uninstall ponytail when both are installed.

## Review

Run `/quality-gate:review` for the diff (default), `/quality-gate:review repo` for a repository audit capped at 20 findings, or `/quality-gate:review debt` for shortcut markers and the latest receipt. The skill is auto-discovered from `skills/review/SKILL.md`. It reads callers and reuse signals, consumes existing LCOV only, and never runs tests unasked. Failed measurement is reported without a table. Debt mode reads the latest receipt and a live repo measurement; if measurement cannot run, it reports stored counts/reasons without reconstructing missing per-body rows.

Example output (illustrative, complexity-only):

```text
Coverage: complexity only, no LCOV present
Body (file:line)       CC  Coverage    CRAP        State
src/cart.ts:12 total   2   UNVERIFIED  UNVERIFIED  UNVERIFIED

Must
1. What this is: total sums cart prices.
   Problem: an empty cart calls reduce without an initial value and throws.
   Fix: supply 0 as the initial value.
   If we skip it: empty-cart checkout fails.
Should: none
Nice: none
Verdict: fix empty-cart checkout before shipping.
Lean: -0 lines
Not checked: tests were not run; coverage is unavailable.
```
