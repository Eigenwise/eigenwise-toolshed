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

## React files (.tsx and .jsx)

lizard 1.24.0, the current release, has a TSX reader that abandons an opening tag as soon as one of
its attributes is not `name="text"` or `name={expr}`. A hyphenated attribute (`data-testid`), a
valueless one (`required`), a spread (`{...props}`), even tag text holding `(`, `)`, `;` or `=` is
enough. It then re-emits the `{` of every brace attribute it had already matched, and those
unbalanced braces keep the enclosing component open to the end of the file. The component reads a
complexity nothing in it branches on, and the functions it swallowed are never gated at all.

So the gate measures `.tsx` and `.jsx` through lizard's TypeScript reader instead, by handing lizard a
byte-for-byte copy of the file under a `.ts` or `.js` name. Nothing in the source is rewritten: line
numbers, and with them coverage ranges and the ratchet's baseline pairing, still come from the real
file, and the baseline side of the ratchet is read the same way.

Every offender line for one of these files names the measurement behind it, and `--json` carries the
same `source` for every function:

```text
src/sale.tsx:27 SaleTotals cc=3 coverage=0% CRAP=12 source=lizard-typescript
```

`source=lizard-typescript` is the reader above. `source=lizard-tsx` means the file was measured by
lizard's TSX reader after all, which happens only when the gate was handed a ready-made
`--complexity` CSV or could not read the file; treat a complexity that no branch in the function
explains as this defect, not as real complexity.

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
one-off override. Run it with:

```text
node "<quartermaster plugin root>/bin/quartermaster.js" crap --project "<project>"
```

Use this live rule after the command has passed:

```markdown
---
description: Keep changed code within the CRAP ceiling
priority: 85
---
Before calling a change done, run `node "<quartermaster plugin root>/bin/quartermaster.js" crap --project "<project>"`.
Keep every changed or new function under the ceiling. Cover it or split it.
Exit 2 means a prerequisite is missing. Follow the printed install hint, then rerun the gate. Do not skip it.
```
