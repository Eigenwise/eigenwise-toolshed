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

For a new project, set `max` to 6 and apply it to every function. For an existing project, set
`ratchet` to the default branch and keep the ceiling for new functions. The gate reports the current
number of functions at or above the ceiling, including how many predate the branch, so the user can
choose a different ceiling with real numbers in front of them.

lizard names every arrow function or closure it cannot attribute to a declaration `(anonymous)`. A
file built entirely from these (a large React component, for example) can have dozens of them, so the
gate matches each one to its baseline copy by its exact source text first, then by its position
relative to the nearest named function, instead of by name and position alone, which broke the moment
an unrelated edit shifted where a function sat in the file. When no anonymous function in a changed
file finds a stable match, the gate prints `<file>: ambiguous match` and judges the whole file instead
of the single function: it only fails when the file's own worst complexity or count of ceiling
breaches got worse than the baseline. A function at or under its matched baseline's complexity never
counts as a new offender.

## Prerequisite

Quartermaster needs [lizard](https://github.com/terryyin/lizard) to measure complexity. It never
installs lizard. If it is missing, the command exits 2 and prints this hint:

```text
uv tool install lizard
pipx install lizard
pip install lizard
```

Exit 2 also covers a missing LCOV file or a configured coverage command that fails. Fix the printed
problem, then run the gate again.

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
  "max": 6,
  "ratchet": "main"
}
```

The defaults are `coverage/lcov.info`, sources `.` , no exclusions, `max` 6, no ratchet, and no
coverage command. Use `--max`, `--ratchet`, `--lcov`, `--complexity`, or `--coverage-command` for a
one-off override. `--project` only names the project for config and ratchet lookup, not the tree the
gate measures: with no `--project`, or with cwd inside a linked worktree of the named project, it
measures cwd's own git toplevel, so a per-ticket worktree checkout is measured in place instead of the
main checkout. Never write `--project` with a hard-coded absolute path into a live rule or any other
file that outlives this setup session - a worktree that runs it later would have it point at the wrong
tree. Run it from the project root with:

```text
node "<quartermaster plugin root>/bin/quartermaster.js" crap
```

If a coverage command needs to isolate its report output for concurrent runs sharing one working tree,
have it read the `QUARTERMASTER_COVERAGE_DIR` environment variable for its reports-directory flag (for
example `c8 --reporter=lcov --reports-dir "$QUARTERMASTER_COVERAGE_DIR" <test command>`); quartermaster
sets it to a fresh per-run directory automatically.

Use this live rule after the command has passed:

```markdown
---
description: Keep changed code within the CRAP ceiling
priority: 85
---
Before calling a change done, run `node "<quartermaster plugin root>/bin/quartermaster.js" crap`.
Keep every changed or new function under the ceiling. Cover it or split it.
Exit 2 means a prerequisite is missing. Follow the printed install hint, then rerun the gate. Do not skip it.
```
