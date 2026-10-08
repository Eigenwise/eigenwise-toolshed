# CRAP gate for the toolshed repository

The shared AST, function identity and V8 coverage core lives in `plugins/quality-gate/lib/`. This script owns only Toolshed path selection, build-output mapping, suite capture and text reporting; the plugin also exposes a `measure` entry that consumes existing coverage and prints JSON.

`node scripts/quality/crap.mjs --base <revision>` scores every JavaScript or TypeScript function that is new or changed since `<revision>`, wherever the changed file lives: `plugins/*/lib`, `plugins/*/src`, `plugins/*/scripts`, `plugins/*/test`, `scripts/`, `docs/scripts/`. Test callbacks are function bodies too and get their own rows. Changed means the function's own text (its body minus nested functions) differs from the base function it is paired with, or it has no partner. Pairing runs parent by parent: a sibling whose own text appears exactly once on each side pairs first, and the rest pair in order between those anchors, so inserting or deleting a test leaves the untouched callbacks after it unscored. The file list is the changed range itself (`git diff --name-status`), filtered to `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`; Sidequest's built `lib/`, `bin/` and `hooks/` are skipped because `src/` is their source. A function fails at 6:

    CRAP = complexity² × (1 − coverage)³ + complexity

Coverage is V8 block coverage captured through `NODE_V8_COVERAGE` from the suites behind the changed files, projected onto each function's source span:

| changed path | suite run |
| --- | --- |
| `plugins/<name>/...` | that plugin's `test:full`, else `test`, else `node --test test/*.test.js` |
| `scripts/quality/...` | `node --test scripts/quality/*.test.mjs` |
| `scripts/release/...` | `node --test scripts/release/test/*.test.mjs` |
| `docs/scripts/...` | `node --test docs/scripts/content.test.mjs` |

`--coverage <dir>` reuses a capture instead of running the suites, `--all` prints unchanged functions too. Without `--base` the merge base with `develop` (or `main`) is used.

## Rows that are UNVERIFIED

An UNVERIFIED row fails the gate like a FAIL does, and says why:

- **no analyzer**: a changed source in another language (`.cs`, `.py`, `.sh`, `.ps1`, `.svelte`, `.tsx`, `.jsx`) prints one row for the file. The gate has nothing to measure it with; say so in the report rather than claiming a score.
- **no suite loaded this file**: the file has no coverage record at all, so no suite imported or ran it. Zero coverage from a file that did run is reported as 0% and scored; a file that never ran is a measurement gap, not a score. The usual cause is a script that is only ever spawned as a child process (`spawnSync(process.execPath, ['scripts/thing.js'])`). A child inherits `NODE_V8_COVERAGE` from its parent's environment, so it is covered as soon as the spawning test passes the environment through (`env: process.env`, or `{ ...process.env, ... }`); a test that builds a fresh `env` without it drops the capture. `verify-capture` sets the variable for its own runs the same way.
- **functions beside it do not line up**: an unnamed callback in a Sidequest `src/*.ts` file whose siblings in the built output do not match the source, so no twin can be trusted.

## TypeScript loaded through tsx

Sidequest's tests are `.ts` files run through `tsx`, which hands V8 transpiled text, so raw coverage offsets do not land in the `.ts` source. Node caches tsx's inline source map next to the coverage whenever `NODE_V8_COVERAGE` is set (`source-map-cache` in the report), and the gate maps each range back through it with `node:module`'s `SourceMap`. A map is applied only when its source is the script itself; the Sidequest build ships no map, so `src/*.ts` is paired with its `lib/*.js` output by name and position instead.

A record on the scored file itself is paired by position, never by name: it belongs to the innermost function holding its (remapped) start, and the record ending nearest that function's end wins. V8 names an assigned hook or a property arrow `""` and a constructor after its class, and a remapped start can land past the AST's (esbuild drops a lone parameter's parentheses; tsx's `__name` wrapper leaves a zero-parameter arrow no mapping segment of its own), so a name or an exact start offset would leave a callback that ran at 0%.

## Complexity convention

Complexity comes from the same TypeScript AST the runner uses to find functions (`typescript/unstable/ast`, for `.ts` and `.js` alike). A function starts at 1 and adds 1 for each:

- `if` (an `else if` is another `if`)
- loop: `for`, `for…in`, `for…of`, `while`, `do…while`
- `case` clause (`default` does not count)
- `catch` clause
- conditional expression `a ? b : c`
- `&&`, `||` and `??` operator

A nested function body is left out of the enclosing function's count: it is discovered as its own function with its own score. `switch` itself, `finally`, `?.`, `&&=`/`||=`/`??=`, `return` and `throw` do not count.

## Why not Lizard

Earlier versions took complexity from `lizard --csv` and matched rows to the AST by line. Lizard 1.24.0's TypeScript reader loses brace tracking at a template literal nested inside another template literal's `${}` substitution (`` `${claim.at ? ` since ${claim.at}` : ''}` ``). Every sibling function after that point is swallowed into one row with a wrong span and complexity, so the gate printed those functions UNVERIFIED (SQ-3091 has the evidence: 11 of 45 changed functions in one candidate). The AST count above is the authority now and this runner never calls Lizard.

Expect the number to differ from Lizard's on some functions. Lizard reads a template literal as one string, so a `||` or `? :` inside a `${}` substitution is invisible to it and counts here. Lizard also ends a function at the first `)` of a function-typed parameter (`resolve: (ref: string) => Ticket`), so everything after it is lost; the AST counts the whole body. Of 379 functions both tools measured at that candidate, 85 differed. The count above is the one the gate enforces.

`quartermaster-crap.cjs` re-exports the Quartermaster plugin's generic gate, which measures with Lizard for projects where no TypeScript AST path exists. It is not used by `crap.mjs`.
