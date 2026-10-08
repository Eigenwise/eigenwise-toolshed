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

In a JavaScript-family file (`.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.jsx`), a function is changed or
new only when a changed line falls inside its span. That span is the one the gate measured after the
corrections below; `--json` gives it as `line` to `end`. A changed line is a line the change added or
edited. Where the change only deleted lines, it is the line just above the deleted ones. A function that
holds no changed line is pre-existing, however lizard read the base revision. lizard can read the same
unchanged text with different bounds on each side, for example when a `<` comparison earlier in the file
makes it read a type argument (GitHub issue #482). Such a function used to have no base copy to pair
with, and it failed as new code. Among the functions that hold a changed line, pairing with the baseline,
described next, still decides which ones count. In other languages, every function in a changed file
goes to pairing.

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
its own number. A function that holds no changed line claims its baseline copy first, so the copy git
reports as added is the one judged as new, even when it was pasted above its twin.

The source text is the line span lizard reports, with runs of whitespace collapsed, so reindenting a
function alone does not make it changed. For a nested closure in a JavaScript file that span can be
wider than the closure itself; when it picks up an unrelated edit, pairing falls back to name and
position, and the function is judged as changed.

The source-text key is file-scoped: a function moved untouched from one file to another finds no
baseline copy and answers to the ceiling like anything else new. Cover it, shrink it, or land the move
first and rerun the gate against the branch that already has it.

## Complexity 6 or more fails at any coverage

CRAP is never below cc: at full coverage the score is exactly cc. So a changed or new function with
cc 6 or more fails whatever its tests cover. When the full gate fails such a function it says so on
that line (`cc 6 or more fails at any coverage`); split the function instead of adding tests.

`--cc-only` is the fast check for that. It runs lizard only: no coverage command, no lcov. It uses the
same changed-function selection and base as the full gate and fails every changed or new function
with cc 6 or more, one line each (`cc=<n> fails at any coverage (CRAP is never below cc)`). Exit
codes match the full gate: 1 for a failure, 2 for a missing prerequisite. It rejects `--lcov` and
`--coverage-command`, and it ignores `coverageCommand` in the config. Run it while splitting a
function, then run the full gate once at the end.

## Stale local base

The default base is the first local `develop`, `main` or `master`, never `origin/<branch>`, because a
fork's origin can be stale. A local base that lags its upstream makes already-merged work read as
changed. When `git rev-list --count <base>..<base>@{upstream}` is above zero, the gate prints a
one-line warning on stderr naming how many commits the base is behind. Pass `--base <base>@{upstream}`
or fetch and fast-forward the base. The warning never fails the gate.

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
function without coverage data, is unverified rather than a pass. Only code counts as a
function-like token: the word `function`, `=>` or `name(...) {` inside a comment or inside string
or template text does not, while a template's `${...}` expression does. A file covered by a configured
`exclude` pattern is never treated as unverified, even with zero lizard rows and function-like tokens.
Fix the printed problem, then run the gate again.

lizard's JavaScript, TypeScript and TSX readers end a function at the first `)` in its parameter list.
A parameter list with parentheses of its own, such as a function-typed prop
(`onSelect: (card: Card) => void`) or a default arrow (`read = (value) => value`), makes lizard report
a span that stops inside the signature, where LCOV usually has no line data, and a complexity that
leaves out every branch in the body. The gate reads the source and widens that span to the function's
real body before it looks up coverage or compares the function with the base revision, so an edit to
its body counts as a change. It also counts the body's branches the way lizard does (`if`, `for`,
`while`, `case`, `catch`, `&&`, `||`, `??` and a ternary `?`, plus one) and scores the larger of that
count and lizard's number. A function nested in the body keeps its own row, so its branches are not
counted twice. When the gate cannot find where the body ends, it keeps lizard's span, and the function
is reported as unverified, as before.

A parameter list that holds a call (`load(path = resolve(), opts)`) is worse for a `function`, method or
constructor: lizard reports no row for it at all, and can lose plain functions after it in the same
file, so the gate would never have checked it. The gate reads each such definition from the source,
unless a lizard row of the same name starts on its line, or a row lizard calls `(anonymous)` does and is that definition's own: lizard gives that name to a function whose parameter list holds an arrow type (`work: () => T`) and ends the row inside the list, where the gate's body widening reaches the definition. A callback's `(anonymous)` row on the line, or a default arrow (`work = () => {}`, which lizard names `work`), does not stand in for it. The gate scores the definition with its own branch count. In a
file where it finds one, it also reads every other definition lizard gave no row. These rows are
labelled `source=source-scan` in the report, and they pair with the base revision the same way lizard's
rows do. A file lizard gave no row counts as measured only when every definition in it (a `function`
keyword, a `=>`, or a `name(...) {` head) lies inside one of these rows; otherwise the gate still exits
2 with "lizard reported zero functions". An arrow with a call in its parameter list keeps the row lizard
gives it.

lizard also misreads where some functions start and end, so the gate checks every JavaScript-family row
(`.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.jsx`) against the definition it stands for in the source:

- **Clamp.** A template literal nested in another one's `${...}` makes lizard run a row past the
  function's end, often to the end of the file, swallowing the functions after it (GitHub issue #471).
  The gate clamps the row to the function's real body and recounts its branches over that body alone,
  because lizard's number includes the swallowed functions' branches.
- **Widen.** lizard's TypeScript reader can end a JSX component inside its JSX (#476). When the
  function's `{` body ends after lizard's row, the gate widens the row to the real end and scores the
  larger of the two counts.
- **Restart.** For an arrow whose `=>` ends a line, lizard starts and ends the row on the body's first
  line (#477). The gate starts the row at the arrow and ends it with the arrow's body.

A row that already spans its definition keeps lizard's count, and ends where the body ends: lizard ends
a row on the line of the next token after the body, which can be the next function's signature, so
without that trim a change to that signature would count as a change to the function above it. In a
file that holds a nested template literal, or where a row was clamped, lizard has lost its place, so the
gate also reads every definition lizard gave no row, as above (`source=source-scan`). The gate trusts
its own reading only when every bracket and template literal in the file balances. JSX text such as an
apostrophe can break that, and then lizard's rows stand as reported.

The gate fails closed on what is left. A row measures the definition it starts on, and nothing nested
in it: lizard gives a nested function a row of its own, so a nested arrow lizard dropped is unmeasured
however far the parent's row reaches, and the parent's own lines are the ones outside its nested
functions. After this reconciliation, a changed or new line inside a function the source scan finds but
inside no row of that function's own exits 2 with "changed lines are unmeasured at `<file>:<line>`":
lizard misread that function, and passing the gate would pass code nothing measured. Without a base
revision every line counts as new. Rewrite what lizard cannot read, or move the code into a named
function lizard reports, then run the gate again.

One more lizard misread lands here. lizard reads a regex literal as code, so an unbalanced `(` or `{`
in one (`/\(/`, `/\$\{/`) shifts every later row in the file up a line. A row shifted onto a blank
line or the previous function's closing brace is widened back onto its signature; one shifted onto the
last line of a comment binds to no definition, and an edit to the function below it exits 2 as above.
Build such a pattern with `new RegExp('...')` instead.

## React files (.tsx and .jsx)

lizard 1.24.0, the current release, has a TSX reader that abandons an opening tag as soon as one of
its attributes is not `name="text"` or `name={expr}`. A hyphenated attribute (`data-testid`), a
valueless one (`required`), a spread (`{...props}`), even tag text holding `(`, `)`, `;` or `=` is
enough. It then re-emits the `{` of every brace attribute it had already matched, and those
unbalanced braces keep the enclosing component open to the end of the file. The component reads a
complexity nothing in it branches on, and the functions it swallowed are never gated at all.

So the gate measures `.tsx` and `.jsx` through lizard's TypeScript reader instead, by handing lizard a
byte-for-byte copy of the file under a `.ts` or `.js` name. Nothing in the source is rewritten: line
numbers, and with them coverage ranges and baseline pairing, still come from the real file. The base
revision's copy of the file is read the same way, so an untouched component pairs with its own
baseline row instead of a phantom one and is not gated as changed.

Every offender line for one of these files names the measurement behind it, and `--json` carries the
same `source` for every function:

```text
src/sale.tsx:27 SaleTotals cc=3 coverage=0% CRAP=12 source=lizard-typescript
```

`source=lizard-typescript` is the reader above. `source=lizard-tsx` means the file was measured by
lizard's TSX reader after all, which happens only when the gate was handed a ready-made
`--complexity` CSV, could not read the file, or the TypeScript reader found no function in it; treat a
complexity that no branch in the function explains as this defect, not as real complexity.

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
revision used to identify changed functions. The parser and score implementation ships inside the plugin at `lib/crap.js`; the repository's own
gate under `scripts/quality` re-exports it.

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
Use the gate's threshold and report per-function rows honestly; unmeasured bodies stay unmeasured, no averages. Untouched legacy functions are out of scope. Block only on new complexity the change introduced; a touched legacy function whose complexity did not rise is reported with its number as informational, never as a failure.
Exit 2 means a prerequisite or measurement is missing. Follow the printed install or measurement hint, then rerun the gate. Do not skip it.
```
