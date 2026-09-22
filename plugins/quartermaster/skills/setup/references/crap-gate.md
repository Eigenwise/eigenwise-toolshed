# CRAP gate

CRAP means Change Risk Anti-Patterns, from Alberto Savoia and Bob Evans' 2007 paper. It gives
one number to a function's branching complexity and test coverage:

```text
crap = cc^2 * (1 - coverage)^3 + cc
```

`cc` is cyclomatic complexity. A fully tested function scores its complexity. An untested function
scores roughly its complexity squared. The classic CRAP ceiling is 30. Quartermaster starts at 6,
which keeps every function either small or tested.

## Threshold policy

The threshold is fixed at 6, and 6 fails. The gate compares against the configured base revision and
checks only functions the change added or modified. Untouched legacy functions, including functions in
a changed file, never fail or appear in the failure list. A changed function below 6 passes even when
its prior score was lower.

Deciding which functions the change touched means pairing each of today's functions with its copy in
the baseline revision. Position alone cannot do that: adding one function shifts every function below
it, and names repeat inside a file, because lizard names every arrow function or closure it cannot
attribute to a declaration `(anonymous)` and two classes can each carry a `run`. So the gate pairs by
source text first, then by name and position among its namesakes, and leaves the rest unpaired.

Pairing is one-to-one. A baseline function is claimed by at most one of today's functions, source text
claims across the whole file before name and position is consulted at all, and **a function that claims
nothing is new code judged on its own number**. So an untouched over-ceiling `run` keeps passing when a
new `run` lands above it, while a byte-identical copy of an over-ceiling function is new code over the
ceiling even though its twin is untouched, and a third `run` in a file that already had two is gated on
its own number.

The source text is the line span lizard reports, with runs of whitespace collapsed, so reindenting a
function alone does not make it changed. For a nested closure in a JavaScript file that span can be
wider than the closure itself; when it picks up an unrelated edit, pairing falls back to name and
position, and the function is judged as changed.

The source-text key is file-scoped: a function moved untouched from one file to another finds no
baseline copy and answers to the ceiling like anything else new. Cover it, shrink it, or land the move
first and rerun the gate against the branch that already has it.

## Prerequisite

Quartermaster needs [lizard](https://github.com/terryyin/lizard) to measure complexity. It never
installs lizard. If it is missing, the command exits 2 and prints this hint:

```text
uv tool install lizard
pipx install lizard
pip install lizard
```

Exit 2 also covers a missing LCOV file, a configured coverage command that fails, or an unverified
measurement. A file where lizard finds zero functions despite function-like source tokens, or a changed
function without coverage data, is unverified rather than a pass. Fix the printed problem, then run the
gate again.

## Produce LCOV coverage

Pick the row for the detected stack and use its output path in `lcov`. The test command is still the
project's own command. Some stacks need a one-time formatter or converter setup before the command
can write LCOV.

| Stack | Recipe |
| --- | --- |
| JavaScript / TypeScript | `c8 --reporter=lcov <test command>` writes `coverage/lcov.info` by default. For example: `c8 --reporter=lcov npm test`. |
| Python | `coverage run -m pytest && coverage lcov -o coverage/lcov.info` |
| Go | `go test -coverprofile=coverage.out ./... && gcov2lcov -infile coverage.out -outfile coverage/lcov.info` |
| Rust | `cargo llvm-cov --lcov --output-path coverage/lcov.info` |
| Java / Kotlin | First configure JaCoCo to write `coverage/jacoco.xml`. Convert it through [jcc2c](https://github.com/cjmach/jcc2c) and LCOV's `xml2lcov`: `java -jar jcc2c.jar -i coverage/jacoco.xml -o coverage/cobertura.xml src/main/java && xml2lcov -o coverage/lcov.info coverage/cobertura.xml`. Use `src/main/kotlin` for a Kotlin-only project. |
| C / C++ | `gcovr --lcov coverage/lcov.info` |
| C# | `dotnet test --collect:"XPlat Code Coverage" -- DataCollectionRunSettings.DataCollectors.DataCollector.Configuration.Format=lcov` writes `coverage.info` below `TestResults`; point `lcov` at that generated file. |
| Ruby | Add `simplecov-lcov`, configure its single-file formatter with `single_report_path = 'coverage/lcov.info'`, then run the normal test command, such as `bundle exec rake test`. |
| PHP | `vendor/bin/phpunit --coverage-clover coverage/clover.xml && vendor/bin/clover-to-lcov coverage/clover.xml -o coverage/lcov.info`. PHPUnit writes Clover, not LCOV, so this uses [`laxit/clover-to-lcov`](https://packagist.org/packages/laxit/clover-to-lcov) for the honest conversion step. |

## Config and rule

Create `.claude/quartermaster/crap.json`. Every key is optional and command-line flags override it.

```json
{
  "coverageCommand": "npx c8 --reporter=lcov npm test",
  "lcov": "coverage/lcov.info",
  "sources": ["src"],
  "exclude": ["**/*.test.*"],
  "base": "main"
}
```

The defaults are `coverage/lcov.info`, sources `.`, no exclusions, threshold 6, the repository's
`develop`, `main`, or `master` branch as the base, and no coverage command. Use `--lcov`,
`--complexity`, or `--coverage-command` for a one-off override. `base` in the config selects the
revision used to identify changed functions. The shared parser and score implementation lives under
`scripts/quality`; Quartermaster only supplies project-specific LCOV and command wiring.

The gate measures the git toplevel of the directory it runs in, so a per-ticket linked worktree is
measured in place instead of the main checkout, and the base comparison resolves against that same
root. `--project` only names where the config is read, not the tree measured; without it the config
comes from the measured root, so a run from a subdirectory gets the same gate. Never write `--project`
with a hard-coded absolute path into a live rule or any other file that outlives this setup session:
a worktree that runs it later would read another checkout's config. Run it with:

```text
node "<quartermaster plugin root>/bin/quartermaster.js" crap
```

The gate sets `QUARTERMASTER_COVERAGE_DIR` to a fresh directory for each run. A coverage command that
writes `lcov.info` there keeps concurrent runs on one checkout from reading each other's coverage, for
example `c8 --reporter=lcov --reports-dir "$QUARTERMASTER_COVERAGE_DIR" npm test`. Leave `lcov` unset
for such a command, because an explicit `lcov` is read exactly where it points. A coverage command that
exits 0 but writes neither that file nor a fresh `coverage/lcov.info` exits 2 instead of scoring stale
coverage.

Use this live rule after the command has passed:

```markdown
---
description: Keep changed code within the CRAP ceiling
priority: 85
---
Before calling a change done, run `node "<quartermaster plugin root>/bin/quartermaster.js" crap`.
Keep every new or modified function strictly below 6. Cover it or split it. Untouched legacy functions are out of scope.
Exit 2 means a prerequisite or measurement is missing. Follow the printed install or measurement hint, then rerun the gate. Do not skip it.
```
