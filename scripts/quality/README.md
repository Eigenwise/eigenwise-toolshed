# CRAP gate for the toolshed plugins

`node scripts/quality/crap.mjs --base <revision>` scores every function that is new or changed since `<revision>` under `plugins/*/lib` and `plugins/*/src`. Sidequest's built `lib/`, `bin/` and `hooks/` are skipped because `src/` is their source. A function fails at 6:

    CRAP = complexity² × (1 − coverage)³ + complexity

Coverage is V8 block coverage from the changed plugins' own suites (`test:full`, `test`, or `node --test test/*.test.js`), captured through `NODE_V8_COVERAGE` and projected onto each function's source span. `--coverage <dir>` reuses a capture instead of running the suites, `--all` prints unchanged functions too. Without `--base` the merge base with `develop` (or `main`) is used.

A function prints UNVERIFIED for one reason only: its coverage could not be mapped. That happens for an unnamed callback whose siblings in the built output do not line up with the source, so no twin can be trusted.

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
