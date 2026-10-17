# CRAP gate for the toolshed repository

The shared AST, function identity and V8 coverage core lives in `plugins/quality-gate/lib/`. This script owns only Toolshed path selection, build-output mapping, suite capture and text reporting; the plugin also exposes a `measure` entry that consumes existing coverage and prints JSON.

`node scripts/quality/crap.mjs --base <revision>` scores every JavaScript or TypeScript function that is new or changed since `<revision>`, wherever the changed file lives: `plugins/*/lib`, `plugins/*/src`, `plugins/*/scripts`, `plugins/*/test`, `scripts/`, `docs/scripts/`. Test callbacks are function bodies too and get their own rows. Changed means the function's own text (its body minus nested functions) differs from the base function it is paired with, or it has no partner. Pairing runs parent by parent: a sibling whose own text appears exactly once on each side pairs first, and the rest pair in order between those anchors, so inserting or deleting a test leaves the untouched callbacks after it unscored. The file list is the changed range itself (`git diff --name-status`), filtered to `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts`; Sidequest's built `lib/`, `bin/` and `hooks/` are skipped because `src/` is their source.

    CRAP = complexity² × (1 − coverage)³ + complexity

Every new or complexity-raised owned body must score strictly below 6 with measured coverage. Legacy edits with equal or lower complexity are informational and never fail the gate. Exact source bytes determine changes, so comments and formatting count. Untouched legacy bodies stay outside scope; an independently edited nested body does not charge its parent. Explicit user/project rules remain authoritative.

Every changed function lands in one of three reporting sections:

- **NEW**: no partner at the base.
- **MODIFIED-RAISED**: has a partner and its complexity rose.
- **LEGACY-UNCHANGED**: physically modified with equal or lower complexity.

NEW and MODIFIED-RAISED sections use PASS, FAIL or UNVERIFIED rows. LEGACY-UNCHANGED uses informational LEGACY rows with measured numbers or an unverified reason. The exit code is 1 when any enforced row fails or is unverified. A score of 6 fails before display rounding.

Coverage is native V8 precise block coverage. The existing suite runner preloads the shared core through `NODE_OPTIONS` and sets `QUALITY_GATE_V8_CAPTURE` to an empty capture directory. The core records coverage and executed script text through the same inspector session. Child processes inherit both settings when their environment is passed through. Raw `NODE_V8_COVERAGE` reports cannot prove executed bytes and are UNVERIFIED.

| changed path | suite run |
| --- | --- |
| `plugins/<name>/...` | that plugin's `test:full`, else `test`, else `node --test test/*.test.js` |
| `scripts/quality/...` | `node --test scripts/quality/*.test.mjs` |
| `scripts/release/...` | `node --test scripts/release/test/*.test.mjs` |
| `docs/scripts/...` | `node --test docs/scripts/content.test.mjs` |

`--coverage <dir>` reuses a capture instead of running the suites, `--all` prints unchanged functions too. Without `--base` the merge base with `develop` (or `main`) is used.

The plugin's separate `crap` LCOV command keeps explicit CLI `--lcov` as an override. Fresh isolated `coverageCommand` output wins over config `lcov`; that configured path is a fallback, defaulting to `coverage/lcov.info`. Without a command, existing output needs authentic capture-time source hashes. A command must rewrite an existing explicit or fallback file it selects. Missing or invalid selected output stays UNVERIFIED, never a stale fallback pass. This does not change V8 capture selection in the repository runner.

## Rows that are UNVERIFIED

Every UNVERIFIED changed row fails the gate like a FAIL does and says why:

- **no analyzer**: a changed source in another language (`.cs`, `.py`, `.sh`, `.ps1`, `.svelte`, `.tsx`, `.jsx`) prints one row for the file. The gate has nothing to measure it with; say so in the report rather than claiming a score.
- **no suite loaded this file**: no capture contains this file. Zero hits for an exactly owned runtime body is measured zero coverage; an absent record is a measurement gap. A child-process test must pass through `QUALITY_GATE_V8_CAPTURE` and the core preload in `NODE_OPTIONS`.
- **missing capture binding or executed bytes**: raw historical V8 reports cannot be authenticated by reading today's file. Recapture with the shared core preload into a new empty directory.
- **executed bytes differ**: the direct source changed, or the transformed output has no authentic matching embedded source map. Sidequest build outputs without maps stay UNVERIFIED.
- **missing or ambiguous body/range correspondence**: runtime ownership cannot be established exactly. Names, sibling order and nearest-end guesses cannot establish coverage.

## TypeScript loaded through tsx

The capture contains the JavaScript bytes tsx actually executed, including its inline compiler source map. Only a single-source embedded map naming the scored file, whose `sourcesContent` matches the scored text, is supported. The installed tsx emits `sourcesContent: [null]`; those captures are UNVERIFIED. A compiler capture with its authentic source content can be measured, without filling in missing content afterward. Runtime bodies are first identified by exact ranges in the captured executable AST, then bound to exactly one source AST twin by an exact closing-token end plus either the body-opening start or the declaration start after the runtime export prefix. Native TypeScript return annotations can erase the body-opening map segment; its exact declaration-start segment then supplies start authority. Body-start support stays for public/private/override modifiers with unmapped declaration starts. Missing or ambiguous anchors stay UNVERIFIED, as do later unmapped coverage boundaries. Half-open range ends map through the preceding closing token. Every coverage boundary must have supported source correspondence; unmapped ranges stay UNVERIFIED. A mapping delta is accepted only when the intervening generated and original text is byte-identical. Export names and proportional source/output scaling are never used.

Nested functions own separate coverage intervals. A covered export getter or enclosing callback cannot cover its idle production function or nested callback. A build without a supported map needs a fresh direct-source capture or supported compiler map.

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
