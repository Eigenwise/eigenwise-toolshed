# TypeScript and async rewrite contract

This is the binding contract for the Sidequest TypeScript rewrite. The rewrite changes the implementation language and selected I/O boundaries. It preserves the installed plugin's runtime paths, public behavior, persisted data, and Node-only deployment model.

## Decisions

| Area | Decision |
| --- | --- |
| Runtime artifact | Build in the repository and commit JavaScript. The marketplace cache runs that JavaScript directly, with no install or build on the user's machine. |
| Runtime module system | CommonJS `.js` on Node 22.5 or newer. TypeScript source uses `import` and `export`, compiled to CommonJS. |
| Build tools | `tsc --noEmit` for strict type checking, esbuild for deterministic runtime output, and `tsx` only for repository tests. All are pinned development dependencies. |
| Output layout | `src/lib/*.ts` builds to `lib/*.js`, `src/bin/*.ts` builds to `bin/*.js`, and each `src/hooks/*.ts` entry builds directly to its current `hooks/*.js` path. These legacy directories are the committed distribution tree. |
| Database model | `node:sqlite` and the store stay synchronous. Query shape and caching address measured stalls. Promise wrappers around `DatabaseSync` are forbidden. |
| Async model | HTTP, MCP transport, independent filesystem work, and child processes use async APIs. Hooks stay synchronous, bounded, single-shot programs. |
| Hook packaging | One bundle per hook entry, with a tiny source-level shared core duplicated by the build. Heavy store modules stay external and load only on event paths that need them. |
| Tests | Port all 36 current `node:test` suites to TypeScript one for one. Tests run against the exact committed/generated JavaScript distribution. |
| Compatibility | Keep database schema version 4, every CLI flag and output contract, every MCP tool schema, hook event wiring, environment variables, and stable entrypoint path. This rewrite names no public break. |

## 1. Fixed constraints

Sidequest executes from a Claude Code marketplace cache. The installed copy has no `node_modules`, and no install/build lifecycle runs there. Runtime code therefore remains Node standard-library code plus built-in `node:sqlite`. The current documented floor is Node 22.5 ([`README.md:466-467`](../README.md#L466-L467)), and the database imports `DatabaseSync` directly ([`lib/db.js:16-21`](../lib/db.js#L16-L21)). The rewrite keeps that floor and adds this package declaration:

```json
{
  "private": true,
  "type": "commonjs",
  "engines": { "node": ">=22.5.0" }
}
```

`typescript`, `@types/node`, `esbuild`, and `tsx` are exact, lockfile-pinned development dependencies. Runtime dependencies remain empty. Repository and CI builds use `npm ci`; marketplace users run only committed JavaScript.

The current runtime is CommonJS throughout. The CLI and MCP entrypoints use `require()` ([`bin/sidequest.js:25-35`](../bin/sidequest.js#L25-L35), [`bin/sidequest-mcp.js:17`](../bin/sidequest-mcp.js#L17)), library modules expose `module.exports`, and tests require those modules directly. Several modules also depend on their current directory for assets: the server locates the dashboard and plugin manifest relative to `lib/` ([`lib/server.js:23-35`](../lib/server.js#L23-L35)), and agent sync locates its template relative to `lib/` ([`lib/agentsync.js:33-41`](../lib/agentsync.js#L33-L41)). Keeping generated output in the current directories preserves those contracts without runtime shims.

### Toolchain options

| Option | Fit | Decision |
| --- | --- | --- |
| Committed compiled JavaScript | Runs on the existing Node floor, type-checks in the repository, keeps the installed cache self-contained, and gives one runtime on every supported machine. | Use it. |
| Node type stripping | Node 22.5 cannot be the guaranteed TypeScript runtime. Native stripping also provides no type check and supports a narrower TypeScript syntax/config contract than the repository build. | Reject it. |
| Native TypeScript on newer Node plus JavaScript fallback | Creates two installed execution paths, two extension-resolution rules, and two behaviors to verify. | Reject it. |
| ESM output | Requires changing `require()` consumers, JSON loading, `__dirname` usage, and lazy module loading. It gives no measured latency gain here. | Defer it to a separately versioned compatibility change. |

The build can use more than one repository tool. That is a build implementation detail, not a hybrid runtime. Every installed entrypoint runs committed CommonJS JavaScript.

### TypeScript settings

The final source passes one strict `tsc --noEmit` project with these minimum rules:

- `target: "ES2022"`.
- `module: "Node16"` and `moduleResolution: "Node16"`, with the package fixed to CommonJS.
- `strict: true`, `noUncheckedIndexedAccess: true`, and `useUnknownInCatchVariables: true`.
- Node types only. DOM types belong only in the separate dashboard project.
- Local source imports use explicit `.js` specifiers so the emitted path is valid without a loader.
- Final runtime source contains no `allowJs` escape hatch, `any` at public boundaries, TypeScript enums, decorators, or namespaces.

Boundary data starts as `unknown` and is narrowed once. This applies to hook stdin, CLI arguments after tokenization, JSON-RPC frames, request bodies, database JSON payloads, process output, and environment variables. Internal domain types may then be trusted. Existing permissive, fail-soft behavior remains where it is public behavior; type narrowing cannot turn ignored malformed hook input into a thrown error.

## 2. Source and distribution layout

Use this layout:

```text
plugins/sidequest/
  src/
    bin/
      sidequest.ts
      sidequest-mcp.ts
    hooks/
      shared/
        input.ts
        output.ts
        paths.ts
        session-state.ts
      board-first-reminder.ts
      ...one source file per current hook...
    lib/
      db.ts
      store.ts
      server.ts
      mcp.ts
      ...one source file per current module...
  test/
    _helpers.ts
    *.test.ts
    fixtures/
  bin/                         # generated and committed
    sidequest.js
    sidequest-mcp.js
  hooks/                       # hooks.json is source; *.js is generated and committed
    hooks.json
    *.js
  lib/                         # generated and committed
    *.js
  scripts/
    build.mjs
  package.json
  package-lock.json
  tsconfig.json
```

The mapping is exact:

| Source | Committed output | Build mode |
| --- | --- | --- |
| `src/lib/<name>.ts` | `lib/<name>.js` | Non-bundled, readable CommonJS. |
| `src/bin/sidequest.ts` | `bin/sidequest.js` | Non-bundled CommonJS with the existing Node shebang. |
| `src/bin/sidequest-mcp.ts` | `bin/sidequest-mcp.js` | Non-bundled CommonJS with the existing Node shebang. |
| `src/hooks/<name>.ts` | `hooks/<name>.js` | One CommonJS bundle per entry, Node built-ins external. |
| `test/*.test.ts` | No committed test output | Executed through repository-only `tsx` after the runtime build. |

A dedicated `dist/` plus forwarding wrappers loses on both compatibility and hook startup. The current CLI path is named in skills, tests, repository permissions, and documentation. The MCP config launches `bin/sidequest-mcp.js` directly ([`.mcp.json:1-8`](../.mcp.json#L1-L8)), while every hook command names a root `hooks/*.js` file ([`hooks/hooks.json:4-130`](../hooks/hooks.json#L4-L130)). Direct output keeps those files and both JSON configs byte-for-byte unchanged. It also keeps `lib/`-relative dashboard, manifest, and template paths valid.

`build.mjs` owns only generated `.js` files under `bin/`, `lib/`, and the known hook entry list. It must never delete or rewrite `hooks/hooks.json`, dashboard assets, skills, docs, fixtures, the plugin manifest, or the marketplace manifest. Build output is deterministic. CI regenerates it and fails on a diff in `bin`, `lib`, or generated hook files.

The source tree is the editing surface. Generated JavaScript stays readable enough for installed stack traces. Runtime source maps and loader registration stay out of the marketplace artifact.

## 3. Async model

### 3.1 Database and domain store stay synchronous

`DatabaseSync` is a synchronous API. The database currently opens in WAL mode with a busy timeout ([`lib/db.js:43-47`](../lib/db.js#L43-L47)), parses row JSON synchronously in `listRows()` ([`lib/db.js:221-231`](../lib/db.js#L221-L231)), and protects writes with an immediate transaction ([`lib/db.js:241-259`](../lib/db.js#L241-L259)). Preserve those semantics.

The binding rules are:

1. `src/lib/db.ts` exposes synchronous prepared-query and transaction functions.
2. A transaction callback is synchronous. An `await`, Promise, filesystem operation, network operation, or child process inside a SQLite transaction is forbidden.
3. Store functions that only validate, derive data, and access SQLite remain synchronous.
4. `Promise.resolve(syncDatabaseCall())`, `async` wrappers with no real await, and timer-based yielding around one blocking query are forbidden. They keep the same event-loop stall and hide it in the type.
5. Long JSON materialization is fixed with narrower SQL, projections, pagination, and resident caches. A worker thread is a later option only if the same profile still shows material stalls after those changes.

This keeps atomic mutations easy to reason about and avoids serializing every store payload across a worker boundary during the language migration.

### 3.2 Resident boundaries become async

Async pays where the process can serve other work while it waits:

| Boundary | Contract |
| --- | --- |
| Dashboard server | Keep request handlers async. Use `fs/promises` or streams for assets and attachments, await request bodies, and use non-blocking child processes. Run independent filesystem reads with `Promise.all` only when they have no ordering relationship. |
| MCP server | Make request dispatch Promise-aware. The stdio process may keep several reads or external operations in flight, writes one complete JSON line per response, and correlates out-of-order read responses by JSON-RPC id. |
| MCP mutations | Queue mutating calls in arrival order per board. Each queued SQLite mutation is one synchronous critical section. External work happens before or after that section, never inside it. |
| CLI | Use an async top-level `main()` for filesystem, HTTP, and child-process work. Buffer each command's public result and write it once so stdout/stderr ordering and exit codes stay unchanged. |
| Git and process modules | Replace `execFileSync` and `spawnSync` in resident-callable paths such as commit scope, publish, worktree inspection, agent sync, and server probes with awaited `execFile`/`spawn` adapters. Capture the same status, stdout, stderr, timeout, and `windowsHide` behavior. |
| Pure transforms | Keep parsing, validation, routing, schema construction, and payload projection synchronous. |

The HTTP server already awaits body reads and category-draft child completion ([`lib/server.js:82-106`](../lib/server.js#L82-L106), [`lib/server.js:135-159`](../lib/server.js#L135-L159)). The rewrite continues that shape instead of changing every function signature mechanically.

The current MCP handler calls every tool synchronously ([`lib/mcp.js:1323-1359`](../lib/mcp.js#L1323-L1359)), and the stdio entrypoint writes the return value immediately ([`bin/sidequest-mcp.js:19-45`](../bin/sidequest-mcp.js#L19-L45)). The TypeScript version may make the internal `handleRequest()` contract async. The external JSON-RPC frames, tool descriptors, error envelopes, notification behavior, and newline framing remain identical. Port direct unit callers to `await`; do not expose Promise details over MCP.

### 3.3 Hooks stay synchronous

Hooks are fresh, single-purpose Node processes. They read one JSON value from stdin, perform bounded local work, write at most one JSON value, and exit. Async initialization adds lifecycle and fail-soft complexity without useful overlap. Hook source therefore uses synchronous stdin, state-file, and targeted database operations.

The hook process must finish its required write before exit. Fire-and-forget Promises, unref'd maintenance children, and background database writes are forbidden. Expensive maintenance moves to a resident process or gets an incremental synchronous fast path.

## 4. SQ-602 performance findings and required response

SQ-602 profiled Windows 11 and Node 22 against 12 projects, 1,872 tickets, and a 578-ticket board. Fresh-process figures used 20 to 30 runs; resident figures used 40. The measured result changes the rewrite plan:

- `SessionStart` was 2,606.8 ms median and 3,257.4 ms p95.
- Dashboard all-project tickets were 713.6 ms median and 958.2 ms p95; projects were 386.5 ms and 529.7 ms.
- CLI cold reads ranged from 600.1 to 888.8 ms median.
- `UserPromptSubmit` board-first work was 588.0 ms median and 922.4 ms p95.
- `SubagentStart` was 978.8 ms and 1,682.7 ms; `SubagentStop` was 908.1 ms and 1,131.7 ms.
- Resident MCP `list` was 397.1 ms and 529.5 ms.
- `store.js` and `mcp.js` module loading took only 14.6 ms and 18.8 ms. `server.js` loading took 145.2 ms.
- `findProject()` took 540.4 ms cold and 443.2 ms warm because it enumerated and decoded every project. Generic `listRows()` decoded every selected JSON payload.
- The two common PreToolUse guards cost about 82 to 84 ms each, roughly 166 ms serial per tool call.

The dominant cost is broad synchronous SQLite/JSON materialization, amplified by fresh hook and CLI processes. The rewrite must include these structural corrections:

1. Resolve the default project and an absolute project path through canonical path, deterministic slug, and one project-row lookup. Reserve all-project enumeration for display-name ambiguity and explicit all-project commands.
2. Add query-specific database functions for project lookup, ticket status/archive pages, counts, and compact projections. Hot reads cannot call a generic all-row decoder and discard most results afterward.
3. Use the existing ticket project/status/archive/order indexes before proposing a schema change ([`lib/db.js:52-65`](../lib/db.js#L52-L65)).
4. Cache immutable or slow-changing project/category metadata inside resident MCP and server processes. Every mutation that affects cached data invalidates it in the same process. Fresh hooks do not build broad caches.
5. Give `SessionStart` an unchanged-install fast path. Agent definitions are a fixed generated set ([`lib/agentsync.js:5-24`](../lib/agentsync.js#L5-L24)); compare a compact version/template hash before reading and comparing the full ladder. Reconciliation and taxonomy reads use targeted rows.
6. Fetch all-project dashboard data with one filtered query and cache the serialized snapshot between mutations. Repeated per-project list/decode loops such as `aggregateTickets()` ([`lib/server.js:162-171`](../lib/server.js#L162-L171)) are forbidden on the hot route.
7. Keep MCP resident. CLI remains the compatibility and recovery surface, not the preferred high-frequency read path.

Async filesystem and process APIs improve resident concurrency. They do not count as a fix for any SQLite/JSON hotspot above.

## 5. Hook packaging and budgets

### Packaging

Each hook entry is built as its own CommonJS bundle directly at the path already named by `hooks.json`. Bundling may include only the hook and `src/hooks/shared/*`. The shared hook core covers stdin parsing, fail-soft output, plugin-root resolution, small atomic session-state files, and common event types. The build duplicates that small code into each entry so a common guard starts with one file parse and no local module walk.

General `src/lib/store.ts`, `server.ts`, `mcp.ts`, agent templates, TypeScript runtime code, source maps, and build dependencies stay out of lightweight hook bundles. A lifecycle hook that genuinely needs the store loads the committed `lib/store.js` lazily through the plugin root after it has parsed input and passed all cheap exit checks. That preserves current path behavior and keeps unrelated events away from SQLite.

Build output targets ES2022, so it emits native async syntax where used and no generator or Promise helper. Hooks themselves remain synchronous. Exported hook helpers such as the registry writer keep their CommonJS exports because tests and sibling code require them directly.

### Context byte budgets

Keep the existing context limits in [`test/hooks.test.js:33-37`](../test/hooks.test.js#L33-L37):

| Output | Current cap | Rewrite rule |
| --- | ---: | --- |
| Full SessionStart context | 2,850 characters | Preserve the cap and expectation text. Do not raise it for type/build details. |
| Compact/resume SessionStart context | 1,000 bytes | Preserve the byte cap. |
| Long-running SubagentStop note | 400 characters | Preserve the cap. |
| Taxonomy addition | 400 bytes | Preserve the source cap in [`hooks/session-start.js:30-53`](../hooks/session-start.js#L30-L53). |

Port these assertions before editing hook behavior. Generated code size never changes the allowed injected context size.

### Fresh-process latency budgets

Repeat the SQ-602 protocol on the same Windows/Node class after the build is in place. These are release ceilings, rounded slightly above the measured p95. They prevent the compiler, bundler, or async rewrite from making a hot hook slower:

| Event | Median ceiling | p95 ceiling |
| --- | ---: | ---: |
| SessionStart, unchanged install | 2,607 ms | 3,258 ms |
| UserPromptSubmit board-first | 588 ms | 923 ms |
| SubagentStart | 979 ms | 1,683 ms |
| SubagentStop | 909 ms | 1,132 ms |
| One common PreToolUse guard | 100 ms | 200 ms |
| Both common PreToolUse guards, serial | 200 ms | 400 ms |

These ceilings are the migration floor, not the performance goal. The targeted lookup and unchanged-install paths above must lower their medians. A result over a ceiling blocks release. A result inside the ceiling but with no improvement on the four expensive hooks gets profiled again before accepting the rewrite.

Wall-clock checks run in a dedicated `test:perf` script with isolated `SIDEQUEST_HOME`, the fixed fixture size, warm-up runs, and 20 or more measured fresh processes. The ordinary behavioral suite keeps deterministic checks for bundle boundaries, stable paths, context bytes, and cheap early exits. One noisy CI process timing cannot fail the behavioral suite.

## 6. Test migration and exact Windows command

The 36 current `test/*.test.js` files are the behavioral specification. Port every file to the same basename with `.test.ts`. Keep test names, inputs, fixtures, expected output, failure cases, Windows cases, concurrency cases, and subprocess coverage. A port may add types and `await` for newly async internal calls. It may not delete an assertion, convert a test to skip, broaden a matcher, or replace an end-to-end CLI/hook test with a unit-only test.

Tests continue to target the stable generated paths under `bin/`, `lib/`, and `hooks/`. This makes the suite verify the code that the marketplace ships. Run the build before tests. `tsx` transpiles test files only and never enters the committed runtime graph.

Add package scripts with this contract:

```json
{
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "build": "node scripts/build.mjs",
    "build:check": "npm run build && git diff --exit-code -- bin lib hooks",
    "test:full": "npm run typecheck && npm run build:check && node --import tsx --test test/*.test.ts",
    "test:perf": "node --import tsx --test test/*.perf.test.ts"
  }
}
```

From the repository root, the exact full-suite command on Windows is:

```powershell
npm --prefix plugins/sidequest run test:full
```

The script contains the explicit `test/*.test.ts` file glob. A bare `test` directory argument is forbidden because Node 22 on Windows does not discover it consistently.

Add these migration guards before replacing behavior:

1. Serialize `mcp.toolDescriptors()` from the current implementation into a checked fixture. The TypeScript implementation must produce the exact same JSON bytes, including tool order, property order, descriptions, required arrays, and numeric constraints.
2. Snapshot representative CLI stdout, stderr, exit status, JSON output, help output, aliases, omitted-option defaults, and malformed-input behavior.
3. Open a schema-v4 database produced by the current build, run reads and writes through the TypeScript build, then reopen it with the current build fixture. Compare persisted rows and schema version.
4. Assert `.mcp.json` and `hooks/hooks.json` still point to existing stable files. Spawn every hook from its configured command path.
5. Keep the current full-suite concurrency, future-schema refusal, migration, publish-lock, worktree, Windows, server, MCP stdio, and real CLI subprocess tests.
6. Add an installed-copy smoke test that copies only marketplace-shipped files, omits `node_modules` and `src`, then runs CLI help, MCP initialize/tools-list, every cheap hook, and a temporary schema-v4 board.

## 7. Compatibility contract

### Database

`CURRENT_SCHEMA_VERSION` stays `4` ([`lib/db.js:23`](../lib/db.js#L23)). The rewrite does not add, remove, rename, or reinterpret a table, column, index, global key, JSON payload field, status value, timestamp, ID, ref, ordering value, or claim field. It keeps WAL, the 5-second busy timeout, immediate write transactions, future-schema refusal, and migration of stores older than v4.

Performance work uses existing columns and indexes first. Any later schema/index change needs its own migration ticket, forward-version guard review, old/new process skew plan, and fixture. It cannot enter the TypeScript rewrite as an incidental optimization.

### CLI

`bin/sidequest.js` stays the entrypoint. Preserve all command names, flags, short aliases, repeatable options, defaults, environment variables, path resolution, stdout/stderr text, JSON shapes, exit statuses, signal behavior, and side effects. Parsing may gain types; it cannot move to a third-party parser or normalize previously distinct inputs.

### MCP

`.mcp.json` remains byte-for-byte unchanged. Preserve the server name, protocol negotiation, newline JSON-RPC transport, notification handling, every tool name, descriptor order, description, input schema, default, response text/JSON shape, error envelope, and side effect. Async internal dispatch may change response completion order only for concurrently submitted read-only calls, which are correlated by id. Mutations remain arrival-ordered per board.

### Hooks

`hooks/hooks.json` remains byte-for-byte unchanged. Preserve event names, matchers, command strings, timeouts, fail-soft exits, stdout JSON shapes, and environment-variable behavior. Every generated hook file exists at its current path. Hook build changes cannot add runtime setup output or warnings on stdout/stderr.

### Other runtime paths

Keep dashboard, manifest, template, asset, worktree, registry, and home-directory resolution identical. `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_SESSION_ID`, `SIDEQUEST_HOME`, and the current compatibility fallback variables retain their meanings. Generated CommonJS library files keep direct `require()` compatibility for existing tests and local callers.

## 8. Implementation order and acceptance

The implementation wave follows this order:

1. Add the private package, lockfile, strict TypeScript config, deterministic build script, and installed-copy smoke test.
2. Move tests to `.test.ts` with unchanged expectations. Make the full suite run against the still-current generated JavaScript.
3. Move pure and leaf library modules into `src/lib`, then database/store modules. Generate the same stable CommonJS paths after each slice.
4. Add targeted database queries and direct project resolution while the profiling fixtures can compare old and new paths.
5. Move server, MCP, CLI, process, and filesystem boundaries to the async contract. Keep database critical sections synchronous.
6. Move hooks last, one event at a time. Preserve output budgets, bundle boundaries, fail-soft behavior, and fresh-process measurements on each slice.
7. Run typecheck, build drift check, all 36 behavioral suites, installed-copy smoke tests, schema compatibility fixtures, CLI/MCP golden checks, and the dedicated Windows hook profile.

The rewrite is accepted only when all generated artifacts are committed, a clean checkout needs no runtime install, the exact Windows full-suite command passes, the configured entrypoints work from a copied installed plugin, schema remains v4, compatibility fixtures are unchanged, and hook latency stays inside the ceilings above.

## 9. Deferred work

The following work stays outside this rewrite:

- An ESM runtime conversion.
- A Node floor above 22.5.
- Native execution of `.ts` files in the marketplace cache.
- A database worker thread or async SQLite replacement.
- Schema version 5 or new indexes.
- CLI, MCP, hook, or server API redesign.
- Dashboard component and visual architecture, which has its own rewrite contract.
- New runtime dependencies.

Those choices can be revisited with separate measurements and compatibility plans after the TypeScript distribution is stable.