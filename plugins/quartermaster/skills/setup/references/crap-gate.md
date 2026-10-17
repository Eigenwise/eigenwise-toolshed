# CRAP gate

CRAP means Change Risk Anti-Patterns, from Alberto Savoia and Bob Evans' 2007 paper. It gives
one number to a function's branching complexity and test coverage:

```text
crap = cc^2 * (1 - coverage)^3 + cc
```

`cc` is cyclomatic complexity. A fully tested function scores its complexity. An untested function
scores roughly its complexity squared. The classic CRAP ceiling is 30. The gate uses 6,
which keeps every function either small or tested.

## What the gate is not

The gate is an on-demand command, and optionally a CI step. Quartermaster never writes a
UserPromptSubmit, Stop, or PreToolUse hook that blocks a turn on a quality receipt, and a proposal
never includes one. Mandatory recurring audits and pre-edit quality blocking are outside Quartermaster's
role. A project found with such a hook gets a one-line removal recommendation in the resupply report,
naming the exact settings path (for example `.claude/settings.local.json`). The standard stays a
written rule the agent follows, not a hook that stops every turn.

Scoring compares the session's own changes against the merge base. Files that arrived through a
merge, rebase, or pull are other people's work and are never demanded.

## Threshold policy

This gate is opt-in. Approval creates the project config and live rule; a project without them
runs its tests and continues. The gate is the only place the threshold lives. Setup, resupply,
executors and orchestrators discover it rather than copying a number into their instructions.

The threshold is fixed at 6, and 6 fails. The gate compares against the configured base revision and
checks only functions the change added or modified. Untouched legacy functions, including functions in
a changed file, never fail or appear in the failure list. A changed function below 6 passes even when
its prior score was lower. Block only on new complexity the change introduced: a function that is new
since the base, or whose cyclomatic complexity rose, must score below 6; a legacy function the change
only passed through (complexity equal or lower than at the base) is reported with its number as
informational and is never a refactor demand.

## Who scores

Quartermaster sets the gate up; it does not score. The [quality-gate](https://github.com/Eigenwise/eigenwise-toolshed/tree/main/plugins/quality-gate)
plugin owns complexity, coverage and the CRAP verdict, and its README covers how each language is
measured. Propose installing it with `/plugin install quality-gate@eigenwise-toolshed` when the project
does not have it yet. `quartermaster crap` is retired: it runs the installed quality-gate with the same
arguments, and without quality-gate it only prints that install command and exits 2.

Complexity 6 or more fails at any coverage, because CRAP is never below `cc`: split the function, more
tests cannot fix it. `--cc-only` checks just that floor without running coverage; it cannot prove a full pass.

The gate exits 0 on a pass, 1 when a new or raised function scores 6 or more, and 2 when a prerequisite
or measurement is missing. Exit 2 also covers a missing LCOV file, a configured coverage command that
fails, or an unverified function row; it is never a pass.

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

Create `.claude/quality-gate/crap.json` (quality-gate still reads an older `.claude/quartermaster/crap.json`
and warns to move it). Every key is optional and command-line flags override it.

```json
{
  "coverageCommand": "npx c8 --reporter=lcov npm test",
  "sources": ["src"],
  "exclude": ["**/*.test.*"],
  "base": "main"
}
```

The defaults are `coverage/lcov.info`, sources `.`, no exclusions, threshold 6, the repository's
`develop`, `main`, or `master` branch as the base, and no coverage command. `base` selects the revision
used to identify changed functions. Without a coverage command, set `lcov` to the file the stack's
recipe writes.

The gate sets `QUALITY_GATE_COVERAGE_DIR` (and the older `QUARTERMASTER_COVERAGE_DIR`) to a fresh empty
directory for each run. A coverage command that writes `lcov.info` there keeps concurrent runs on one
checkout from reading each other's coverage, for example
`c8 --reporter=lcov --reports-dir "$QUALITY_GATE_COVERAGE_DIR" npm test`. `$VAR`, `${VAR}` and `%VAR%`
in the command are expanded before it runs, so the same command works on Windows. That report wins over
a configured `lcov`, which is only a fallback. A coverage command that exits 0 but writes neither that
file nor a fresh fallback exits 2 instead of scoring stale coverage.

The gate measures the git toplevel of the directory it runs in, so a per-ticket linked worktree is
measured in place. Never write `--project` with a hard-coded absolute path into a live rule or any other
file that outlives this setup session: a worktree that runs it later would measure another checkout.
Run it with:

```text
node "<quality-gate plugin root>/bin/quality-gate.js" crap
```

Use this live rule after the command has passed:

```markdown
---
description: Keep changed code within the CRAP ceiling
priority: 85
---
Before calling a change done, run `node "<quality-gate plugin root>/bin/quality-gate.js" crap`.
Use the gate's threshold and report per-function rows honestly; unmeasured bodies stay unmeasured, no averages. Untouched legacy functions are out of scope. Block only on new complexity the change introduced; a touched legacy function whose complexity did not rise is reported with its number as informational, never as a failure.
Exit 2 means a prerequisite or measurement is missing. Follow the printed install or measurement hint, then rerun the gate. Do not skip it.
```
