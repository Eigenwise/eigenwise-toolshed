# Changelog

One section per release window. Each window is a single commit on `main` that moves every
changed plugin at once, tagged `v<marketplace version>`, with matching per-plugin changelogs
under `plugins/<name>/CHANGELOG.md`.

Releases before v3.208.0 predate this file and are not backfilled; `git log` is the record for
those. Entries are generated from `.release/unreleased/*.md` by `scripts/release/cut.mjs`, so
nothing here is hand-written.

## v3.426.0 (2026-08-09)

### sidequest 4.41.7 → 4.42.0

#### Features

- Add bounded story contract projections (SQ-1561)
- Bound Sidequest dynamic hook context (SQ-1564)
  Sidequest hook context now stays within explicit, deterministic budgets and sends compact recovery pointers instead of repeating board history.
- Add universal MCP context continuations (SQ-1575)

#### Fixes

- Bound executor briefing context (SQ-1562)
  Executor briefings now use one bounded context projection and point executors to omitted contract pages.
- Keep nested task labels (SQ-1567)
  Nested Sidequest Agent tasks now keep their human dispatch descriptions in FleetView.
- Validate attestation ticket fields (SQ-1568)
  Sidequest now describes and validates its coupled attestation verification fields.
- Normalize planning warning checks (SQ-1569)
  Planning warnings now understand directory globs, explicit readonly choices, punctuated anchors, and npm prefix verify commands.
- Document the native diagnostic boundary (SQ-1572)
  Sidequest now documents that Claude Code's native language-server pipeline can inject diagnostics from live and deleted foreign worktrees before project hooks run, including the measured upstream reproduction and required filter behavior.
- Keep terminal board state authoritative (SQ-1573)
  Completed work no longer gets retried after a contradictory task notification.
- Preserve derived release scope through submission (SQ-1576)
  Keep prepared release-fragment scope through continuation, commit, submission, and integration.
- Bind frozen contract retrieval (SQ-1577)
  Oversized executor contracts now page from the dispatch snapshot even after the live story changes.
- Preserve bounded hook recovery context (SQ-1580)
  Sidequest hook notices now avoid duplicate injected text, preserve worktree redispatch actions, and keep live claims first during compaction recovery.
- Fix universal continuation audit blockers (SQ-1581)
- Close repaired submissions with lineage proof (SQ-1584)
- Compose readonly dispatch with frozen briefings (SQ-1589)
  Zero-scope read-only dispatches use the bound shared checkout, and executor briefings retain their bounded frozen projection.
- Stop reconciliation reminders from creating reply loops (SQ-1590)
- Fix CI git config and Node 20 action warnings (SQ-1592)
  CI now provides each test job an empty writable git config before checkout and uses Node 24 action runtimes.
- Repair bounded Sidequest MCP model and category reads (SQ-1593)
  Bounded MCP model and category reads keep compatible details and context-page retrievals.
- Repair retained-worktree continuation on current main (SQ-1595)
- Upgrade the remaining Node 20 cache action (SQ-1596)
  The test workflow now uses the Node 24 `actions/cache@v5` runtime for its OpenTelemetry cache.
- Allow reviewed retirement in submission supersession (SQ-1597)

## v3.425.0 (2026-08-08)

### sidequest 4.41.6 → 4.41.7

#### Fixes

- Refuse a submission whose commit is a strict subset of the verified worktree (SQ-822) [`2854cea`](https://github.com/Eigenwise/eigenwise-toolshed/commit/2854cea7)
  Scoped edits left unstaged were swept away with the worktree, so submit now refuses rather than accepting a partial commit.
- Prove the negative control exercised the new test (SQ-1386) [`54e7af3`](https://github.com/Eigenwise/eigenwise-toolshed/commit/54e7af34)
  A passing negative control only showed that some test caught the revert, not that the new one did, so a test that cannot fail could still ship.
- Warn when loaded plugin code is stale (SQ-1539)
  Warn before dispatching when Sidequest code loaded in the session is older than this project's installed plugin version.
- Accept an agent worktree under either isolation root (SQ-1546) [`ad4fa2a`](https://github.com/Eigenwise/eigenwise-toolshed/commit/ad4fa2a9)
  The isolation guard compared an executor's real linked worktree against a path built from sidequest's own worktree root, so a worktree provisioned by Claude Code's isolation:worktree never matched and every write was denied once the agent id was bound.

### workbench 0.83.2 → 0.83.3

#### Fixes

- Warn when loaded plugin code is stale (SQ-1539)
  Warn before dispatching when Sidequest code loaded in the session is older than this project's installed plugin version.

## v3.424.0 (2026-08-08)

### sidequest 4.41.5 → 4.41.6

#### Fixes

- Leave room for future Sidequest MCP tool arguments (SQ-936)
  Keep the MCP tool list compact while preserving its useful instructions and argument schemas.
- Report paths that block submission integration (SQ-1541)
  Show conflicted paths when a submission merge or replay fails.
- Warn about transitive in-package consumers together (SQ-1542)
  Show direct and transitive package consumers in one capped planning warning so ticket scope converges in one edit.

## v3.423.0 (2026-08-08)

### sidequest 4.41.4 → 4.41.5

#### Fixes

- Reject malformed verification commands (SQ-1227)
  Reject malformed verify values before submission or integration, and show executors the cmd.exe verify contract.
- Recognize Git Bash repository paths in the destructive Git guard (SQ-1459)
  Allow a held publish lock to authorize manual tag cleanup when Git Bash reports the repository as `/c/...`.
- Clarify foreign-worktree diagnostic guidance (SQ-1464)
  Clarify when diagnostics from foreign agent worktrees are stale noise and when they are actionable before integration.
- Provision isolated worktree dependencies before dispatch (SQ-1471)
  Sidequest now provisions configured dependency directories and setup commands before an isolated executor starts.

## v3.422.0 (2026-08-08)

### observability 0.6.1 → 0.7.0

#### Features

- Add recharge-weighted context accounting (SQ-1516)
  Add completed-session turn, tool-result byte, and recharge-weighted byte panels to the Grafana dashboard.

### sidequest 4.41.3 → 4.41.4

#### Fixes

- Run Sidequest tests at CI-safe concurrency (SQ-1537)
  Run the full Sidequest suite with available CPU parallelism and flag runs that approach the phase timeout.
- Keep verification evidence from blocking closeout (SQ-1538)
  Accept verification status evidence so completed checks and no-op closeouts are recorded.

## v3.421.0 (2026-08-08)

### sidequest 4.41.2 → 4.41.3

#### Fixes

- Document constrained MCP story log input (SQ-1255)
  Sidequest MCP schemas now document story-log prefixes and byte limits, with an actionable malformed-entry error.
- Preserve verified no-op release provenance (SQ-1529)
  Sidequest records verified no-op releases before isolated worktrees disappear, so they close as no-op work rather than grooming.
- Fix executor spawn instructions (SQ-1533)
  Executor definitions now tell orchestrators to pass the dispatch payload unchanged and let its route marker set the model and effort.

## v3.420.0 (2026-08-08)

### observability 0.6.0 → 0.6.1

#### Fixes

- Requeue exhausted observability deliveries (SQ-1526)
  The observer can requeue exhausted outbox records through its loopback API.

### sidequest 4.41.1 → 4.41.2

#### Fixes

- Move executor worktrees outside project roots (SQ-1425)
  New isolated worktrees live under the per-project Sidequest state root. Existing in-project worktrees remain sweepable while they drain.
- Reap stale Sidequest MCP servers (SQ-1491)
  Sidequest now stops superseded MCP servers from the same Claude process when a replacement starts.
- Validate MCP enum arguments (SQ-1527)
  Sidequest MCP tools now reject invalid enum argument values with the accepted values listed in the error.
- Deduplicate repeated planning warnings (SQ-1528)
  Planning warnings now appear once per ticket in a Claude session, with large warning sets capped and ranked.
- Keep executor scratch files in isolated worktrees (SQ-1530)
  Executor briefings now direct scratch files to the executor's own worktree instead of the shared session scratchpad.
- Make deferred sweep report draining race-safe (SQ-1531)
  Prevent deferred sweep reports from being replayed when a new worker writes a fresh report during session startup.
- Keep stale worktree cwd warnings after worktree relocation (SQ-1532)
  Stale board-server cwd warnings now recognize linked worktrees in the Sidequest state root, legacy project path, or another registered location.

### workbench 0.83.1 → 0.83.2

#### Fixes

- Make CI checks fail closed (SQ-1499)
  Workbench now waits for GitHub Actions runs and reports missing, failed, or inaccessible CI instead of treating silence as green.

## v3.419.0 (2026-08-08)

### sidequest 4.41.0 → 4.41.1

#### Fixes

- Validate complete verify commands (SQ-1306)
  Verify commands now reject unsafe tails, check each compound step, and cannot be changed to an unrunnable command while work is live.
- Classify unavailable verify commands (SQ-1487)
  Unavailable verify commands now report `could-not-run` instead of a failed test suite.
- Keep Sidequest tests off local services (SQ-1503)
  The full Sidequest suite now uses isolated home, board, and model-discovery state, so tests must provide any local service configuration they need.

## v3.418.0 (2026-08-08)

### sidequest 4.40.9 → 4.41.0

#### Features

- Add attestation verification oracles (SQ-1500)
  Not every ticket's real oracle is a command. When the board demanded one anyway, executors
  supplied whatever suite happened to pass, and the gate certified work that suite never
  touched.

  A ticket can now declare `verifyKind: attestation` with an `attestationArtifact` naming the
  specific URL, file, frame, or returned count that must be observed. The executor records
  what it actually saw as `attestation: <artifact> | <evidence produced> | <what it showed>`,
  and that becomes the reviewable oracle. Briefings say so explicitly, including that an
  unrelated passing suite is not a substitute.

#### Fixes

- Reject unknown Sidequest MCP arguments (SQ-926)
  Sidequest MCP tools now reject unknown arguments with the accepted keys, and category edits can update or clear routing fallbacks.
- Sync new executor worktrees to local integration main (SQ-1502)
  New isolated executor worktrees now synchronize to integrated local main commits before work starts.

## v3.417.0 (2026-08-08)

### observability 0.5.3 → 0.6.0

#### Features

- A stalled observer now reports unhealthy and steps aside (SQ-1524)
  An observer left over from a deleted worktree held the observer port for nine hours while
  delivering nothing, and answered `ok: true` the whole time. Its outbox had stopped
  retrying, and a `TypeError` in our own transport had counted against the retry budget as
  though the remote had rejected the batch.

  `/health` now returns 503 with `outbox_stalled` when records are pending and delivery
  attempts have stopped advancing, and with `plugin_version_outdated` when the running
  observer is older than the installed plugin. An outdated observer retires itself and frees
  the port instead of squatting on it. A transport-side `TypeError` no longer consumes a
  retry attempt, since it says nothing about whether the sink would have accepted the batch.

#### Fixes

- Collapse the spend query from 48 legs to 4 (SQ-1521)
  The Grafana spend panels priced tokens with one LogQL leg per (model, token type): 48
  `sum_over_time` legs sharing one unnarrowed selector, joined into a 12.7KB expression.
  Loki reread the whole stream once per leg, measured at 229MB and 433k lines to return a
  single number from a window holding about 5,500 entries. An open dashboard tab was worth
  roughly 8 cores.

  Prices now travel as a label, so one leg per token type covers every model. Same window,
  same cost figure (matching to 8.9e-16), 18MB read instead of 229MB.
- Stop a cosmetic probe from taking telemetry down (SQ-1525)
  `setup-observability` asked Prometheus which projects were recently active without
  supplying a start time, so the request sent `start=undefined` and Prometheus answered 400.
  That threw after the managed processes had already been stopped, leaving nothing listening
  on the observer port: a run meant to repair telemetry took it from degraded to fully down.

  The activity window now defaults to the last 30 days and rejects a non-timestamp instead
  of interpolating it into the query. Which per-project dashboards to provision is cosmetic,
  so a failed probe now degrades to the global dashboard and says so on stderr rather than
  aborting the run.

## v3.416.0 (2026-08-08)

### sidequest 4.40.8 → 4.40.9

#### Fixes

- Read comment updates incrementally (SQ-1515)
  `comments` can now return only entries added after a prior comment id or timestamp.
- Restore executor tools (SQ-1523)
  Executor definitions no longer emit a `tools:` allow-list. Since 4.40.6 every executor
  carried `tools: default, Skill(playbook:verify-discipline)`, and `default` is a CLI
  sentinel rather than a frontmatter tool name, so executors spawned with no Bash and no
  board tools and could not fetch their briefing. Skill preloading stays pinned by `skills:`.

## v3.415.0 (2026-08-08)

### sidequest 4.40.7 → 4.40.8

#### Fixes

- Compact successful integration verification results (SQ-1514)
- Recover terminal executor claims without redispatching (SQ-1518)
- Warn when ticket file scope omits likely module consumers (SQ-1519)

## v3.414.0 (2026-08-08)

### sidequest 4.40.6 → 4.40.7

#### Fixes

- Bind a dispatch to its executor from the claim token (SQ-1413)
  An isolated dispatch used to bind only when Claude Code's spawn interception could match the launch to a running agent. Concurrent spawns made that match ambiguous and resumed agents never passed through it at all, so the claim was refused as `unbound_dispatch` and the executor died having done nothing. Presenting the prepared dispatch's briefing token at claim now binds the claiming identity directly.
- Let the declared verify pass before the generated outputs are committed (SQ-1512)
  `build:check` used to fail on any uncommitted file under `bin`, `lib` or `hooks`, so an executor that edited TypeScript and then ran its declared verify was refused for outputs it had just regenerated correctly. There was no ordering of edit, verify and submit that passed. It now fails only on outputs the build itself changed, which still catches stale committed output in CI while letting correct work through mid-change.
- Report every independent completion refusal together (SQ-1513)
  Submit, add, and integrate now report all independently fixable validation failures in one response.

## v3.413.0 (2026-08-08)

### sidequest 4.40.5 → 4.40.6

#### Fixes

- Carry released executor checkpoints into continuation dispatches (SQ-1462)
- Preserve oracle verdict rounds when an executor asks for a ruling (SQ-1483)
- Bound executor skill loading (SQ-1495) [`df7ac03`](https://github.com/Eigenwise/eigenwise-toolshed/commit/df7ac0352287d26cc6366234ace5eb9c42f9c651)
- Explain rejected import-error negative controls (SQ-1498) [`0ee811d`](https://github.com/Eigenwise/eigenwise-toolshed/commit/0ee811dbd1827c2c22447ea7837e480d09b20429)
- Rule on scope requests immediately instead of pausing the executor (SQ-1504)
  Scope requests now rule immediately. Policy-allowed paths expand scope, while refused paths are handed back for orchestrator redispatch. Executors no longer wait on a pending ruling that may never arrive.
- Preserve continuation checkpoints on Windows short paths (SQ-1509)
  Continuation dispatches now keep committed handbacks when Windows path aliases resolve to the same repository.

## v3.412.0 (2026-08-07)

### observability 0.5.2 → 0.5.3

#### Fixes

- Unify dashboard spend across model backends (SQ-1501)
  Grafana now reports one reconciled spend total with unified model and project breakdowns across every backend. Project views include gateway-attributed spend, and the Codex routing stat no longer shows Grafana's query-reference label.

## v3.411.0 (2026-08-07)

### model-gateway 0.48.1 → 0.48.2

#### Fixes

- Gateway usage records now include their session project (SQ-1488)
  Gateway token-usage records now resolve their Claude Code session to a project
  and send that project as an OTLP resource attribute, so Codex spend appears in
  per-project dashboards.

### observability 0.5.1 → 0.5.2

#### Fixes

- Simplify Grafana dashboards and rebuild them from active telemetry (SQ-1492)
  Grafana dashboards now focus on cost, routing, failures, and source health with 15 mostly graphical panels instead of 39. Project dashboards rebuild from recent telemetry rather than the opt-in registry, and `setup-observability --reset-dashboards` clears generated dashboards until fresh activity returns.

### sidequest 4.40.4 → 4.40.5

#### Fixes

- Reserve executor verification budget (SQ-1400)
  Briefings tell executors to run declared verification early, plan around the observed tool-call cap, and report when verification was not reached.
- Refuse unscoped write dispatches (SQ-1485)
  Dispatch now refuses write tickets without declared file scope unless the caller explicitly overrides it.
- Wait for SQLite database contention (SQ-1493)
  Sidequest now waits through brief SQLite lock contention and reports an actionable error if the wait expires.
- Enforce Codex dispatch route markers (SQ-1494) [`ef2019d`](https://github.com/Eigenwise/eigenwise-toolshed/commit/ef2019d5742c7a72262a18ff4cbdd9a55e28821b)
  Sidequest now refuses a prepared Codex dispatch when its route marker is missing or a Claude executor class would run it on the wrong backend.
- Fix Windows verification capture timeouts and quoted paths (SQ-1496)
  Verification now stops timed-out Windows command trees and preserves quoted command paths.

## v3.410.0 (2026-08-07)

### observability 0.5.0 → 0.5.1

#### Fixes

- Recover stale observability observer ports (SQ-1479)
  Observability now replaces stale or unresponsive observer processes during upgrades and shows the owner details at session start.
- Keep Grafana telemetry flowing when the local observer stalls (SQ-1480)
  Collector sink pipelines now isolate local observer failures, and the model token panel also reads direct gateway telemetry.
- Prune observability storage automatically (SQ-1481)
  The observer now prunes expired telemetry on a schedule, checkpoints oversized WAL files, reports storage limits, and rotates managed logs.

### sidequest 4.40.3 → 4.40.4

#### Fixes

- Refuse executor self-dispatches and show unbound launches as stalled (SQ-1416)
  Executors now get an actionable release path when a dispatch is unbound, and the board shows launches that cannot be claimed as stalled.
- Keep claims held when dispatch.boundAt is null and reclaim missing worktrees (SQ-1450)
- Warn when worktree fixtures differ from integration (SQ-1454)
- Accept annotated negative-control evidence (SQ-1465)
  Negative-control markers now accept trailing context and explain malformed marker lines.
- Retry failed worktree quarantines after a daily delay (SQ-1466)
- Record oracle verdicts when the experiment round is missing (SQ-1467)
  Oracle verdicts now create their missing experiment-log round instead of leaving the ticket unable to resolve the ask.
- Let executor sessions compact under the veto policy (SQ-1468)
  Executor sessions no longer block automatic compaction while they hold their own Sidequest claim.
- Remove executor turn cap (SQ-1469)
  Sidequest executor definitions no longer impose a turn cap, preventing completed work from being terminated before it can be committed or handed back.
- Tell executors to regenerate paired outputs before verify (SQ-1472)
  Executor briefings now tell users to regenerate auto-paired tracked generated files before verifying.
- Stop treating slashed prose as anchor paths (SQ-1477)
  Anchor warnings now ignore slash-containing prose and resolve package-relative files.

## v3.409.0 (2026-08-07)

### live-rules 2.10.0 → 2.10.1

#### Fixes

- Scoped rules keep working when Windows hands us two spellings of the same path (SQ-1444)
  Windows can name one directory more than one way: a short 8.3 form like
  `C:\Users\RUNNER~1`, a different drive-letter case, a substituted drive. Claude
  Code hands the project root and the edited file path to a hook through different
  APIs, and those two can disagree about which spelling they use.

  When they disagreed, the relative path came out looking like it pointed outside
  the project, the hook decided the edit was somewhere else, and every glob- and
  directory-scoped rule quietly did not inject. No warning. Rules looked like they
  had simply never been written.

  Both sides are now resolved to a real canonical path before they are compared,
  so the spelling no longer decides whether your rules apply. Files that do not
  exist yet still work, which matters because edit hooks fire for new files.

### model-gateway 0.48.0 → 0.48.1

#### Fixes

- The secret-hazard check no longer misses in-project files on Windows (SQ-1446)
  Same Windows path-spelling problem as SQ-1444, in three more places.

  Playbook decides whether a written file is inside the project before warning you
  about an untracked sensitive file. When the project root and the file path came
  through with different spellings, a real in-project secret was dropped from the
  hazard report, which is the one thing that check exists to catch.

  Workbench compared installed-plugin and Sidequest install paths the same raw
  way, so project- and local-scoped installs could be reported missing or inactive
  and the freshness hook told you to set up something you already had.

  Model-gateway used a raw path as its project-wiring registry key, so one project
  could be recorded twice and reconciled twice against the same settings file.

  All three now canonicalize both sides before comparing.

### observability 0.4.0 → 0.5.0

#### Features

- The token report can now answer whether cost actually moved (SQ-1418)
  The board cost report had no time window, so it could tell you what executors
  cost in total and never whether that number went up or down after a change.
  `--since`, `--until` and `--compare-previous` now window it, and the comparison
  reports per-category average-token deltas between the two windows.

  The orchestrator/executor split used to label agent-id-absent traffic as the
  orchestrator. That was inference by absence: the gateway derives its role from
  the same header, so an absent agent id means unidentified, not main loop. That
  bucket is now called `orchestrator_or_unidentified` and says what it actually
  knows.

  The text report also printed the whole per-request ledger before any rollup, so
  the summary sat a few thousand lines below the raw data. Rollups come first now
  and the ledger is behind `--ledger`.
- Canonicalize observability project paths (SQ-1445)
  Observability now resolves filesystem aliases before deriving a telemetry `project_id`.
  Telemetry rows written under the old raw-path-derived ID remain in the local store, but
  are not read under the canonical project identity and will no longer appear in that
  project's dashboard. New events use the canonical ID.

### playbook 0.4.0 → 0.4.1

#### Fixes

- The secret-hazard check no longer misses in-project files on Windows (SQ-1446)
  Same Windows path-spelling problem as SQ-1444, in three more places.

  Playbook decides whether a written file is inside the project before warning you
  about an untracked sensitive file. When the project root and the file path came
  through with different spellings, a real in-project secret was dropped from the
  hazard report, which is the one thing that check exists to catch.

  Workbench compared installed-plugin and Sidequest install paths the same raw
  way, so project- and local-scoped installs could be reported missing or inactive
  and the freshness hook told you to set up something you already had.

  Model-gateway used a raw path as its project-wiring registry key, so one project
  could be recorded twice and reconciled twice against the same settings file.

  All three now canonicalize both sides before comparing.

### sidequest 4.40.2 → 4.40.3

#### Fixes

- Sidequest warns about diagnostics from other agents' worktrees (SQ-1420)
  Sidequest now warns when diagnostics point at another agent's embedded worktree.
  Those diagnostics can be stale or missing-dependency artifacts, including ones
  shown as errors, and previously flooded agents' context until two executors hit
  "Prompt is too long" before reading their briefings.

  The warning keeps diagnostics in the receiving agent's own checkout actionable
  and marks foreign-worktree diagnostics as non-actionable.
- Plugin submissions now require a release fragment (SQ-1427)
  Sidequest now refuses submissions that change a marketplace plugin without the
  matching release fragment. The refusal says where to create it, what frontmatter
  it needs, and that the executor must request scope for that path first.
- Negative-control submissions keep executor attribution (SQ-1435)
  Sidequest now accepts a real negative control recorded by the active executor instead of refusing the submission as if no control existed. When a control belongs to another executor, the refusal names the attribution mismatch.
- Let executors write their own release fragment (SQ-1440)
  Executors can commit their ticket's own release fragment without requesting scope. This removes the same scope round trip that blocked this fix and left other plugin fragments to be written by hand. Other tickets' fragments remain outside the grant.
- The release-fragment guard now covers both submit paths (SQ-1448)
  SQ-1427 made submit refuse a plugin change with no release fragment, but only
  through the MCP tool. There are two submit paths, and the CLI one, which is what
  inline and admin work uses, still let the change through.

  Both paths enforce it now.

  This matters because a plugin change that lands with no fragment never moves its
  version, and a version that never moves never reaches anyone's install. The work
  looks shipped and is not.
- Salvage old unintegrated Sidequest worktrees before removing them (SQ-1449)
  Sidequest now saves stale unintegrated worktrees to recovery refs before removing them.
- Executor verification resolves its capture script from the installed plugin (SQ-1453)
  Executor verification now uses the installed Sidequest plugin's own capture script path, so it works from projects that do not contain the Toolshed repository layout.
- Raise release suite timeout and allow plugin overrides (SQ-1460)
  Default test-directory suites now allow two minutes per test, so release cuts keep a useful timeout without treating normal filesystem and process I/O as a hung test. A plugin can set `suiteTimeout` in its `.claude-plugin/plugin.json` when its suite needs a different limit.
- Integration git commands cannot wait on configured editors forever (SQ-1461)
  Integration git commands now disable configured editors and time out after two minutes, so a hidden editor cannot leave a merge or replay blocked indefinitely.

### workbench 0.83.0 → 0.83.1

#### Fixes

- The secret-hazard check no longer misses in-project files on Windows (SQ-1446)
  Same Windows path-spelling problem as SQ-1444, in three more places.

  Playbook decides whether a written file is inside the project before warning you
  about an untracked sensitive file. When the project root and the file path came
  through with different spellings, a real in-project secret was dropped from the
  hazard report, which is the one thing that check exists to catch.

  Workbench compared installed-plugin and Sidequest install paths the same raw
  way, so project- and local-scoped installs could be reported missing or inactive
  and the freshness hook told you to set up something you already had.

  Model-gateway used a raw path as its project-wiring registry key, so one project
  could be recorded twice and reconciled twice against the same settings file.

  All three now canonicalize both sides before comparing.

## v3.408.0 (2026-08-07)

### observability 0.3.3 → 0.4.0

#### Features

- Telemetry retention, so the observability database stops growing forever (SQ-1423)
  Nothing ever pruned the local telemetry database. On a machine that had been
  running it for a few weeks it had reached 8.7 GB across 13.5M measurement rows,
  and a single grouped scan of the gateway usage rows took 111 seconds, which is
  why the token usage report had become unusable rather than merely slow.

  There is now a prune command with a 30-day default window, a configurable one,
  and indexes for the retention and usage-query filters. It runs in a transaction
  and is safe against a live observer.

  Running it reports what it would remove and how much space that reclaims;
  deleting anything needs `--apply`. It says up front that SQLite does not hand
  space back to the filesystem without `VACUUM`, which needs free space roughly
  equal to the database. `--help` lists every option and marks the destructive
  ones.

### sidequest 4.40.1 → 4.40.2

#### Fixes

- Executor verify no longer reports working code as red on Windows (SQ-1408)
  The wrapper that captures an executor's verify run was built around POSIX shell
  syntax, so on Windows it died with a syntax error before the suite ran. The
  executor read that as its own tests failing and reported a red that was really
  the harness breaking. On SQ-1406 that nearly got finished, working code thrown
  away.

  Verify capture now picks the shell per platform and reads the real exit status
  back from a marker the command itself writes, so a wrapper that cannot run is
  reported as `could-not-run` rather than as a failing suite. A red now means the
  tests failed.
- An executor can always undo its own uncommitted edits (SQ-1419)
  An executor that made a bad edit inside its own declared scope could not undo
  it. The write went through, the revert was refused because the acting agent id
  no longer resolved to an active ticket, and the executor released with the
  damage still sitting in the tree. In a shared checkout that leaves broken
  uncommitted code in the tree a running app builds from, which is how a mistake
  the executor had already caught became something a human had to find.

  Restoring a declared-scope file to its committed content is now always allowed.
  It cannot introduce anything the repository did not already contain, so there is
  nothing for scope enforcement to protect against. Writing new content to an
  unbound or out-of-scope path is refused exactly as before.
- A stale board-server cwd is now warned about under isolated dispatch too (SQ-1421)
  A board server left running from a leftover `.claude/worktrees` directory breaks
  dispatch, and the warning that says so only fired for shared-tree dispatch. That
  is the mode where the consequence is mildest. Under isolated dispatch, the same
  stale cwd made every dispatch fail to bind, and the warning stayed silent
  throughout while someone spent an hour finding it by hand.

  The check now runs for every dispatch, with wording per mode: shared-tree keeps
  its existing message, isolated gets one naming what actually goes wrong there and
  that restarting the session clears it.
- A worktree that cannot be removed is quarantined instead of retried forever (SQ-1422)
  Most executor worktrees remove cleanly. The ones that do not are the ones where
  an executor materialized native build artifacts inside them — a `.venv` with
  compiled extensions, `node_modules` with native addons — because Windows keeps
  handles on loaded binaries, and the processes holding them can outlive anything
  you are able to kill.

  The sweep used to retry those every session, which is why it started exceeding
  its own SessionStart budget. A worktree whose removal fails is now quarantined:
  recorded, moved aside, and never selected as a working directory or retried
  again.

  Stale MCP server processes were looked at as part of this and are not ours to
  reap — `claude.exe` owns their lifecycle.
- The scope-drift warning no longer fires on every dispatch (SQ-1432)
  Any repository with a `docs` directory got a scope-drift warning on every
  dispatch, because `docs/` is granted to every dispatch by policy and is never
  part of what a ticket declares. The two sets could not agree, so the warning
  fired on every pulse and told the reader to resync a scope that was already
  correct. Resyncing did not help either, since the next dispatch re-granted it.

  Always-in-scope paths are now excluded from the comparison, so the warning only
  appears when a dispatch really does enforce something the ticket did not declare
  — and it prints the declared casing, so the difference it names is the real one.

## v3.407.0 (2026-08-07)

### sidequest 4.40.0 → 4.40.1

#### Fixes

- Dispatch stopped binding when a ticket's text mentioned another ticket (SQ-1413)
  4.40.0 started carrying ticket title, description, and anchors in the spawn
  prompt. The Agent gate resolved a spawn's tickets by scanning that whole prompt
  for `SQ-` refs, so any ticket whose own text named another ticket suddenly
  looked like a multi-ticket batch. The gate then denied it as conflicting or
  not-found and recorded no launch, and the executor failed its claim with
  `unbound_dispatch`.

  The gate now takes the dispatched refs from the briefing command, where each ref
  is paired with its own token, and falls back to scanning only when no briefing
  command is present. Ticket prose can name whatever it likes.

## v3.406.0 (2026-08-07)

### sidequest 4.39.1 → 4.40.0

#### Features

- Carry implementation context into executor spawns (SQ-1265)
  Dispatch prompts now spend a bounded 1.2 KB on the ticket title, body excerpt, declared scope, anchors, and newest story finding before the token-gated fetch. Per-section caps keep the serialized spawn below the existing 2 KB ceiling even when one field is huge. The fetched briefing raises the newest-first story log window to 16 KB, enough for one maximum-size 16,000-byte handoff plus metadata. That small upfront packet replaces the 439-byte pointer without reintroducing full board payloads, and targets the measured 63-425 KB rediscovery runs.
- Scope inside a ticket's own package is granted without a ruling (SQ-1384)
  A scope request used to pause the executor and wait for a human ruling no matter
  what it asked for. That round trip is fatal rather than slow: an executor that
  pauses before its first edit has an unchanged worktree, and the runtime sweeps
  it when the process ends. Two of those cost 520,087 tokens for zero output in a
  single session.

  An audit of 2,243 tickets found 30 retained scope resolutions: 25 granted, 2
  partial, 3 denied. The three refusals share real boundaries, and those are what
  the new default is built from. Concrete paths inside the ticket's own package or
  plugin are granted at request time. Another package or plugin, protected control
  and release paths, wildcards, and read-only tickets still pause for a ruling, and
  the scope record still shows what was granted and why.

### workbench 0.82.0 → 0.83.0

#### Features

- The freshness guard checks the remote manifest for every plugin (SQ-1383)
  The prompt freshness guard used to compare two things that could both be stale,
  so it could report everything current while an installed plugin sat behind. It
  now checks the remote manifest for every active Toolshed plugin, through a cache
  so the check does not pay a network round trip on every prompt.

## v3.405.0 (2026-08-07)

### sidequest 4.39.0 → 4.39.1

#### Fixes

- Clarify shared-tree warnings and scoped pulse git fields (SQ-1405)
  Two outputs stated a conclusion without saying what they measured, and both were
  read as bugs by someone who then proposed fixes that would have broken working
  behavior.

  The stale-worktree-cwd warning now says it is about a shared-tree dispatch, that
  the executor has no worktree of its own, and which project root it should be
  running from. It only ever fired for shared-tree dispatches, because an isolated
  executor gets an absolute worktree path pinned in its briefing, but the old text
  said "spawned executors" and read like the gate was backwards.

  `pulse`'s `git.commit` and `git.dirty` are both scoped to the ticket's declared
  files, so the commit is usually older than HEAD and the dirty flag is not
  repository-wide. Both now carry a note field saying so.
- Recover unbound Sidequest dispatch claims (SQ-1406)
  Pulse now identifies claimed dispatches that never recorded a runtime identity.
  Those claims use the inactivity backstop instead of staying claimed forever.

## v3.404.0 (2026-08-06)

### sidequest 4.38.0 → 4.39.0

#### Features

- The feature skill is now the user-story skill (SQ-1402)
  `/sidequest:feature` is now `/sidequest:user-story`. The skill files a story and
  its backlog, and it drives more than features: subsystems, redesigns, refactors,
  multi-part bug work. Naming it after what it produces matches the board's own
  `US-n` vocabulary. The old name is gone, with no alias.

### workbench 0.81.1 → 0.82.0

#### Features

- The feature skill is now the user-story skill (SQ-1402)
  `/sidequest:feature` is now `/sidequest:user-story`. The skill files a story and
  its backlog, and it drives more than features: subsystems, redesigns, refactors,
  multi-part bug work. Naming it after what it produces matches the board's own
  `US-n` vocabulary. The old name is gone, with no alias.

## v3.403.0 (2026-08-06)

### codebase-mapper 2.14.0 → 2.14.1

#### Fixes

- Delete tests that pinned wording instead of behavior (SQ-1238)
  715 assertions across four plugins checked that documentation said something in
  one particular arrangement of words. They failed when a paragraph was rewrapped
  and passed when a claim was reworded away, so they cost suite time and release
  diagnoses without protecting anything. They are gone.

  17 assertions survive, and each guards something a user or caller actually
  depends on: a banned instruction that must never reappear, a threshold on a real
  cost, a contract a descriptor has to convey. Those now assert the mechanism
  rather than the sentence, matching whitespace-tolerantly where only text can
  express the claim.

  The worst habit this removes is not the wasted time. It is that shipped prose was
  being edited to satisfy a regex, which lets a test quietly start writing the
  documentation.

### observability 0.3.2 → 0.3.3

#### Fixes

- Delete tests that pinned wording instead of behavior (SQ-1238)
  715 assertions across four plugins checked that documentation said something in
  one particular arrangement of words. They failed when a paragraph was rewrapped
  and passed when a claim was reworded away, so they cost suite time and release
  diagnoses without protecting anything. They are gone.

  17 assertions survive, and each guards something a user or caller actually
  depends on: a banned instruction that must never reappear, a threshold on a real
  cost, a contract a descriptor has to convey. Those now assert the mechanism
  rather than the sentence, matching whitespace-tolerantly where only text can
  express the claim.

  The worst habit this removes is not the wasted time. It is that shipped prose was
  being edited to satisfy a regex, which lets a test quietly start writing the
  documentation.

### sidequest 4.37.0 → 4.38.0

#### Features

- Run one ticket on a different model without touching its category (SQ-1390)
  A ticket can now carry its own route override, so "run this one on a stronger
  model" no longer means editing the category route and silently repointing every
  later ticket that shares it. Set it through `add` or `update` on the MCP tool or
  the CLI; dispatch prefers it over the category route.

  The override goes through the same checks the category route already gets. It
  cannot cross providers, and an override naming a model that is not currently
  available refuses the dispatch rather than quietly falling back to a weaker one,
  because a silent downgrade defeats the reason for naming a model.

  The spawn-gate refusal now names the ticket's resolved route and points at the
  override, instead of only stating that the marker did not match.
- Work in your own repo while an executor integrates (SQ-1392)
  Integration used to refuse whenever the working tree was dirty, including files
  that had nothing to do with the ticket. Editing your own notes or settings while
  an agent worked would block it, and the agent's only way forward was to touch
  files it had correctly been told to leave alone.

  Integration now blocks only on dirty paths inside the ticket's declared scope or
  its submitted range. Everything else is reported as one informational line and
  left exactly as it is.

  Rollback got safer in the same pass. Both the post-verification path and the
  replay-conflict path now roll back with `--merge`, which refuses when it would
  overwrite a local edit, instead of a tree-wide hard reset that would delete it.
  A refused rollback is reported rather than silently swallowed.

#### Fixes

- Delete tests that pinned wording instead of behavior (SQ-1238)
  715 assertions across four plugins checked that documentation said something in
  one particular arrangement of words. They failed when a paragraph was rewrapped
  and passed when a claim was reworded away, so they cost suite time and release
  diagnoses without protecting anything. They are gone.

  17 assertions survive, and each guards something a user or caller actually
  depends on: a banned instruction that must never reappear, a threshold on a real
  cost, a contract a descriptor has to convey. Those now assert the mechanism
  rather than the sentence, matching whitespace-tolerantly where only text can
  express the claim.

  The worst habit this removes is not the wasted time. It is that shipped prose was
  being edited to satisfy a regex, which lets a test quietly start writing the
  documentation.
- Messaging a finished executor is refused before it wakes up (SQ-1391)
  Submitting is terminal: it releases the claim, and the executor that produced
  the work can no longer amend it. Asking it anyway used to wake the executor,
  spend a turn on it, and get the same answer the board already knew, before the
  idle hook shut it down.

  That message is now refused up front, and the refusal names the supported paths:
  file a follow-up ticket, or redispatch a ticket that was released without a
  pending submission. Executors that are still working are unaffected.

  The claim lifecycle is stated directly in the orchestrator guidance, because the
  tempting move is to reach for the executor that already has the context.

### workbench 0.81.0 → 0.81.1

#### Fixes

- Delete tests that pinned wording instead of behavior (SQ-1238)
  715 assertions across four plugins checked that documentation said something in
  one particular arrangement of words. They failed when a paragraph was rewrapped
  and passed when a claim was reworded away, so they cost suite time and release
  diagnoses without protecting anything. They are gone.

  17 assertions survive, and each guards something a user or caller actually
  depends on: a banned instruction that must never reappear, a threshold on a real
  cost, a contract a descriptor has to convey. Those now assert the mechanism
  rather than the sentence, matching whitespace-tolerantly where only text can
  express the claim.

  The worst habit this removes is not the wasted time. It is that shipped prose was
  being edited to satisfy a regex, which lets a test quietly start writing the
  documentation.

## v3.402.0 (2026-08-06)

### sidequest 4.36.0 → 4.37.0

#### Features

- The test suite runs in half the time, with nothing removed (SQ-1387)
  Two things were making every run slower than it needed to be, and neither was the number of tests.

  A hook latency benchmark sat inside the default suite costing 23.6 seconds, 12.7% of the total. An audit proved it could not do its job: injecting a 100ms delay into session-start raised the reported median from 244ms to 434ms and the test still passed. It has no threshold to fail. It now lives behind `npm run test:perf`, and the coverage it was genuinely providing, that every hook runs without crashing, moved to a smoke test that reads the hook list from `hooks.json` instead of a hardcoded set, so a new hook is covered the moment it is configured.

  The runner was pinned to 4-way concurrency on a machine with 32 cores. Measured across the whole suite: 106s at 4, 77s at 8, 83s at 12, 88s at 16. It gets worse past 8, because the heaviest files spawn git subprocesses and build real worktrees that then contend on the same disk. The setting is now derived from available cores with that cap, so a small CI runner gets a small number.

  Full gate wall clock: about 190 seconds down to 102.

  Separately, the MCP descriptor golden compared serialized bytes, which meant a diff on it told a reviewer only that something moved. Reversing the descriptor order was enough to fail it, and that changes no contract. It now asserts what callers actually depend on: removed tools stay absent, names stay unique, and the descriptions and schema properties that carry caller discipline still say what they need to say.

## v3.401.0 (2026-08-06)

### sidequest 4.35.0 → 4.36.0

#### Features

- Executors verify what they changed; the integrator runs the full suite (SQ-1381)
  Every executor was running the whole plugin suite before submitting, inside its own budget, in a worktree forked from `origin/main` when it was dispatched. The result could not be trusted: five executors in one session forked the same commit and four merges landed while they worked, so each one's "full suite passed" described a tree that no longer existed. The orchestrator re-ran the same suite on the merged tree anyway, and that is the run every decision was actually made on.

  So the suite was being paid for twice, and the copy nobody could believe was the expensive one. Worse, it was the last thing every run did, which made it exactly where a run died when it ran out of budget: one executor was stopped partway through its gate after 319,915 tokens.

  Executors now verify the surface they changed and submit. A submission whose verify command does not match the one the ticket declared is refused, so the scoped run cannot quietly become something else. The full suite runs once, on the merged tree, where it is the only place it means anything.
- Ticket authoring: establish the premise, and ask for behavior instead of a test count (SQ-1382)
  Two authoring rules, from watching the same mistake in two costumes: asserting instead of establishing, with the executor paying for it.

  An orchestrator filed a fix whose premise was a number it had never measured. Two executors in a row released with `contradiction`, each having done the work to show the premise was false. The measurement, run afterward, found the effect had the opposite shape. A claim a fix depends on now needs the command, its output, and where it ran, or a link to the read-only ticket that established it. Unmeasured means file the measurement first. A warning fires at add and at dispatch, and stays quiet when the evidence is cited or linked.

  The second rule is about coverage. Asking for "one test per fix" asks for a count, and a count is trivially satisfied by a golden that asserts bytes did not move. Tickets now state the behavior that must keep working, the input that would expose a break, and what a useful failure should identify. As many assertions as the contract needs, and no ceremony.

## v3.400.0 (2026-08-06)

### sidequest 4.34.0 → 4.35.0

#### Features

- The repeat-dispatch breaker stops counting correct pauses as failures (SQ-1340)
  Dispatching a ticket a third time was blocked with a diagnosis the board had never established: "Environment visibility is the leading hypothesis." It said that on every no-commit repeat, regardless of what the prior attempts actually were.

  The cause was one layer below the message. Release validation checked the kind and then dropped it: `scope_pause` and `handback` were accepted, confirmed valid, and returned as an empty result, so they never reached the attempt record. The breaker had nothing to discriminate on, so it counted every terminal attempt with no commit as a failure. A scope pause is the board working as designed, and it was accumulating toward a block.

  The validated kind now travels with the release, onto the terminal attempt, along with its reason and evidence. Scope pauses and handbacks no longer count toward the breaker at all. When it does block, it names the recorded attempts and their causes instead of asserting one hypothesis, and it only claims a worktree-shaped failure when the attempts carry that shape.

  Found the hard way: this ticket was blocked from dispatching by its own breaker, with the exact wrong diagnosis it exists to remove.
- Wrong anchors are caught when written, not when an executor hits them (SQ-1371)
  An anchor that points at a file or symbol that does not exist was only discovered by the executor, after it had already paid for a worktree, a briefing, and the reading it took to find out. The ticket looked fine on the board the whole time.

  Anchors are now checked at write time, so a bad one surfaces to whoever is filing the ticket while it is still cheap to fix. Executors are also told plainly that an anchor they find wrong can be corrected rather than treated as gospel or worked around.
- A scope pause no longer destroys the worktree it paused in (SQ-1377)
  An isolated worktree is removed when its agent finishes without changing anything. An executor that asks for scope before its first edit and then ends looks exactly like that, so the whole run is swept: one measured case cost 246,657 tokens for zero output, and the scope grant landed seconds after the executor gave up.

  There is no cheap recovery once the process ends. A held claim makes it look like the work survived, and it has not. So the fix has to land before the pause, not after it: requesting scope from a clean isolated worktree now writes an empty marker commit first, which is enough to stop it reading as untouched.

  The tests here cover our side, that the marker is written and the retention recorded. Whether the runtime sweeper spares a worktree whose only change is an empty commit is not something a test in this repo can observe. Every worktree carrying a real commit has survived so far, which is the evidence this rests on.
- Test assertions that measured the wrong thing become measurements (SQ-1380)
  Three assertions were shaping the code around numbers nobody had chosen deliberately.

  The MCP `tools/list` payload had a 17,500-byte ceiling written as a literal in our own test, and the payload was sitting 17,492 bytes: eight bytes of headroom. Two executors were told that ceiling was a real protocol constraint and spent effort contorting schemas to fit under it. It is now a reported measurement against a recorded baseline, so a size change is visible without being a failure.

  The CLI goldens compared a byte count and a sha256. A diff on those tells a reviewer nothing except that something moved, so the only available response was to regenerate them. They now assert the substrings the output must contain, which is the thing anyone actually cared about, and stay strict where the old golden was strict: an error case still has to print nothing to stdout.

  The hook latency test gated on absolute wall-clock ceilings, which cannot mean anything on a hosted runner shared with other work. It reports its numbers now. A hook that crashes still fails the test, because every sample asserts its exit status.

#### Fixes

- Regressions for the board API papercuts that had no coverage (SQ-1378)
  The four remaining papercuts from the earlier API pass turned out to be already fixed, with nothing asserting them. They have regressions now: MCP rejecting unknown parameters instead of silently ignoring them, `list` returning `verify` while keeping `executorVerify` for older callers, and `profile get` working as a CLI action with unknown actions failing loudly.

## v3.399.0 (2026-08-06)

### sidequest 4.33.0 → 4.34.0

#### Features

- Board API errors name the call that would have worked (SQ-1336)
  A batch of small API defects, each measured costing real retries across three consumer boards.

  `link` wanted `{from, verb, to}` and refused every natural guess with a bare `bad_type` that named neither the valid verbs nor the expected shape: 14 consecutive failures in ten seconds on one board, eleven more across four days on another, twice abandoned for the CLI. The MCP path now names the verbs and the parameter shape, the way the CLI already did. Inverting a dependency no longer requires removing both directions first; `link` replaces an existing opposite-direction edge.

  `groomClose`, `release`, and `done` revealed their requirements one refusal at a time, turning ten closures into roughly 25 tool calls. A refusal now lists every determinable missing parameter and flag at once.

  There was no way to read a single ticket, so an orchestrator piped whole-board JSON through filters 37 times. `sidequest show <ref>` returns one ticket in full.

  Story-log entries were refused past 280 bytes by a storage-side cap, while a separate cap already bounded what reaches an executor prompt; 22 refusals were observed. Storage is now generous and the briefing cap does the bounding, matching how comments already work. `--rotate` also refused the very `--by orchestrator` its own test passed, because the guard read a resolved default instead of the parsed option.

## v3.398.0 (2026-08-06)

### sidequest 4.32.0 → 4.33.0

#### Features

- Scope a new source file implies is granted without a round trip (SQ-1341)
  Scope-expansion round trips stalled executors on 17 distinct tickets across two boards in a week, and the overwhelmingly common request was for a file the work already in scope mechanically requires. A round trip is not cheap: an executor that pauses before its first edit loses its worktree when its process ends, so the whole run is unrecoverable. One measured 163k tokens for zero output.

  The recurring case: an executor extracts code into a new source file that IS in scope, then stalls because a new file cannot build without its build-registration entry. On Terge_VST that was `CMakeLists.txt`, and it cost two of one ticket's four attempts. That is not a judgement call and it is not scope creep.

  A scope request for the build-registration file governing a directory already in scope is now granted automatically, with a comment attributing the grant to the derived rule. The governing file is found by walking up from the in-scope source: `go.mod` for Go, `Cargo.toml` for Rust, `CMakeLists.txt` otherwise, plus barrel and re-export files. Only the single file the walk finds is granted, never a pattern, and if no governing file is found the request stays pending for a human.

  This is derived from the repository rather than configured, on purpose. The mechanism for turning knobs like this on has existed for weeks and the boards that needed it never got it, so a rule that requires a maintainer to pre-declare `CMakeLists.txt` would not have helped anyone.

  Boards can additionally opt into `autoApproveScope` glob patterns for cases that are not derivable, with mixed requests split so matching paths are granted and the rest stay pending. A repeat request identical to the current pending one returns that request with its age instead of firing again.

## v3.397.0 (2026-08-06)

### sidequest 4.31.0 → 4.32.0

#### Features

- A parked ticket cannot be restarted by a dispatch nobody made (SQ-1333)
  A ticket on another board was parked deliberately: status todo, no claim, dispatch released. A fifth dispatch was then prepared and claimed 23 seconds later with `agentId: null` and `boundAt: null`, with no orchestrator involved. The session's own account of it: "I didn't launch it. So the break I described didn't actually hold, and that's on the board's behavior, not something I chose."

  The forensics ruled out the obvious suspects rather than guessing. Sweeps only expire and release, and the recovery path was `recovery: null`, so neither prepared it. The transcript carries no dispatch tool use anywhere in the surrounding fifteen minutes while the record carries that session id. What remains is an un-attributed dispatch invocation followed by a claim accepted before any runtime identity existed to bind it to.

  Dispatch records now carry `preparedBy`: which session, and which surface prepared them. That turns the next investigation of this shape from an afternoon into a few minutes. Isolated claims require an existing agent binding rather than accepting a null one, so a claim can no longer attach itself to a dispatch that has no live executor behind it.

  The same null-binding pattern is what made scope requests on that board die `worktree_unavailable` all session.

## v3.396.0 (2026-08-06)

### observability 0.3.1 → 0.3.2

#### Fixes

- The real-Collector tests run in CI again, without downloading inside the test (SQ-1375)
  Two tests check that our generated collector config is accepted by the actual pinned Collector binary, and that it converts delta sums and forwards gateway usage logs. They are the only tests that catch our config drifting away from what the real binary accepts; everything else validates our config against our own expectations.

  They had been fetching that binary over the network from inside the suite, within a 30 second per-file budget, which intermittently timed out and turned main red. The previous fix removed CI from the condition that enables them. The flake went away and so did the coverage: they now skip everywhere unless a developer sets `WORKBENCH_OTELCOL_CONTRIB` by hand, which in practice is never.

  CI now provisions the pinned Collector as a workflow step, cached on the runner and keyed by version, and exports `WORKBENCH_OTELCOL_CONTRIB` for the observability job. The tests find a configured binary, skip the download path entirely, and finish well inside their budget. The download helper stays for local use.

  The cache key is derived from `COLLECTOR_VERSION` rather than written out. A hardcoded version would keep hitting the cache after a bump, find the old binary already present, skip the download, and quietly check the config against the wrong Collector.

## v3.395.0 (2026-08-06)

### sidequest 4.30.0 → 4.31.0

#### Features

- A dispatch that correctly changes nothing can now close itself (SQ-1339)
  A routed write dispatch that legitimately ends with nothing to commit had no legal way to close. `done` refused with `submission_required`. `submit` refused as `outside_scope` against the stale dispatch base. Pinning base equal to commit to prove emptiness refused as `empty_range`. The executor's only remaining move was to ask a human: "Someone with grooming/orchestrator authority needs to close this one manually."

  The surrounding refusals did not help either. Five separate runs hit "has routed dispatch history. Executors cannot close released repository work" without being told what they SHOULD do instead.

  `done` now accepts a routed write dispatch whose tree is clean since the dispatch base, recording the closure with explicit no-op evidence so grooming sees the truth rather than a fabricated change. `submit` gains an explicit no-op form that records an empty submission instead of refusing an empty range, for flows where the orchestrator wants something to integrate against. Refusals in this family now name the next legal action for the holder, and say what the orchestrator will do.

  The clean-since-base check shares delta semantics with shared-tree attribution, so a sibling executor's uncommitted work in the same tree does not block a no-op closure.

## v3.394.0 (2026-08-06)

### sidequest 4.29.0 → 4.30.0

#### Features

- A dispatch that cannot possibly work in a worktree now says so before it runs (SQ-1364)
  Some projects structurally cannot use linked worktrees. A docker stack that bind-mounts the main checkout will never see the worktree as the running app, and a project whose corpus is gitignored sees an empty directory there. Nothing detected either shape, so every new orchestrator rediscovered it the same way: by dispatching, watching the executor fail on a missing app, diagnosing it, and re-dispatching into the main checkout. One such round trip measured 3m55s and 80.8k tokens.

  The mechanism to turn worktree isolation off has existed since 2026-07-25. Two boards that needed it never got it, which is the recurring failure where a mechanism ships and the configuration step that makes it useful does not.

  Dispatch now checks for the shape before spawning and warns in the result, naming the likely failure and the one-line fix, when an isolated dispatch targets a repository that a compose or docker file bind-mounts, or whose declared paths are gitignored. Worktree isolation is also surfaced in the orchestrator-facing board summary so it is visible when planning a wave rather than buried in CLI help.

  The setting is not flipped automatically. Guessing wrong strands an executor in the shared tree, which is worse than the problem being solved, so the board warns precisely and leaves the decision to a human or orchestrator.

#### Fixes

- Hook tests no longer read whichever plugin version happens to be installed (SQ-1376)
  Hooks resolve their runtime store from `CLAUDE_PLUGIN_ROOT`. Spawned-hook tests did not pin that variable, so they inherited whatever the surrounding session had set, which in a Claude Code session is the INSTALLED plugin cache rather than the repo under test. The suite then exercised the installed version's code and reported on it as if it were the working tree.

  This turned a green suite into a coin flip that depends on which plugin version the developer has installed. Running the same commit with `CLAUDE_PLUGIN_ROOT` pointed at an installed 4.24.0 produced a failure in `quota-fallback.test.ts` that vanished the moment the variable was unset, with no code change in between. It also blocked the `integrate` preflight, which inherits the variable from the MCP server: four verified submissions had to be merged by hand because the preflight kept failing a test unrelated to any of them.

  The spawned-hook test setup now pins the plugin root to the repo, and an assertion fails the suite if any hook resolves a runtime outside it, so a leaked environment is a loud failure instead of a silently wrong result.

  Whether `runtimeModule()` should refuse a mismatched plugin root in production, rather than only in tests, is deliberately left open and tracked separately.

## v3.393.0 (2026-08-06)

### sidequest 4.28.0 → 4.29.0

#### Features

- Shared-tree submissions attribute changes to the run that made them (SQ-1328)
  On boards that cannot use worktrees — BMR bans them, contractify must share because its docai container mounts the main checkout — the submit and done gates evaluated the whole dirty working tree. An executor was therefore blocked by its siblings' in-flight edits and by anything the user had left lying around. On 2026-07-31 all three executors of a BMR wave hit `unscoped_paths` and none of them could ever have submitted; nothing an executor could do would have helped.

  4.23.0 covered the half a launch-time snapshot can see: paths already dirty when the run started are exempt while their content is unchanged. This covers the half it cannot, a sibling's edits landing during the run, by attributing changes to the dispatch delta and the submitted range rather than to whole-tree state.

  Refusals on both entry points now name what the executor can actually act on, since a refusal improved on only the MCP handler or only the CLI leaves the other quietly unchanged.
- Executor worktrees fork from the branch you actually integrate into (SQ-1334)
  Worktrees forked from `origin/main`, so on any board where the user does not push, every executor started from a stale tree. Cantizans, 2026-07-31: origin was 15 commits behind local main, one executor's worktree was missing directories three delivered tickets had created, and that run was wasted outright. Setting `integrationMode: local` did not change the fork point, which made the setting a lie.

  Dispatch now syncs the worktree to the configured local integration branch, so `integrationMode: local` means what it says and an executor starts from the tree its work will be merged into.
- Planning warnings stop crying wolf on greenfield boards (SQ-1358)
  On Terge_VST, a greenfield project, ticket writes produced 22 warnings the orchestrator knew were wrong and dismissed every time: 12 saying declared file scope does not exist in the repo, 6 about a verify command changing to a directory that does not exist, and 4 stamping a category without reading the taxonomy. A warning dismissed 22 times has stopped being a warning.

  The scope and verify-path warnings now account for paths a ticket is about to create, which is the normal case on a new project rather than an error. The taxonomy warning was a straight false positive: it tracked process-local state in the MCP layer, so it fired regardless of whether the taxonomy had been read.
- Ending a turn no longer counts as an executor dying (SQ-1374)
  `SubagentStop` fires when a background agent ends a TURN, not when it is gone, and a background executor ends a turn every time it reports or waits on a ruling. The board read that as an observed death: the claim was auto-released and the dispatch went terminal, which also cleared the dispatch token a resumed executor needs in order to submit.

  One ticket produced all four consequences in a single run. The executor ended a turn to ask for scope, so the board marked it died. A steer back to it was refused as "already died" and became a comment the agent never saw. A replacement dispatch could not claim, did nothing, and cost 38.6k tokens. The original resumed, finished the work, verified it green, and was then auto-released before it could hand in, forcing a manual integration.

  A turn boundary is now recorded as a turn boundary. Auto-release requires a recorded terminal Agent failure, the kind 4.28.0 started observing from `PostToolUseFailure`. Pulse reports such an executor as waiting and says plainly that it may resume and must not be re-dispatched or released without that evidence, and a steer is refused only for a real terminal failure.

## v3.392.0 (2026-08-06)

### observability 0.3.0 → 0.3.1

#### Fixes

- The observability suite stops downloading a Collector mid-test on CI (SQ-1373)
  Two tests validated our generated config against a real OpenTelemetry Collector, and they ran only on CI, where no binary is configured — so each run fetched one over the network inside the suite's 30-second per-file budget. It timed out intermittently, turned main red, and through the publish guard that blocked releases for plugins nobody had touched.

  They now run only when `WORKBENCH_OTELCOL_CONTRIB` names a binary. The suite passes four consecutive runs in about two seconds.

  This trades the flake for the coverage: on CI those two tests now skip. SQ-1375 restores them properly, by provisioning the pinned binary as a cached workflow step so the test finds it instead of downloading it.

## v3.391.0 (2026-08-06)

### sidequest 4.27.0 → 4.28.0

#### Features

- A dispatch that dies without a stop notification is now recorded (SQ-1356)
  4.16.0 records a `died` outcome from SubagentStop and the SessionEnd reconcile. A context-overflow death reaches neither: the agent is killed API-side mid-turn, so nothing stops and nothing reconciles. The board keeps showing a healthy claim on a corpse.

  It happened twice on this board while the ticket was open. SQ-1337's executor posted `[sidequest:verify-complete]` and then terminated with "Prompt is too long"; afterwards the dispatch still read `claimed`, `terminalAt` was null, and `claim.reclaimable` was null. Its finished work sat uncommitted in a worktree, found only because the harness told the orchestrator directly.

  The signal was already arriving and being ignored: `PostToolUseFailure` on `Agent` fires for exactly these failures, and the quota-fallback hook already parses the ref, the dispatch token, and the project out of the briefing prompt before returning early on anything that is not a quota error. A terminal Agent failure now records a `died` outcome through that same identity, so the claim becomes reclaimable and the sweep can act.

  Classification is deliberately narrow — context overflow, max tokens, and terminal agent shapes only. An error that cannot be classified confidently records nothing, because a missed death is recoverable by hand and a false death releases live work.

## v3.390.0 (2026-08-06)

### sidequest 4.26.1 → 4.27.0

#### Features

- Verify commands are validated when recorded, not at integrate time (SQ-1331)
  Stored verify commands were never checked, so garbage surfaced at integrate — the worst possible moment, after an executor had already spent its run. On the-bot-resurrection 23 distinct tickets hit `verify_failed` at integrate and 6 hit `replay_failed`, over shapes like prose pasted into the verify field feeding pytest a bare `-;`, a `<scratchpad>` placeholder that cmd.exe parsed as redirects, and chained suites whose runner received a stray `;` fragment.

  Malformed verify commands are now rejected where they are written, with the problem named, so the ticket is fixed before anyone is dispatched against it.
- Integrate verifies the merged result and rolls back a bad merge (SQ-1332)
  Integrate ran its verify as a preflight against the PRE-merge tree, so whole classes of legitimate ticket could never pass: a greenfield ticket whose verify target is created by the merge (six bare `verify_failed` results with no explanation on midi-to-score), a ticket that adds the very tool its verify invokes, and any ticket whose job is fixing a red main — its verify is guaranteed to fail before its own fix lands.

  Verification now runs after delivery, against the tree that will actually exist, and a post-merge failure rolls the merge back rather than leaving it in place. Both entry points are covered: the MCP handler and the CLI command, which would otherwise have silently kept the old behaviour on whichever one was missed.
- The full suite stops thrashing when several run at once (SQ-1345)
  The parallel-first dispatch directive and the heavy full gate worked against each other. Every executor ends its ticket by running the same expensive suite at whatever moment it finishes, and that suite spawns real git init, worktree, and push operations plus temp directories. With three executors live the box carried 123 node processes, and runs interfered with each other's fixtures.

  The suite now isolates its shared resources per run, so concurrent invocations no longer contend for the same temp roots and fixture remotes.

  This ticket demonstrated its own thesis on the way in: its first submission could not verify because the full gate timed out under exactly the contention it exists to fix. Held rather than force-integrated, it passed 844/844 once the box was quiet.

#### Fixes

- Hook latency gate declines to judge a busy machine (SQ-1372)
  4.23.1 made the ceilings absolute and asserted them only off hosted runners, reasoning that the local box is the calibrated machine. That holds for a quiet local box and fails for a busy one: with three executors running, SessionStart "failed" at 744.6ms against its 500ms ceiling while a bare `node -e ''` took 535.8ms against a 40ms idle reference. The sample described the load.

  An overloaded run now reports its numbers and asserts nothing, saying so plainly: `(machine busy, process start 535ms vs 40ms idle: reported, not asserted)`. This is not 4.22.1's approach of scaling the budget by that same control, which flaked anyway because the hooks are I/O-bound and process start is not. Declaring a sample invalid is a different claim from stretching a threshold until it fits.

  Neither guard subsumes the other. A hosted runner asserts nothing because its I/O is unpredictable even when its CPU is idle — the run that proved it had a healthy 46ms control and a 1478ms p95. A loaded local box asserts nothing because the control itself proves the contention. What remains is the case the budgets were written for: a quiet local machine.

## v3.389.0 (2026-08-06)

### sidequest 4.26.0 → 4.26.1

#### Fixes

- Declared hook sources grant their compiled output (SQ-1344)
  4.13.0 made a declared source path grant its compiled twin, derived from the build script rather than configured by hand. Hooks were left out: `packageBuildOutputs` discovers a package's outputs by looking for `nonBundledBuildDirectories`, `--outdir` flags, and `outdir:` keys, and `buildHooks` writes an `outfile` instead. So a ticket declaring `plugins/sidequest/src/hooks/` never got `plugins/sidequest/hooks/`, and every hook change had to stop and ask for scope on its own build output. SQ-1327 hit it live.

  The discovery now recognises the `outfile` shape too, so `src/hooks/x.ts` pairs with `hooks/x.js`. The pairing stays flat and stays one-way: `src/hooks/shared/**` is bundled into each hook rather than emitted, so it is deliberately not paired, and declaring compiled output still does not grant its source.

## v3.388.0 (2026-08-06)

### codebase-mapper 2.13.0 → 2.14.0

#### Features

- codebase-mapper ships its map-state writer instead of describing it (SQ-1360)
  update-codebase-map asked the model to rewrite `.map-state.json` with today's date, the current commit, the document list, and SHA-256 hashes of every document's exact final bytes. That is mechanical work described in prose, so every workspace wrote a script for it and got to reintroduce the same bugs. On Terge_VST the orchestrator wrote its own `write-map-state.js` and invoked it twelve times, hand-patching a hardcoded document list as documents changed.

  `plugins/codebase-mapper/scripts/write-map-state.js` now ships with the plugin, taking `--project <dir>` the way live-rules' `sync-atomic-rules.js` does. It discovers documents from the map directory rather than a hardcoded list, reads the current commit (null outside a repository), and replaces the state file last. Both map skills invoke it instead of describing the computation.

### sidequest 4.25.0 → 4.26.0

#### Features

- A scope-request timeout can no longer discard verified work (SQ-1370)
  An executor on contractify held a verified commit, could not submit because of a file it had never touched, filed a scope request, and released the ticket to todo when that request timed out. The commit survived only because someone went looking for it, and the steering that arrived moments later landed on a released ticket.

  Releasing is the one move that throws work away: it clears the claim, invalidates the dispatch token, and drops the ticket back into the ready pool where a fresh dispatch starts over on a tree that already holds the work. So `releaseTicket` now refuses when a scope request is unresolved and the run has work in hand, naming the commit and pointing at `checkpoint`. Work in hand is evidence rather than a guess: a checkpoint commit, a submission commit, or scoped commits past the dispatch baseline, read through the same `scopedWorkPending` and `dispatchDelta` the done-no-op path already used.

  Two things deliberately unchanged. A run with genuinely nothing to hand in still releases cleanly. And the claim sweep still auto-releases a dead executor holding a pending scope request — it carries its own liveness evidence and is not a scope timeout, which is a distinction the guard keeps and a test pins.

  Executor guidance now matches what the store enforces: a `timeout` ruling is a wait, so checkpoint and hold with a commit and say which ruling is pending.

## v3.387.0 (2026-08-06)

### codebase-mapper 2.12.3 → 2.13.0

#### Features

- Workspace rule templates stop producing a permanent manifest mismatch (SQ-1359)
  Two defects that hit every workspace `init-workspace` sets up, both found the hard way on Terge_VST.

  The live-rules reference doc's example manifest entry omitted `priority` and `include`. `sameManifestEntry` compares a missing `priority` as 0 against the rule's actual 95, so every entry written from our own template mismatched, and the workspace got a manifest-mismatch warning injected on every prompt. The template now carries the fields the comparison reads.

  Hashes were computed over raw bytes, so a CRLF checkout of the same rule file hashed differently from an LF one and the manifest never matched. Both live-rules and codebase-mapper now normalize line endings before hashing, which also means a map or manifest built on one platform still verifies on another.

  Fixture hook spawns in the live-rules tests now pin `CLAUDE_PROJECT_DIR` to the fixture directory. The hooks prefer that variable over the fixture cwd, so 13 tests read the real repository's rules and failed whenever it was set — invisible in CI, which never sets it, and a phantom red for anything run from inside a session.

### live-rules 2.9.1 → 2.10.0

#### Features

- Workspace rule templates stop producing a permanent manifest mismatch (SQ-1359)
  Two defects that hit every workspace `init-workspace` sets up, both found the hard way on Terge_VST.

  The live-rules reference doc's example manifest entry omitted `priority` and `include`. `sameManifestEntry` compares a missing `priority` as 0 against the rule's actual 95, so every entry written from our own template mismatched, and the workspace got a manifest-mismatch warning injected on every prompt. The template now carries the fields the comparison reads.

  Hashes were computed over raw bytes, so a CRLF checkout of the same rule file hashed differently from an LF one and the manifest never matched. Both live-rules and codebase-mapper now normalize line endings before hashing, which also means a map or manifest built on one platform still verifies on another.

  Fixture hook spawns in the live-rules tests now pin `CLAUDE_PROJECT_DIR` to the fixture directory. The hooks prefer that variable over the fixture cwd, so 13 tests read the real repository's rules and failed whenever it was set — invisible in CI, which never sets it, and a phantom red for anything run from inside a session.

### sidequest 4.24.0 → 4.25.0

#### Features

- Worktree sweep gets quieter, remembers, and surfaces orphan branches (SQ-1337)
  The session-start worktree sweep injected noise into unrelated sessions and retried impossible deletions forever, while staying silent about the one thing worth saying. Across the-bot-resurrection sessions it made 38 injections naming seven unrelated projects and cost roughly 300 tokens prepended per session; les-undetectables saw 8 budget overruns from it.

  Four changes:

  - Sweep reporting is scoped to the session's own project instead of every board sharing a Sidequest home.
  - A deletion that fails for a permanent reason is remembered in sweep state rather than retried on every session start.
  - A worktree owned by another live session is skipped, tracked through a registered-session file that SessionStart writes and SessionEnd clears.
  - Orphan worktree branches, the thing a sweep is actually well placed to notice, are surfaced with their subject line, capped so a large backlog cannot flood the report.

  Delivered by orchestrator recovery: the executor verified green and then died at max_tokens before it could commit, so the work was recovered from its worktree and re-verified on the merged result.

#### Fixes

- Verify commands may run from the repository root (SQ-1357)
  The verify-command validator demanded `cd <repo-relative-dir> && <command>` and rejected commands that legitimately run from the repository root. On Terge_VST it refused three `add` calls in a row, each re-sending a multi-kilobyte ticket payload, over `cmake -S . -B build && cmake --build build && ctest --test-dir build` — a command whose paths are already root-relative and which a cosmetic `cd .` does nothing for.

  A root-relative command is now accepted as written. The rule it was actually protecting stays: a command that depends on a subdirectory still has to say so.

### workbench 0.80.1 → 0.81.0

#### Features

- Workspace rule templates stop producing a permanent manifest mismatch (SQ-1359)
  Two defects that hit every workspace `init-workspace` sets up, both found the hard way on Terge_VST.

  The live-rules reference doc's example manifest entry omitted `priority` and `include`. `sameManifestEntry` compares a missing `priority` as 0 against the rule's actual 95, so every entry written from our own template mismatched, and the workspace got a manifest-mismatch warning injected on every prompt. The template now carries the fields the comparison reads.

  Hashes were computed over raw bytes, so a CRLF checkout of the same rule file hashed differently from an LF one and the manifest never matched. Both live-rules and codebase-mapper now normalize line endings before hashing, which also means a map or manifest built on one platform still verifies on another.

  Fixture hook spawns in the live-rules tests now pin `CLAUDE_PROJECT_DIR` to the fixture directory. The hooks prefer that variable over the fixture cwd, so 13 tests read the real repository's rules and failed whenever it was set — invisible in CI, which never sets it, and a phantom red for anything run from inside a session.

## v3.386.0 (2026-08-06)

### sidequest 4.23.1 → 4.24.0

#### Features

- Two guards stop reading progress as failure (SQ-1369)
  Both of these mistook "in progress" for "abandoned", which are opposite situations wanting opposite responses.

  The repeat-failure breaker refused a third dispatch with "two prior terminal dispatches without a commit" when attempt 2 had read its environment fine, reproduced every anchor, run the gate, committed, and checkpointed before running out of runway. It only skipped attempts whose outcome was `submitted`, so a checkpoint carrying a real commit still counted as a failure, and its environment-visibility remedy pointed at a hypothesis that attempt had already disproven. A terminal attempt now records the commit it produced, from the checkpoint or the submission, and an attempt carrying one is not a no-commit attempt.

  The Stop reminder read a running wave as unfinished business. Its exemption for live work required the dispatch's session id to match the session being reminded, and those diverge across a long orchestration, so an executor mid-run turned into "1 ticket still open. Update or close them before finishing" three times in one night. A ticket held by a claim that is not reclaimable, behind a dispatch that has not gone terminal, is now in progress regardless of which session prepared it. A direct claim with no live dispatch behind it is still the session's own to close and keeps its reminder, and pending submissions and scope requests are surfaced as before.

## v3.385.0 (2026-08-05)

### sidequest 4.23.0 → 4.23.1

#### Fixes

- Hook latency budgets assert only where they are calibrated (SQ-1368)
  4.22.1 scaled the hook latency ceilings by a measured process-start control so a slower runner got a bigger budget. It flaked again on the next run: SessionStart came in at 1478ms p95 against a 1161ms scaled tail with the control reporting a healthy 46ms median. The hooks are I/O-bound and the control is not, so process-start time says nothing about how long an unlucky SQLite read takes on a shared VM.

  What this test protects is wall-clock on a developer's machine, so the ceilings are back to absolute numbers and are asserted only where they mean something. A hosted runner measures and reports the same figures as diagnostics without asserting them. The release gate is unchanged and unweakened: `cut.mjs` runs this suite locally before every cut, against the same ceilings it always used.

## v3.384.0 (2026-08-05)

### sidequest 4.22.1 → 4.23.0

#### Features

- Shared-tree submissions stop gating on inherited working-tree dirt (SQ-1367)
  A shared tree is the user's own checkout, so it can already hold work that has nothing to do with the run. The submit gate treated every dirty path as the executor's: on contractify a screenshot the user had dropped in the repo root blocked a verified submission, the executor filed a scope request nobody could usefully rule on, the request timed out, and it released SQ-95 to todo with commit 8f5c22d9 still sitting there. The orchestrator's steering then arrived after the release and had to be recorded instead of applied.

  Every shared-tree dispatch now records what was already dirty at launch, with the same content-aware identity the artifact baseline uses. At submit, a reported out-of-scope path is exempt when its content is unchanged since that snapshot, and the exempted paths are recorded on the submission as `inheritedPaths`. Touching an inherited path puts it straight back under the gate, so this exempts what an executor found, never what it wrote. An unrecordable baseline means no exemption rather than a refused dispatch.

## v3.383.0 (2026-08-05)

### sidequest 4.22.0 → 4.22.1

#### Fixes

- Hook perf ceilings calibrate to the machine running them (SQ-1366)
  The hook latency budgets were absolute wall-clock numbers set on one Windows box, so on a hosted runner they measured the runner. SubagentStart came in at 1088ms p95 against a 750ms ceiling with nothing wrong in the hooks, and the same test had passed on the commit before it.

  Each measurement already timed a bare `node -e ''` alongside the hook and never used it. That control is now the calibration: the budget stretches by however much slower process startup is than the 40ms reference. The tail assertion moved to twice the median budget, because a p95 over 20 samples is the second-slowest run and one descheduled process owns it. A hook that starts doing real work moves its median, which is where the signal was all along.

## v3.382.0 (2026-08-05)

### sidequest 4.21.2 → 4.22.0

#### Features

- Test-scope auto-approval works in any repo layout (SQ-1365)
  Test-scope auto-approval now works in any repo layout. The detector was hardcoded to this marketplace's `plugins/<name>/test` shape, so every other project fell through to a full scope ruling: the executor stopped mid-run, the orchestrator woke up to approve `tests/`, and the round trip bought nothing that the commit-time scope check does not already catch. Terge_VST hit it three times in one session.

  A scope request is now auto-approved when every requested path sits in a test directory the ticket already reaches: an existing `test/`, `tests/`, `spec/`, `specs/`, or `__tests__/` beside a file the ticket declares, or beside any of its parents up to the repo root. A ticket owning `plugins/x/src/thing.ts` widens into `plugins/x/test/**`; one owning `src/synth.cpp` widens into the repo's `tests/**`; neither reaches the other's. The widening is recorded as a board comment and still reviewed at publish.

  The board flag is renamed `autoApproveTestScope` (`--no-auto-approve-test-scope`), and boards that explicitly set the old `autoApprovePluginTests` keep their setting.

## v3.381.0 (2026-08-05)

### sidequest 4.21.1 → 4.21.2

#### Fixes

- Temp cleanup recognises its own directories when an ancestor is aliased (SQ-1363)
  The worktree sweep and the temp-root cleanup were the last Windows CI failures, and they had a different shape from the earlier path bugs: the leaf directory matched fine, but an ANCESTOR of the temp root carried an 8.3 alias. Canonicalizing the path being examined was not enough when the root it was compared against was spelled the other way, so cleanup skipped roots it owned and the sweep failed to recognise its own candidates.

  Both now compare through the same canonicalization, and both carry a test that builds a real alias locally rather than relying on a hosted runner to expose it.

## v3.380.0 (2026-08-05)

### sidequest 4.21.0 → 4.21.1

#### Fixes

- Every worktree path comparison agrees on what a directory is called (SQ-1362)
  4.21.0 canonicalized worktree paths where the integration-advance code compares them, which fixed one family of failures and left the rest: commit and submit still refused an aliased worktree, and the sweeps still failed to recognise their own candidates. A directory reached by two spellings was still two directories to most of the code.

  The comparisons now run through one shared canonicalization instead of `path.resolve`, including the commit worktree-root check, which is the one that produced `worktree must name the git worktree root: C:\Users\RUNNER~1\...` while pointing at exactly the directory git had just named.

  The part worth keeping is the test. It builds a real 8.3 alias in the temp directory and drives a commit through it, so this class now fails on any machine instead of only on a hosted runner. It caught the incomplete fix immediately: the first round passed its own focused tests and still failed this one.

## v3.379.0 (2026-08-05)

### observability 0.2.2 → 0.3.0

#### Features

- Windows CI stops failing on paths that name the same directory twice (SQ-1353)
  Adding a Windows leg to CI turned up fourteen sidequest failures that pass on a local Windows machine, and they were all one bug. On the hosted runner git reports a temp worktree as `C:/Users/runneradmin/...` while Node keeps the 8.3 alias `C:\Users\RUNNER~1\...`. Those are the same directory, and `path.resolve` says they are not, so integration candidates looked ambiguous and shared-tree claims went unrecognised.

  Existing paths are now canonicalized before comparison, and every resolved drive root counts as protected rather than only the spelling the caller happened to use. This is production behavior, not a test accommodation: a machine whose temp directory carries a short-name alias was getting wrong answers about which checkout held a commit.

  Observability's Windows leg failed separately, on `EPERM` unlinking `otelcol-contrib.exe` while it was still locked. That one is genuinely test cleanup: the fixture now waits for the collector to exit before removing its runtime directory. It still runs a real collector and still proves it converted delta sums.

  None of this was visible from a developer machine. It took running the suite where it actually breaks.

### sidequest 4.20.1 → 4.21.0

#### Features

- Windows CI stops failing on paths that name the same directory twice (SQ-1353)
  Adding a Windows leg to CI turned up fourteen sidequest failures that pass on a local Windows machine, and they were all one bug. On the hosted runner git reports a temp worktree as `C:/Users/runneradmin/...` while Node keeps the 8.3 alias `C:\Users\RUNNER~1\...`. Those are the same directory, and `path.resolve` says they are not, so integration candidates looked ambiguous and shared-tree claims went unrecognised.

  Existing paths are now canonicalized before comparison, and every resolved drive root counts as protected rather than only the spelling the caller happened to use. This is production behavior, not a test accommodation: a machine whose temp directory carries a short-name alias was getting wrong answers about which checkout held a commit.

  Observability's Windows leg failed separately, on `EPERM` unlinking `otelcol-contrib.exe` while it was still locked. That one is genuinely test cleanup: the fixture now waits for the collector to exit before removing its runtime directory. It still runs a real collector and still proves it converted delta sums.

  None of this was visible from a developer machine. It took running the suite where it actually breaks.

## v3.378.0 (2026-08-05)

### sidequest 4.20.0 → 4.20.1

#### Fixes

- Generated executor definitions can write again (SQ-1361)
  A board using per-ticket generated executor definitions could not get an executor off the ground: three consecutive dispatches of the same ticket were refused on their first guarded write, zero lines written between them, while the orchestrator hunted a stale claim that was never there.

  4.17.1 taught the write guard to resolve a ticket from the dispatch's recorded `agentName` as well as its bound id. But a generated definition does not run under that name; it runs under a name derived from it, `a` + launch name + `-` + hash, so comparing the two for equality never matched. A single active ticket hid this, because an unowned actor falls back to the sole active ticket in the session. With two tickets live at once that fallback is correctly ambiguous, so every write was refused instead.

  Identity now accepts the derived form. The refusal for a genuinely unowned actor with several tickets in flight is unchanged, which is the borrowing case this guard exists to prevent.

  Worth recording for the next person: the first version of this fix's test passed against the broken code, because one active ticket let the fallback mask the failed match. It only reproduced once a second concurrent claim was added, which is exactly what the affected board had.

## v3.377.0 (2026-08-05)

### sidequest 4.19.0 → 4.20.0

#### Features

- A steer that arrives after the executor finished is kept, not lost (SQ-1355)
  Steering an executor that has just closed its ticket used to accomplish nothing. The teammate woke, the idle guard correctly refused to continue a terminal dispatch, and the instruction disappeared. The orchestrator found out by reading a transcript, and whatever it wanted to say had to be retyped somewhere durable.

  The race is unavoidable: the decision to steer is made from state that is already stale, and the executor can finish in between. So the message is now saved rather than merely detected. A `SendMessage` whose recipient resolves to a terminal dispatch writes the text to that ticket as an attributed comment, and the send is refused with the ticket ref, its outcome, and the next legal action: re-dispatch if the work itself has to change.

  Only recipients that resolve to a Sidequest dispatch are touched; ordinary teammate messages and steers to live executors pass through untouched. If the board cannot be read at all, the message is never blocked.

  This is the mirror of the scope-ruling delivery in 4.18.0, and the same principle decides both: the board is what survives, the mailbox is not.

## v3.376.0 (2026-08-05)

### sidequest 4.18.1 → 4.19.0

#### Features

- pulse shows the scope in force (SQ-1354)
  After granting scope, the obvious next question is whether the grant actually landed. `pulse` could not answer it: an orchestrator watching a wave had to shell out to `sidequest show <ref> --json` and filter the result through a python one-liner to read a ticket's files.

  `pulse` now carries a `scope` block: the file set commits are actually gated on, any pending request with the paths it asks for, and the last ruling with what it granted and refused. It is in the default compact read, not behind `detail`, because that is where the question gets asked. The declared list rides along only when it differs from what is enforced, which is exactly the case the existing scope-drift warning fires on.

## v3.375.0 (2026-08-05)

### sidequest 4.18.0 → 4.18.1

#### Fixes

- The running-agent line reads like a sentence instead of a debug tag (SQ-1352)
  A dispatched executor used to render as `sidequest-exec-dispatch([model=GPT-5.6 Terra effort=high] docai: emit dossiers_list blocks) claude-codex-auto`. It now reads `GPT-5.6 Terra, high · docai: emit dossiers_list blocks`.

  The trailing `claude-codex-auto` stays, and it is worth knowing why. That label is the Agent-call model resolved locally before launch; no provider response updates it, so for anything routed through the gateway it can only ever show the virtual id we dispatch with. Making it show the real backend would mean going back to one agent definition per model and effort combination, which was removed for good reason: the route marker overwrites their pinned effort anyway, leaving thousands of injected tokens per session describing configuration nothing reads.

  So the description is the only place the real route appears while a run is in flight, which makes a paraphrased one genuinely costly. The dispatch result now says so and tells the caller to copy `spawn.description` byte-for-byte.

## v3.374.0 (2026-08-05)

### sidequest 4.17.1 → 4.18.0

#### Features

- A scope ruling now reaches the executor waiting for it (SQ-1348)
  An executor that paused for a scope ruling had no way to learn the ruling arrived. It ended its turn, the orchestrator granted or denied seconds later, and the work sat frozen until someone noticed and hand-resumed the agent. That happened three times in a single session, each costing a stop, an orchestrator round trip, and a resume.

  `scopeRequest` now takes `wait: true` and returns the ruling on that same call: granted, partially granted, denied, superseded, or timeout, along with the effective scope it leaves in force. The wait holds no board lock, so rulings, commits, and other tickets carry on normally while it blocks. On timeout the request stays pending and the response says to checkpoint and name what it is waiting on. Briefings tell executors to always pass it.

  The first design gave this its own `scopeWait` tool, which recreated the original problem in miniature: a second call an executor can forget to make. Folding it into the request removes that possibility, and it also kept the MCP tool list inside its byte budget, which several published tool descriptions were trimmed to respect.

  When a ruling lands on a ticket whose executor has already stopped, `scopeDeny` and scope-resolving updates now name that ticket and agent and say to resume it, so the orchestrator is told rather than left to remember.

## v3.373.0 (2026-08-05)

### sidequest 4.17.0 → 4.17.1

#### Fixes

- Fix executors being refused every edit on boards using generated definitions (SQ-1351)
  4.16.0 made the write guard resolve a ticket from the acting agent's bound id and refuse rather than borrow a neighbour's scope. That was right for the case it fixed and wrong for two others, and it blocked a wave on a consumer board within a day.

  A per-ticket generated executor definition spawns under the dispatch's `agentName` as its own subagent type and never binds a runtime id, so matching on `agentId` alone found no owner and refused every write it attempted. Two executors on the same board failed identically, neither having touched a file. Identity now matches the dispatch's recorded name as well as its bound id.

  A helper spawned by an executor has the same problem from the other direction: its id belongs to no dispatch at all. It now inherits the sole active ticket in the session, which is unambiguous by construction. Two or more active tickets still refuse, which is the borrowing case 4.16.0 set out to stop.

## v3.372.0 (2026-08-04)

### sidequest 4.16.0 → 4.17.0

#### Features

- The test suite no longer needs a working gateway to pass, and CI runs on both platforms (SQ-1347) [`f5b4037`](https://github.com/Eigenwise/eigenwise-toolshed/commit/f5b40370)
  CI had been red on every sidequest push for two days and nobody in the loop saw it, because every gate we run — executor verify, integrate, and the release cut — runs on Windows, where all 823 tests passed.

  Eight of the nine failures were one bug: fixtures that had nothing to do with routing were reaching a live model-gateway readiness probe through `prepareDispatch`. A machine with the gateway installed passed; CI and any fresh clone did not. Those fixtures no longer depend on an external binary. The ninth was a path comparison that chose case-sensitivity from `process.platform` instead of from the path in front of it. All nine were test-only: no shipped behavior was broken for non-Windows users, and the Linux suite now passes 823/823.

  Two changes make the gap unrepeatable. The plugin CI matrix runs Ubuntu and Windows, matching where the code actually gets developed. And the release cut now refuses to publish when the parent commit's Test workflow has not passed, so a red main cannot quietly become a release; local test remotes skip that GitHub-only check.

  Reproducing CI locally turns out to be cheap: pipe `git archive HEAD` into a `node:22` container, `git init` inside it so `build:check` has a repository, then run the suite.

## v3.371.0 (2026-08-04)

### sidequest 4.15.0 → 4.16.0

#### Features

- A dead executor now says so (SQ-1327) [`fbc4e2d`](https://github.com/Eigenwise/eigenwise-toolshed/commit/fbc4e2d3)
  When a dispatched executor died mid-run, nothing on the board changed. The claim stayed live, `idleMs` counted up, and `pulse` reported `working: true` forever. On one board that meant an executor died right after posting BOOT and sat there for eighteen hours while a paid cloud pod kept billing, and another died before terminating its pod at all. The person watching became the death detector, and that board turned Sidequest off over it.

  A stop that leaves a live claim with no terminal board outcome now records a durable `died` outcome with its timestamp and last activity, from both the SubagentStop path and the SessionEnd reconcile. The orchestrator gets told which ticket died, when it went quiet, and what it left behind, instead of discovering it by hand-inspecting worktrees.

  `pulse` carries a real `liveness` reading rather than an idle counter that everyone misread as one. An active verify reads alive, because a verify-start with no verify-complete is positive evidence of a live process; waiting is reserved for a pending scope request or a steering hold; a stop observed during active verification records died. The repeat-dispatch breaker counts died rounds as the durable terminal outcomes they are.

  Briefings now tell executors to record billable external resources on the ticket as they create them and terminate them before any stop, including error paths, so a dead executor's cloud spend is reapable from the ticket thread.

  This one was written from a live specimen: the session running it crashed with four executors claimed, and every one of them sat at `working: true` with nothing to distinguish four dead processes from four thinking ones.
- Guards stop refusing work they were never meant to block (SQ-1330) [`0c4f680`](https://github.com/Eigenwise/eigenwise-toolshed/commit/0c4f6805)
  Two guards were firing on things that were never dangerous.

  The scope guard refused helper writes to the harness's own scratchpad, the directory executors are told to use for temp files. The observed workaround is the whole problem: an executor refused the scratchpad path, then wrote the identical script into the repository working tree two tool calls later. Scratchpad paths are now always writable, and single-file deletes there are allowed.

  The recursive-delete guard, added after a real `$home` wipe, had drifted into matching the user-profile path prefix rather than an actual recursive delete. It blocked a plain `grep -n`, three heredoc writes, and one `rm -f` of a single scratchpad file, deleting nothing in any of them. It now requires both a genuine recursive delete verb and a target resolving to the profile or `.claude` root. The original incident's commands still block, pinned by fixture.

  The third complaint in this batch turned out to be already fixed: the worktree isolation guard no longer intercepts Bash commands at all, so the 220 refusals across 110 executor sessions came from an older build. That one ships as a fixture pinning the current behavior, not a change.
- Removed a dispatch warning that was wrong 180 times out of 180 (SQ-1335) [`2d29cd1`](https://github.com/Eigenwise/eigenwise-toolshed/commit/2d29cd1e)
  Dispatch used to warn when a symbol named in a ticket "does not appear on main". On one board it fired about 180 times over seven dispatch rounds and was never once correct. It flagged a Sidequest comment id as a missing code symbol, which by construction can never appear in a repository. Two executors released their tickets over it, and the orchestrator ended up telling every executor in its spawn prompt to ignore the warning, because otherwise each one burned a turn re-verifying a false alarm.

  The check and its supporting machinery are gone, and a test pins them gone.

  A signal that is wrong every time is worse than no signal: it costs a turn per dispatch and it teaches people to ignore the channel that carries the true warnings too. This is the same call as the oversized-skill guard: mechanisms that ask an agent to predict get removed, mechanisms that verify a fact stay.

### workbench 0.80.0 → 0.80.1

#### Fixes

- init-workspace tells you to resume after a restart, not start over (SQ-1346)
  Setting up telemetry needs a Claude Code restart, and the skill used to send you back in with a fresh `/workbench:init-workspace`. That works, but it starts the skill over and makes it recover your answers from the bootstrap plan.

  It now asks you to come back with `claude --continue` instead, so the run keeps its own answers across the restart. The reload-boundary fallback says the same thing for the same reason.

## v3.370.0 (2026-08-04)

### sidequest 4.14.0 → 4.15.0

#### Features

- The write guard stops refusing an executor's own file inside its worktree (SQ-1329) [`30ea9dd`](https://github.com/Eigenwise/eigenwise-toolshed/commit/30ea9ddf)
  An executor working in its own linked worktree could have its own declared file refused, with the refusal naming a completely different ticket. The guard was comparing the full worktree-prefixed path against repo-relative declared scope, and when that failed to match it fell through to whichever ticket's scope looked closest. On one board that cost two dispatches released with zero files changed, plus the workaround that follows from it: re-dispatch with `sharedTree: true` and throw away isolation entirely.

  The guard now resolves exactly one active ticket from the acting subagent's bound `agentId`, and strips `.claude/worktrees/<any name>/` before comparing paths. An unbound identity is refused outright rather than borrowing another ticket's scope, so a refusal can no longer name a ticket the executor isn't working on.

  Tests cover the observed non-`agent-*` worktree name, two concurrent tickets staying isolated from each other, and the unbound refusal.

#### Fixes

- Pin that read-only executors keep their board tools (SQ-1338) [`2974fdf`](https://github.com/Eigenwise/eigenwise-toolshed/commit/2974fdfa)
  Two read-only executors on another board died at claim on 2026-08-01 with no board MCP tools reachable at all, and the workaround was to flip the tickets to writable and route them through the writing executor: changing what a ticket is allowed to do in order to dodge a plumbing problem.

  A live probe on current code settled it. A read-only executor claims fine today and sees the full board toolset. The August failure came from a short-lived allowlist that named board tools explicitly; SQ-1279 already replaced it with the deny-list shape, which restricts write, publish, and browser tools and leaves MCP attachment alone.

  What ships here is the guard against a repeat: a contract assertion that generated read-only definitions never deny a Sidequest board MCP tool. Read-only refers to the repository, never to the board.

## v3.369.0 (2026-08-04)

### workbench 0.79.0 → 0.80.0

#### Features

- Stale-plugin warnings stop eating your prompt (SQ-1342) [`8db3a54`](https://github.com/Eigenwise/eigenwise-toolshed/commit/8db3a543)
  When installed Toolshed plugins moved ahead of what a session had loaded, Workbench blocked the prompt: it echoed the text back and told you to reload. That fired seven times across four projects in a week, and one of those prompts carried an attached image, which the echo cannot return. The cost landed entirely on the person retyping.

  The prompt now goes through, carrying one session-scoped warning that the session is running stale plugin code and a reload is worth doing. One warning per session per version change, not per prompt. The blocking path is gone along with the automation and dev exemptions that existed only to soften it.

  Version drift almost never makes the current prompt unsafe to answer, so the advisory had no business being a gate.

## v3.368.0 (2026-08-04)

### sidequest 4.13.0 → 4.14.0

#### Features

- SharedTree briefings bind the working directory; dispatch warns when the session sits in a stale worktree (SQ-1325) [`291e166`](https://github.com/Eigenwise/eigenwise-toolshed/commit/291e166f)
  Spawned executors inherit the orchestrator session's working directory. When that session sits inside a stale leftover worktree (one the sweep cannot remove because a live session's cwd can't be deleted), every sharedTree executor starts its shell in the wrong tree. Observed on another board: an executor lost ~90 seconds discovering this, and the orchestrator resorted to hand-writing "cd here first, verify show-toplevel" prose into every dispatch message.

  The sharedTree briefing now carries that binding itself: the worktree-identity packet instructs the executor to `cd` to the shared checkout before any git or file operation, confirm `git rev-parse --show-toplevel` prints it, and stop and report if the mismatch persists rather than writing anything in the wrong tree. Isolated dispatches keep their existing self-check contract unchanged.

  Dispatch also gained a verifier: when the board server's own working directory lies inside a `.claude/worktrees/` path, the dispatch result warns the orchestrator that spawned executors will inherit a stale-worktree cwd, and the same warning reaches the executor's flagged-uncertainty packet. Detection only covers sessions launched inside a worktree; that partial coverage is deliberate, and it never blocks a dispatch.

## v3.367.0 (2026-08-03)

### sidequest 4.12.1 → 4.13.0

#### Features

- Declared source scope grants its compiled output, derived from the build itself (SQ-1320) [`ab07715`](https://github.com/Eigenwise/eigenwise-toolshed/commit/ab07715b)
  Sidequest compiles `src/` to tracked output under `lib/` and `bin/`, and every ticket had to declare both sides of that mapping by hand. Forgetting the compiled twin was the single most common scope miss: four incidents in one day, including a scope request naming a compiled path that does not exist because CLI modules land in `bin/`, not `lib/`.

  Declared scope now expands through one resolver: declaring `src/lib/store.ts` grants `lib/store.js`, with the mapping derived from the build script's own exported layout rather than a second hardcoded copy. The dispatch snapshot, commit enforcement, the completion tree check, and every scope-edit path read the same expanded set, so they cannot disagree.

  The expansion is one-directional on purpose. Along the way the executor found that the existing `generatedPairs` machinery quietly granted sources from declared generated output, the exact backwards grant that lets someone edit compiled files without their source; that inverse path is removed, and declaring `lib/store.js` alone no longer reaches `src/lib/store.ts`.

## v3.366.0 (2026-08-03)

### sidequest 4.12.0 → 4.12.1

#### Fixes

- Briefings teach the foreground-verify closeout (SQ-1324) [`762ffc3`](https://github.com/Eigenwise/eigenwise-toolshed/commit/762ffc33)
  Three executors in one day stopped mid-verify the same way: they backgrounded the long final suite, their bounded turn ended while waiting, and the claim sat in verify-marker limbo until someone resumed them by hand with the same instruction each time. That instruction is now in every dispatch briefing with a verify command: run the declared verify in the foreground with a timeout sized to the command, kill any earlier backgrounded verify first so two builds never race in one tree, and do the whole closeout (verify-complete marker, negative control, submission, final report) in that same turn. An assertion pins the line so a briefing refactor cannot drop it silently.

## v3.365.0 (2026-08-03)

### sidequest 4.11.0 → 4.12.0

#### Features

- Worktree invisibility is a pre-dispatch warning and a repeat-failure circuit breaker (SQ-1318) [`6c6ef61`](https://github.com/Eigenwise/eigenwise-toolshed/commit/6c6ef617)
  A dispatched executor's worktree holds tracked files only, so a ticket whose real work reads gitignored state (a data directory, local fixtures, an env file) dies the same environmental death on every attempt, and it presents as a vague failure rather than a missing-file error. One board burned three dispatches and 125k tokens on a single read-only ticket that way.

  Dispatch now warns up front: path-like tokens from the ticket's files, verify command, and description are tested with `git check-ignore`, and anything ignored AND absent from the tree gets named in a warning with the two remedies (`sharedTree: true`, or run it inline). Ignored-but-present paths like `npm ci`-installed `node_modules` stay silent, because a warning that fires on every JS ticket is noise that trains you to skip warnings. It stays a warning, never a refusal: the detection is heuristic.

  And a third dispatch after two durable terminal no-commit rounds is blocked, with environment visibility named as the leading hypothesis. Only durable terminal outcomes count — a still-claimed record whose stop hook never arrived proves nothing either way. `allowRepeatFailure` (CLI `--allow-repeat-failure`) overrides explicitly, and taking the override is recorded on the ticket.

## v3.364.0 (2026-08-03)

### sidequest 4.10.0 → 4.11.0

#### Features

- The oversized-skill guard is gone (SQ-1323) [`b12fa0e`](https://github.com/Eigenwise/eigenwise-toolshed/commit/b12fa0ee)
  The guard denied dispatched executors any bundled skill whose entry file crossed 256KB, pointing them at a targeted Read instead. In practice its one observed activation blocked a 262KB skill and the executor immediately pulled 278KB of the same material over WebFetch: a wasted turn and nothing prevented. A guard whose bypass is cheaper than its compliance doesn't shape behavior, it just adds friction and teaches executors that guards are noise. Removed outright, and the hook-registration test now asserts the Skill matcher stays gone.

## v3.363.0 (2026-08-03)

### sidequest 4.9.0 → 4.10.0

#### Features

- Scope requests fail open, resolve partially, and never desync the dispatch record (SQ-1321) [`d97b27d`](https://github.com/Eigenwise/eigenwise-toolshed/commit/d97b27d1)
  Every project running Sidequest was getting stuck on scope. Four incidents on the toolshed board in one day, plus a board where an unbound dispatch (`agentId: null, boundAt: null`) made every scope request fail `worktree_unavailable` for the executor and the orchestrator alike, on a live claim neither could fix.

  Four changes. The scope-request marker is now a best-effort recovery breadcrumb instead of a gate, so a request always files even when the worktree never bound. A files update by a distinct control-plane identity now rules on the pending request: requested paths inside the new scope are granted, the rest refused, with a comment naming both, so correcting one bad path in an otherwise good request no longer strands the run in a state where the request can neither be re-filed nor approved. `dispatch.declaredFiles`, which is what commit enforcement actually reads, now follows every successful files update and every denial, and `pulse` warns when a legacy record still diverges from the ticket. Denial comments state the scope actually in force instead of asserting it "remains unchanged" two lines under a ruling that changed it.

## v3.362.0 (2026-08-03)

### sidequest 4.8.0 → 4.9.0

#### Features

- Releasing a ticket as a contradiction now needs the probe and its output (SQ-1317) [`a23382d`](https://github.com/Eigenwise/eigenwise-toolshed/commit/a23382d1)
  SQ-1313 made technical blockers carry the failing command, its exit code, and its output. Contradictions carried nothing, which is backwards: "the ticket names something that doesn't exist" is an assertion about the world, so it's the claim that most needs showing rather than describing.

  It was wrong twice in one day. One release claimed a plugin was absent; another claimed `src/lib/store.ts` and its symbols were absent, having checked with an exact path glob, a directory glob, and a content search. A second executor on the same ticket and the same base found every file exactly where the ticket said and committed the work. Each incident cost a full dispatch cycle plus an orchestrator re-deriving the claim by hand to find it false, and in both cases one line of real output would have settled it in seconds.

  So `contradiction` now requires `command` and `outputTail` through the same shared validator technical blockers already use. `exitCode` stays optional here, because a glob that legitimately matches nothing exits 0 and demanding non-zero would just push executors into misreporting. `scope_pause` and `handback` still need no evidence.

## v3.361.0 (2026-08-03)

### sidequest 4.7.0 → 4.8.0

#### Features

- Completion is refused when a change's own tests pass against the pre-change code (SQ-1315) [`38da216`](https://github.com/Eigenwise/eigenwise-toolshed/commit/38da2167)
  A green suite proves nothing if the tests never touch the code that changed. SQ-1294 shipped 151 passing tests over a bug that was still there, and neither of the existing gates caught it: the diff wasn't empty and no blocker was claimed.

  So when a completion's in-scope changes include both test-side and non-test-side files, the claim holder now has to record a negative control: revert the non-test paths to the dispatch base, re-run the changed tests, and report `[sidequest:negative-control] <command> failed=<n>`. `failed=0` is a refusal, because tests that pass against the pre-change code aren't testing the change. Refactors and coverage-only work take `[sidequest:negative-control] waived <reason>` at 20 characters or more, so skipping the control is a recorded statement rather than silence.

  The check only fires when it can see a test file in the changed scope, and the existing empty-diff refusal still comes first. Measured on two real commits before shipping: the SQ-1294 fix goes 20/0 to 18/2 under reversion, and SQ-1313 goes 107/0 to 104/3. Where build output is tracked, reverting every non-test path reverts source and compiled output together, so no rebuild is needed and the control costs about one extra scoped run.

## v3.360.0 (2026-08-03)

### sidequest 4.6.0 → 4.7.0

#### Features

- "I am blocked" carried no burden of proof (SQ-1313) [`30ea7cb`](https://github.com/Eigenwise/eigenwise-toolshed/commit/30ea7cb6)
  A completion claim eventually meets a verify. A blocker claim met nothing: `release --reason` was free text, so a run could end by asserting a build failure or a hung suite and the board would record the assertion verbatim. Every blocker claimed in one day's work turned out to be false. A plugin reported absent was present, a suite reported hung passed 800 tests in three and a half minutes, and generated-output drift exited clean on the very checkpoint that reported it. Each took under five minutes to disprove, which is the problem: a false blocker is indistinguishable from a real one until someone spends the five minutes, so every release had to be treated as suspect.

  Releases now carry a `kind`, and a `technical_blocker` must supply the failing command, its exit code, and an output tail. A scope pause, a ticket-versus-code contradiction, and a deliberate handback stay a single call with nothing to prove, because those are honest and making them expensive would train executors out of the one behavior that already works. MCP and the CLI share the same predicate, so neither surface can become the lenient one.

## v3.359.0 (2026-08-03)

### sidequest 4.5.6 → 4.6.0

#### Features

- A completion claim never met the tree, so "verified" survived a byte-identical diff (SQ-1312) [`27e524a`](https://github.com/Eigenwise/eigenwise-toolshed/commit/27e524a0)
  `[sidequest:verify-complete]` was only ever a liveness marker, there to stop a long verify from being reclaimed. Nothing checked that the command ran, that it passed, or that anything changed. The real diff was computed from git, but only at submission, which shared-tree runs never reach. So an executor could report three corrections applied and post verification complete against a tree byte-identical to before it started, and the first thing to notice would be a human reading the diff. Across two projects in one day that happened five times, with the orchestrator manually checking the tree every time and saying so on the ticket.

  A write-scope ticket whose declared files show an empty diff since its dispatch base is now refused at completion, naming the files and offering `[sidequest:verify-complete] no-op` for the legitimately empty run. Read-only tickets are untouched, since delivering a comment and changing nothing is their whole job. Where a submission is genuinely missing, the existing refusal still wins: it names a more specific next action.

## v3.358.0 (2026-08-03)

### sidequest 4.5.5 → 4.5.6

#### Fixes

- Scope refusals told the orchestrator to act as its own executor (SQ-1309) [`ac738a3`](https://github.com/Eigenwise/eigenwise-toolshed/commit/ac738a35)
  Refusing a scope change under a live claim pointed the caller at `scope-request --by <claim.by>`, which is the executor's identity, so an orchestrator following the message was impersonating the agent it had dispatched. The advice was not even needed: the guard already lets a caller through when it supplies a `by` of its own, and the orchestrator was only refused because it passed none. One run retried the same call three times and escalated to the CLI, pulling two full usage dumps into context, for something one field would have solved. The refusal now branches: with no `by` it names re-running under your own identity, and the scope-request path stays for the claim holder, where it is correct. The same audit removed a matching instruction to release as another agent.
- The browser/visual planning warning fired on any ticket whose prose mentioned a browser (SQ-1310) [`e8510ac`](https://github.com/Eigenwise/eigenwise-toolshed/commit/e8510acb)
  The warning matched `browser|visual|screenshot|playwright|ui review|e2e` against a ticket's title and description, so a readonly ticket earned a "may need a driver script" warning for merely mentioning one of those words. A source-reading audit that said "PHP/frontend can render" got it; so did a stack-reproduction spike whose title contained "403 on click". Neither goes near a browser. The subject being the frontend is not the method being a browser, and prose cannot tell those apart. It now keys on the category that actually means "judged through screenshots", matching both the current `visual-evaluation` id and the legacy `visual-review` one, since boards seeded before the rename still carry the old id and nothing aliases them.
- Two Windows traps whose errors point away from their own cause (SQ-1311) [`698c50a`](https://github.com/Eigenwise/eigenwise-toolshed/commit/698c50a4)
  `docker exec -w /app` fails with `Cwd must be an absolute path`, and `/app` is absolute: Git Bash's MSYS2 layer rewrites it before docker sees it, so the error blames the one argument that was correct. `Start-Process -FilePath "npm"` fails with `%1 is not a valid Win32 application`, which reads like a corrupt Node install when the real story is that npm is a `.cmd` shim. Both cost an agent a dead tool call and then send it hunting in the wrong direction. The existing Windows guard only caught `C:\...` paths going into Bash; these are the same hazard from angles it did not cover. Both now warn with the corrected command spelled out, and neither denies, because they are legitimate commands with a platform-specific spelling.

## v3.357.0 (2026-08-03)

### model-gateway 0.47.1 → 0.48.0

#### Features

- The shim worker binds its own port and reports it, instead of the supervisor guessing (SQ-1307) [`0e79ad4`](https://github.com/Eigenwise/eigenwise-toolshed/commit/0e79ad46)
  The worker port was computed as 20000 + (supervisorPort % 20000), which is the identity function for every port in 20000-39999. On Linux, whose default ephemeral range overlaps that band, the worker was told to bind the port the supervisor already held, never started, and hung the suite until the six-hour CI job timeout. Windows never reached it because its dynamic range starts above 49152. No arithmetic fixes this: any computed port is a guess about what is free while the OS allocates from the same space, and a first attempt using supervisorPort + 1 traded the Linux failure for a Windows one. The worker now binds an ephemeral port and reports it to the supervisor over IPC. A missing report is a bounded, named startup failure rather than a silent fallback.

## v3.356.0 (2026-08-03)

### sidequest 4.5.4 → 4.5.5

#### Fixes

- Dispatch guard no longer mistakes a --test flag for the test glob (SQ-1308) [`b9fc515`](https://github.com/Eigenwise/eigenwise-toolshed/commit/b9fc5155)
  The runnability check took the first token after --test as the file pattern, so once fallback suites gained --test-timeout it read the flag as a glob, matched nothing, and refused every ticket carrying the command the resolver itself derives. It now skips flags to find the glob, and the suggested replacement comes from the resolver rather than a second hardcoded copy that could drift.

## v3.355.0 (2026-08-03)

### sidequest 4.5.3 → 4.5.4

#### Fixes

- Approving a scope request left the executor blocked until it re-ran the check itself (SQ-1304) [`7456d60`](https://github.com/Eigenwise/eigenwise-toolshed/commit/7456d600)
  Denying a scope request was one orchestrator call. Approving one was an update, a message to the executor, and a re-run by the executor, because adding the requested path to the declared files never cleared the pending request. The orchestrator could not finish its own approval either: `requestScope` refuses anyone but the claim holder, so trying to confirm an approval it had just granted came back `not_owner`, which reads like a denial. Measured on a real run, an executor sat blocked for about seven minutes on a file that had been approved the whole time, and the same round trip happened twice on one ticket. Declared-file updates now resolve a scope request they fully cover, and the refusal names the next legal action instead of only its precondition.

## v3.354.0 (2026-08-03)

### sidequest 4.5.2 → 4.5.3

#### Fixes

- A hanging test now names itself instead of stalling CI (SQ-1303) [`21f0134`](https://github.com/Eigenwise/eigenwise-toolshed/commit/21f0134e)
  Fallback suites run with node --test --test-timeout=30000, so a test that hangs fails with its own name and location instead of stalling silently. The affected-plugin CI job also gained timeout-minutes: 10; it previously had no timeout at all, so one hung test held the workflow concurrency slot for the GitHub six-hour default and every release queued behind it was evicted. Measured headroom: the slowest legitimate fallback test is 4.5s and the slowest whole suite 18.3s.

## v3.353.0 (2026-08-03)

### observability 0.2.1 → 0.2.2

#### Fixes

- Every Loki panel was empty because the bucket variable shipped an unresolvable auto value (SQ-1302) [`3370661`](https://github.com/Eigenwise/eigenwise-toolshed/commit/33706618)
  The `bucket` interval variable shipped with Grafana's legacy `$__auto_interval_bucket` auto value, and that string reached Loki verbatim: `not a valid duration string`. The same query with a real range selector returned six models, so the data and the queries were fine the whole time. Nine panels were dead on it, covering gateway routing, context-window growth, cache economics, and hook health, and they failed as "No data" rather than an error, so a broken panel looked exactly like a quiet day. Generation now refuses any dashboard still carrying a `$__auto_interval_*` value, alongside the existing check that every referenced variable is declared.

## v3.352.0 (2026-08-03)

### sidequest 4.5.1 → 4.5.2

#### Fixes

- The executor skill guard denied on a hardcoded guess, and readonly categories flagged their own artifact roots (SQ-1299) [`5309825`](https://github.com/Eigenwise/eigenwise-toolshed/commit/53098253)
  Two guards that fired on the wrong evidence.

  The oversized-skill guard summed a skill's entire directory tree against a 256 KiB budget, but skills load progressively, so the number it judged was a worst case that mostly never enters context. Worse, when it could not locate the skill directory it fell back to a hardcoded size and denied on that: an executor was blocked from `claude-api` by a constant, then pulled more than the budget through WebFetch instead. It now measures what actually loads and fails open when it cannot measure.

  Separately, a readonly category warned about write intent even when the ticket's declared scope sat entirely inside that category's own `artifactRoots`. `codebase-exploration` declares `.claude/.codebase-info` as an artifact root and its contract permits exactly that write, so the one flow the feature exists to serve was the flow that needed an override. The check now consults the roots it already declares.

## v3.351.0 (2026-08-03)

### codebase-mapper 2.12.2 → 2.12.3

#### Fixes

- The map update instruction told the model to end its turn, so the skill never ran (SQ-1295) [`be65277`](https://github.com/Eigenwise/eigenwise-toolshed/commit/be652774)
  The injected instruction said to "end with" the line announcing that the map update is running. A turn that has ended cannot contain the tool call that was supposed to follow, so sessions closed on "Running /codebase-mapper:update-codebase-map" and the map never got updated. It read as done to anyone skimming, which is how it survived. The announcement now comes before the action and says outright that announcing is not doing, and a Stop hook blocks the turn when the claim was made without the skill actually being invoked. The block skips subagents, skips the "no updates needed" ending, and won't fire twice in a row.

## v3.350.0 (2026-08-03)

### observability 0.2.0 → 0.2.1

#### Fixes

- Grafana setup mounted the template dashboards, so per-project boards never showed (SQ-1294) [`877dbdd`](https://github.com/Eigenwise/eigenwise-toolshed/commit/877dbddb)
  The container gets created two ways and only `ensure` mounted the generated dashboards. The setup path passed no `dashboardDir`, so it fell back to the plugin's static template folder, which only ever holds `claude-code-usage.json` — one dashboard in Grafana no matter how many projects opted in. It also never self-healed, because the "is this container current?" check looked at image, version labels and port bindings but not the mount, so a bad container survived every later `ensure`. Both paths now provision from the opted-in project registry and pass the generated directory, and a container whose dashboard mount doesn't match gets force-recreated.

## v3.349.0 (2026-08-03)

### model-gateway 0.47.0 → 0.47.1

#### Fixes

- Test listeners get real ephemeral ports instead of a shared fixed one (SQ-1292) [`ae349f9`](https://github.com/Eigenwise/eigenwise-toolshed/commit/ae349f99)
  Asking the shim for an ephemeral port did not give you one: the worker port was computed as 20000 + (port % 20000), so a requested port of 0 collapsed to a hardcoded 20000 for every caller. Parallel test files then collided on it, the shim failed to start, and the CI job either failed with EADDRINUSE or hung to the six-hour timeout. The worker port is now derived from the port the OS actually assigned, and both the supervisor and worker log the port they bound rather than the one they asked for.

## v3.348.0 (2026-08-03)

### sidequest 4.5.0 → 4.5.1

#### Fixes

- Hook latency budgets are absolute, not a ratio to process start (SQ-1290) [`edfc1de`](https://github.com/Eigenwise/eigenwise-toolshed/commit/edfc1de8)
  The perf test asserted each hook's median against 10x a bare process-start control measured on the same machine. Linux spawns a process in about 23ms and Windows in about 45ms, so the same hook cost passed locally and failed on CI: the faster the hardware, the tighter the budget. Budgets are now absolute wall-clock ceilings, and failures print the measured value, the applied ceiling, and the control.

## v3.347.0 (2026-08-03)

### sidequest 4.4.3 → 4.5.0

#### Features

- Dispatch refuses a verify command that cannot run (SQ-1288) [`361539d`](https://github.com/Eigenwise/eigenwise-toolshed/commit/361539d7)
  A ticket whose verify command could never execute used to spawn an executor anyway, which explored, hit ENOENT, and released without doing any work. Dispatch now checks that the command after the cd can actually run (npm script present, test glob matching files) and refuses before spawning, naming the command derived from the tree instead. The resolver is shared with the release cut rather than duplicated. Malformed legacy verify strings stay advisory; only the provably-unrunnable class refuses.

## v3.346.0 (2026-08-03)

### model-gateway 0.46.4 → 0.47.0

#### Features

- One command updates the gateway, on every platform (SQ-1287) [`6911ac4`](https://github.com/Eigenwise/eigenwise-toolshed/commit/6911ac41)
  The proxy binary is now swapped by renaming the old one aside rather than copying over it. A running executable cannot be overwritten (EBUSY) or deleted (EPERM) on Windows, and overwriting one on Linux gives ETXTBSY, but renaming works everywhere and the running process keeps serving from the renamed file. The upgrade no longer stops the proxy to swap the file, and a failed swap can restore the previous binary because the canonical path is free by then. A stable launcher means the documented command carries no plugin version and never goes stale.

### workbench 0.78.0 → 0.79.0

#### Features

- One command updates the gateway, on every platform (SQ-1287) [`6911ac4`](https://github.com/Eigenwise/eigenwise-toolshed/commit/6911ac41)
  The proxy binary is now swapped by renaming the old one aside rather than copying over it. A running executable cannot be overwritten (EBUSY) or deleted (EPERM) on Windows, and overwriting one on Linux gives ETXTBSY, but renaming works everywhere and the running process keeps serving from the renamed file. The upgrade no longer stops the proxy to swap the file, and a failed swap can restore the previous binary because the canonical path is free by then. A stable launcher means the documented command carries no plugin version and never goes stale.

## v3.345.0 (2026-08-02)

### sidequest 4.4.2 → 4.4.3

#### Fixes

- submit refuses a verify string integration would later reject (SQ-1286) [`11845b2`](https://github.com/Eigenwise/eigenwise-toolshed/commit/11845b25)
  The verify shape check ran only at integration time, reading the submission's copy. An executor could submit a green run with an unrunnable verify string, and by the time integrate refused it the executor was gone and editing the ticket's verify field had no effect. submit now applies the same predicate, so the executor is told while it can still resubmit.

## v3.344.0 (2026-08-02)

### sidequest 4.4.1 → 4.4.2

#### Fixes

- Publish-lock refusals name the expected and found session ids (SQ-1140) [`c047bc2`](https://github.com/Eigenwise/eigenwise-toolshed/commit/c047bc2a)
- Dispatch executor defs no longer render effort: max (SQ-1285) [`9b8a888`](https://github.com/Eigenwise/eigenwise-toolshed/commit/9b8a8882)
  The two collapsed dispatch executor definitions rendered frontmatter `effort: max` so their maxTurns picked up the 250-turn backstop. Only the gateway's marker path rewrites effort, and that path requires the requested model to be `auto`; a request naming a concrete Claude model forwards effort untouched. WebSearch's internal call is such a request, so `max` reached Anthropic and 400'd on a thinking-disabled model. maxTurns is now derived independently of the rendered effort.

## v3.343.0 (2026-08-02)

### codebase-mapper 2.12.1 → 2.12.2

#### Fixes

- Subagents never update the codebase map (SQ-1259) [`2e6ee7a`](https://github.com/Eigenwise/eigenwise-toolshed/commit/2e6ee7a4)
  The mapper's SubagentStart hook was injecting the main session's update-the-map instruction into executors; subagents now get an explicit prohibition and hand-back, and the executor template carries the same rule.

### sidequest 4.4.0 → 4.4.1

#### Fixes

- Subagents never update the codebase map (SQ-1259) [`2e6ee7a`](https://github.com/Eigenwise/eigenwise-toolshed/commit/2e6ee7a4)
  The mapper's SubagentStart hook was injecting the main session's update-the-map instruction into executors; subagents now get an explicit prohibition and hand-back, and the executor template carries the same rule.

## v3.342.0 (2026-08-02)

### sidequest 4.3.0 → 4.4.0

#### Features

- Collapse the Codex dispatch executors to two (SQ-1281) [`f451be4`](https://github.com/Eigenwise/eigenwise-toolshed/commit/f451be4b)
  Model and effort both ride the dispatch route marker, so the per-effort Codex defs carried dead frontmatter. 12 definitions and 1,280 injected tokens, from 27 and 8,402. Legacy names still classify so old dispatch records heal by redispatch.

## v3.341.0 (2026-08-02)

### sidequest 4.2.0 → 4.3.0

#### Features

- Express read-only executors as a deny list (SQ-1279) [`085c5ac`](https://github.com/Eigenwise/eigenwise-toolshed/commit/085c5ac6)
  The allow list named all 54 board tools to exclude three writers, hid every later-added tool, and blocked Playwright from visual-review. Injected frontmatter 7,616 -> 2,188 tokens.

## v3.340.0 (2026-08-02)

### sidequest 4.1.2 → 4.2.0

#### Features

- Restore the orchestration engine (SQ-1273) [`403d8e5`](https://github.com/Eigenwise/eigenwise-toolshed/commit/403d8e5c)
  The strip was justified by md-bench, which measured single-context work; this repo's work routinely overflows the window, where executors amortize context instead of re-billing it every turn. Restored from v3.335.0; board and all 14 category routes survived intact.

## v3.339.0 (2026-08-02)

### sidequest 4.1.1 → 4.1.2

#### Fixes

- Revert the PreCompact continuity injection (SQ-1277) [`5193da0`](https://github.com/Eigenwise/eigenwise-toolshed/commit/5193da01)
  Countering a Claude Code summarization behavior with unmeasured prompt text was the wrong fix. The Stop-hook wording fix and the closed coverage gap both stay.

## v3.338.0 (2026-08-02)

### sidequest 4.1.0 → 4.1.1

#### Fixes

- Repair the MCP tools the orchestration strip broke (SQ-1272) [`0bf43ab`](https://github.com/Eigenwise/eigenwise-toolshed/commit/0bf43ab6)
  done, plan and groomClose all threw on first call because their handlers still reached for deleted lib modules through an untyped require(); plan is removed, the other two repaired, and a surface test now exercises every advertised tool.

## v3.337.0 (2026-08-02)

### sidequest 4.0.0 → 4.1.0

#### Features

- Stop compaction summaries reading as a stop signal (SQ-1276) [`4895997`](https://github.com/Eigenwise/eigenwise-toolshed/commit/4895997a)
  PreCompact always emits a continuity instruction so a summary cannot record context pressure as a decision or handoff; the Stop-hook suggestion now says checkpoint, not stopping point.

## v3.336.0 (2026-08-02)

### sidequest 3.56.1 → 4.0.0

#### Breaking changes

- Sidequest orchestration is removed; the board is a tracker (SQ-1271) [`a1306b2`](https://github.com/Eigenwise/eigenwise-toolshed/commit/a1306b219af661aac0d8658cc0b011d019947870)
  Dispatch, routing, categories, executors, claims, submissions, scope enforcement, and worktree management are gone. 25,682 source lines to 10,107; 55 MCP tools to 16; 13 hook events to 5. The board still captures, tracks, links, and closes tickets, and Claude no longer picks work off it unprompted. Fan-out and model-selection guidance moved to the playbook plugin. Staying on orchestration means staying on 3.335.0.

### workbench 0.77.0 → 0.78.0

#### Features

- Sidequest orchestration is removed; the board is a tracker (SQ-1271) [`a1306b2`](https://github.com/Eigenwise/eigenwise-toolshed/commit/a1306b219af661aac0d8658cc0b011d019947870)
  Dispatch, routing, categories, executors, claims, submissions, scope enforcement, and worktree management are gone. 25,682 source lines to 10,107; 55 MCP tools to 16; 13 hook events to 5. The board still captures, tracks, links, and closes tickets, and Claude no longer picks work off it unprompted. Fan-out and model-selection guidance moved to the playbook plugin. Staying on orchestration means staying on 3.335.0.

## v3.335.0 (2026-08-02)

### model-gateway 0.46.3 → 0.46.4

#### Fixes

- Observability is its own plugin, and skill-retro is now playbook (SQ-1270) [`110e82d`](https://github.com/Eigenwise/eigenwise-toolshed/commit/110e82db5ff54644fef14c3f0f8dd779b79581bf)
  Workbench keeps setup, updates, and health. Telemetry, the statusline, and the Collector move to the new user-scoped observability plugin. skill-retro becomes playbook and gains fan-out, verify-discipline, and pick-model. Reinstall skill-retro@eigenwise-toolshed as playbook@eigenwise-toolshed.

### observability 0.1.0 → 0.2.0

#### Features

- Observability is its own plugin, and skill-retro is now playbook (SQ-1270) [`110e82d`](https://github.com/Eigenwise/eigenwise-toolshed/commit/110e82db5ff54644fef14c3f0f8dd779b79581bf)
  Workbench keeps setup, updates, and health. Telemetry, the statusline, and the Collector move to the new user-scoped observability plugin. skill-retro becomes playbook and gains fan-out, verify-discipline, and pick-model. Reinstall skill-retro@eigenwise-toolshed as playbook@eigenwise-toolshed.

### playbook 0.3.2 → 0.4.0

#### Features

- Observability is its own plugin, and skill-retro is now playbook (SQ-1270) [`110e82d`](https://github.com/Eigenwise/eigenwise-toolshed/commit/110e82db5ff54644fef14c3f0f8dd779b79581bf)
  Workbench keeps setup, updates, and health. Telemetry, the statusline, and the Collector move to the new user-scoped observability plugin. skill-retro becomes playbook and gains fan-out, verify-discipline, and pick-model. Reinstall skill-retro@eigenwise-toolshed as playbook@eigenwise-toolshed.

### sidequest 3.56.0 → 3.56.1

#### Fixes

- Observability is its own plugin, and skill-retro is now playbook (SQ-1270) [`110e82d`](https://github.com/Eigenwise/eigenwise-toolshed/commit/110e82db5ff54644fef14c3f0f8dd779b79581bf)
  Workbench keeps setup, updates, and health. Telemetry, the statusline, and the Collector move to the new user-scoped observability plugin. skill-retro becomes playbook and gains fan-out, verify-discipline, and pick-model. Reinstall skill-retro@eigenwise-toolshed as playbook@eigenwise-toolshed.

### workbench 0.76.1 → 0.77.0

#### Features

- Observability is its own plugin, and skill-retro is now playbook (SQ-1270) [`110e82d`](https://github.com/Eigenwise/eigenwise-toolshed/commit/110e82db5ff54644fef14c3f0f8dd779b79581bf)
  Workbench keeps setup, updates, and health. Telemetry, the statusline, and the Collector move to the new user-scoped observability plugin. skill-retro becomes playbook and gains fan-out, verify-discipline, and pick-model. Reinstall skill-retro@eigenwise-toolshed as playbook@eigenwise-toolshed.

## v3.334.0 (2026-08-02)

### sidequest 3.55.0 → 3.56.0

#### Features

- Dispatched executors are blocked from loading oversized bundled skills (SQ-1251) [`96597ca`](https://github.com/Eigenwise/eigenwise-toolshed/commit/96597cad)
  The bundled `claude-api` skill is 932 KB across 64 files. `shared/model-migration.md` alone is 176 KB, roughly 44k tokens, and a full load runs to about 230k. An executor that reached for it to check one SDK signature spent its whole context budget on reference material, which is the entire budget for a routed executor doing a small ticket.

  A PreToolUse guard now refuses a `Skill` call from a dispatched executor when the skill's directory exceeds 256 KB, and points at a targeted `Read` or a research ticket instead. It matches on the skill name rather than its location, since the bundled path is content-hashed per Claude Code version and would go stale on every upgrade, and it falls open on any error so a guard bug can never block work. The executor briefing says the same thing in prose, so the rule is visible before the refusal fires. Orchestrators and non-dispatched agents are unaffected.
- Scope requests can be denied over MCP, not only approved (SQ-1252) [`a40c7d3`](https://github.com/Eigenwise/eigenwise-toolshed/commit/a40c7d3f)
  An executor could ask to widen its scope, and an orchestrator over MCP had no way to say no. A pending request blocks the board `commit` tool, and the only things that cleared it were approving the exact paths you meant to refuse, or releasing the ticket and throwing away finished work. The CLI had a deny; MCP did not, and the refusal message named only the approve path. Denial was reachable only through an overload where omitting `files` and passing a `reason` to `scopeRequest` meant deny, which nothing documented and no caller would guess.

  `scopeDeny` is now its own tool taking `ref`, `by`, and a required `reason`, and it is in the executor read-only allowlist. `scopeRequest` requires `files` and no longer doubles as a denial. The `commit` refusal names both paths, so whoever reads it can approve or refuse without going to the source.

#### Fixes

- Plugin test suites run under the same hermetic git env as the release cut (SQ-1250) [`d1d06d2`](https://github.com/Eigenwise/eigenwise-toolshed/commit/d1d06d26)
  The release cut runs every plugin suite with `GIT_CONFIG_NOSYSTEM=1` and global/system gitconfig pointed at the null device, so a fixture that leaned on ambient git config behaved one way under `npm run test:full` and another way inside `cut.mjs`. On a box with `init.defaultBranch=main` in the system gitconfig, a bare `git init` yields `main` normally and `master` under the cut. That killed two v3.330.0 cuts while the same checkout tested green, and the cut is the worst place to find out: it aborts after bumping versions, so every attempt costs a rewound release commit and two tags.

  `test:full` now builds its environment from the cut's own `suiteEnvironment()`, and CI sets the same variables, so the three run identically. A new test asserts the env is actually in effect and that `git init` in a scratch repo produces `master`, which fails loudly if the wiring is ever dropped.
- A ticket waiting on scope approval is no longer counted as closeable (SQ-1260) [`5ae0ec7`](https://github.com/Eigenwise/eigenwise-toolshed/commit/5ae0ec73)
  The stop-hook reminder counted every non-done ticket the session touched as something to update or close, with no exception for one blocked on a pending scope request. An executor that had filed a request and stopped to wait read that as instruction and released the ticket. A released dispatch cannot be resumed, so the work either needed hand-salvaging out of the worktree or was simply lost, and it always cost a full respawn. It hit three times in one evening, once on a complete uncommitted tree. The race makes it worse than a plain miscount: an executor waiting on approval is idle, and idle is exactly when the hook fires, so the blocked state is the one most likely to be counted.

  Tickets waiting on scope approval and submissions pending integration are now reported separately from actionable ones. The message names them as waits rather than work, and both the ordinary and escalated reminders now say to checkpoint and hold, never release.
- Committed build output pulls its own source into scope (SQ-1261) [`214ce98`](https://github.com/Eigenwise/eigenwise-toolshed/commit/214ce985)
  Scope already worked one way: declare `src/lib/store.ts` and the generated `lib/store.js` came along, because a generated pair says where the output lands. Going the other direction did nothing. An executor whose ticket scoped a tracked build output, or who reached one through a rebuild, had to file a scope request for the source and wait for an orchestrator to approve it, and a scope request costs a round trip while the executor sits idle.

  Worse, an executor that pushed through committed the output while its source stayed out of scope and uncommitted, so the commit's `lib/*.js` no longer matched its `src/*.ts`. The next build silently reverts it.

  `effectiveScope` now runs the generated pairs backwards too. A scoped path that is tracked, sits under a package's declared build output directory, and maps back to exactly one source under the reversed pair brings that source in with it. Ambiguous reverse matches are left alone, so a pair set that could resolve two ways still needs the request.
- Scope requests from an isolated executor no longer demand a worktree the MCP schema cannot express (SQ-1262) [`717b8c0`](https://github.com/Eigenwise/eigenwise-toolshed/commit/717b8c0b)
  An executor running under worktree isolation called `scopeRequest` over MCP and got back `worktree_required`. There was nothing it could do about that. The tool's schema declares `ref`, `by`, `files`, and `project`, so `args.worktree` was structurally always undefined and the refusal could never be satisfied by any MCP caller. The path it needed was its own working directory, and it still had no way to hand it over.

  Under the isolation mode the skill recommends by default, that left one move: release the ticket. Which is correct, and costs a whole spawn to discover the escape hatch does not open.

  The worktree now comes from the dispatch record, which already stores it, so nothing has to be passed. Since SQ-1253 moved the marker into Sidequest's own assets directory the value is only used to confirm the caller really is isolated, and the dispatch record is a better source for that than a caller-supplied string anyway. A dispatch with no recorded worktree reports `worktree_unavailable`, which says what is actually wrong.

## v3.333.0 (2026-08-01)

### sidequest 3.54.1 → 3.55.0

#### Features

- Dispatch stops calling ordinary prose a missing code symbol (SQ-1244) [`e19edd0`](https://github.com/Eigenwise/eigenwise-toolshed/commit/e19edd0d)
  Dispatch warns when a ticket names a symbol that isn't on the integration branch. It was wrong often enough to be worse than useless: it searched only the ticket's declared scope, so any real symbol living elsewhere in the repo read as missing, and it treated anything in backticks as code. Board comment ids, `ALL_CAPS` constants, attribute expressions like `fractions.Fraction`, and plain prose words got flagged, including files the ticket was filed to create. Executors took the warnings at face value and released good tickets over them.

  The check now searches the whole tree, resolves against the current branch head instead of a stale upstream ref, skips anything the ticket declares as its own output, and only treats a bare snake_case word as a symbol when the sentence actually calls it one. The warning reads as context rather than an instruction, and the executor rule now says plainly that scope limits writes but never reads, so an out-of-scope path is context, not a contradiction.

## v3.332.0 (2026-08-01)

### sidequest 3.54.0 → 3.54.1

#### Fixes

- Scope-request markers stay out of your repo (SQ-1253) [`09e0294`](https://github.com/Eigenwise/eigenwise-toolshed/commit/09e02943)
  Asking to widen a ticket's scope used to drop a `.sidequest/scope-request-*.json` file into the executor's worktree and stage it, so it could ride along into a commit and land on main as a stray board artifact. The marker now lives in Sidequest's own asset directory. Nothing is written to your working tree and nothing is staged, so there's no `.gitignore` entry to discover after the fact.
- The high-stakes review advisory now tells you how to satisfy it (SQ-1257) [`e87cb07`](https://github.com/Eigenwise/eigenwise-toolshed/commit/e87cb077)
  Integrating a high-stakes ticket without a review used to warn `high-stakes ticket integrated without a recorded review pass` and stop there, leaving you to guess the mechanism. The obvious guess is wrong: `verdict` belongs to the experiment loop and refuses with `no_oracle`. The advisory now names the exact way to close it, record a comment beginning `reviewed-by: <ref>`, and it resolves on its own when a completed `review-audit` ticket links to the one being integrated. The `no_oracle` refusal points at the review path too, instead of only saying no.

## v3.331.0 (2026-08-01)

### sidequest 3.53.2 → 3.54.0

#### Features

- A dispatch that dies now records why, not just that it stopped (SQ-1234) [`040acf7`](https://github.com/Eigenwise/eigenwise-toolshed/commit/040acf76)
  A terminal dispatch recorded only that it ended. Whether the executor ran out of quota, blew the context window, lost auth, or hit a dead backend all looked identical afterwards, so nothing downstream could react to the difference. Dispatches now classify the failure into a shape and persist it, and each attempt is kept with its route, executor, and outcome so the history survives past the current one.

## v3.330.0 (2026-08-01)

### sidequest 3.53.1 → 3.53.2

#### Fixes

- A failed integration verify now reports what it ran and what it printed (SQ-1248) [`84adecc`](https://github.com/Eigenwise/eigenwise-toolshed/commit/84adecc1)
  A refused integration returned a bare reason with no command and no output, so the only way to find out what broke was to read the board database by hand. The failure path now carries the same command, log path, and output tail the success path already reported.

## v3.329.0 (2026-08-01)

### sidequest 3.53.0 → 3.53.1

#### Fixes

- Document the story decision log and scope denial (SQ-1245) [`fc79ced`](https://github.com/Eigenwise/eigenwise-toolshed/commit/fc79ced7)
  The Sidequest README and the getting-started page now cover what the story decision log keeps, that a clear archives instead of deleting, how to read the full history, and how an orchestrator denies a scope request.

## v3.328.0 (2026-08-01)

### sidequest 3.52.0 → 3.53.0

#### Features

- Unbind the story decision log from the briefing budget (SQ-1240) [`623369a`](https://github.com/Eigenwise/eigenwise-toolshed/commit/623369ae)
  Story logs no longer refuse an append at 4 KB. The 4 KB ceiling was always a briefing budget, and enforcing it as a storage limit meant the only escape was `story_log --clear`, which destroyed the history it was condensing. Storage now holds the full log, clearing archives instead of deleting, briefings still carry the newest entries inside 4 KB, and `sidequest story log --full` reads the whole thing.
- An orchestrator can now deny a scope request (SQ-1242) [`e2c8354`](https://github.com/Eigenwise/eigenwise-toolshed/commit/e2c8354a)
  A pending scope request had exactly two outcomes: grant it, or throw the executor's work away. `scopeRequest` now takes a reason with no files, which denies the request, clears the pending state and the marker, and keeps the claim, the checkpoint, and the original scope intact. The reason comes back to the executor so it knows why. CLI: `sidequest scope-deny`.

#### Fixes

- Make the temp-cleanup and skill-retro CLI tests platform-independent (SQ-1241) [`ffd5e65`](https://github.com/Eigenwise/eigenwise-toolshed/commit/ffd5e652)
  Two test fixtures assumed a POSIX filesystem and only ever ran green on one platform. They now assert the same behavior on Windows and POSIX alike.

### skill-retro 0.3.1 → 0.3.2

#### Fixes

- Make the temp-cleanup and skill-retro CLI tests platform-independent (SQ-1241) [`ffd5e65`](https://github.com/Eigenwise/eigenwise-toolshed/commit/ffd5e652)
  Two test fixtures assumed a POSIX filesystem and only ever ran green on one platform. They now assert the same behavior on Windows and POSIX alike.

### workbench 0.76.0 → 0.76.1

#### Fixes

- Point users at the docs, loudly (SQ-1243)
  The root README and the init-workspace handover now say plainly that reading the docs matters for these plugins, and the handover names the specific page for each plugin just installed. People skip plugin docs by default, and these plugins route work to other models, write project config, and inject context on every prompt.

## v3.327.0 (2026-08-01)

### codebase-mapper 2.12.0 → 2.12.1

#### Fixes

- Point every plugin README at the docs site and state the right install scope (SQ-1219) [`40faeb1`](https://github.com/Eigenwise/eigenwise-toolshed/commit/40faeb1b3168c01822cc50158cc529d95330d990)
  Each plugin README now opens with a link to its guide on the docs site, and says whether it installs at user scope or project scope. Model Gateway is user scope only: its wiring writes ~/.claude/settings.json and there is no project-scoped mode.

### live-rules 2.9.0 → 2.9.1

#### Fixes

- Point every plugin README at the docs site and state the right install scope (SQ-1219) [`40faeb1`](https://github.com/Eigenwise/eigenwise-toolshed/commit/40faeb1b3168c01822cc50158cc529d95330d990)
  Each plugin README now opens with a link to its guide on the docs site, and says whether it installs at user scope or project scope. Model Gateway is user scope only: its wiring writes ~/.claude/settings.json and there is no project-scoped mode.

### model-gateway 0.46.2 → 0.46.3

#### Fixes

- Point every plugin README at the docs site and state the right install scope (SQ-1219) [`40faeb1`](https://github.com/Eigenwise/eigenwise-toolshed/commit/40faeb1b3168c01822cc50158cc529d95330d990)
  Each plugin README now opens with a link to its guide on the docs site, and says whether it installs at user scope or project scope. Model Gateway is user scope only: its wiring writes ~/.claude/settings.json and there is no project-scoped mode.

### sidequest 3.51.0 → 3.52.0

#### Features

- Re-derive the starter routing profiles around required capability instead of artifact type (SQ-1222) [`5f19f73`](https://github.com/Eigenwise/eigenwise-toolshed/commit/5f19f730b3122a39833a0589912593479f3f4a69)
  Starter categories were named after the thing produced, but a category only decides model and effort, so the axis that matters is what capability the work needs. Research split into a cheap lookup and a real investigation, testing became behavior-verification, ui-frontend became interaction-design-implementation, and the writing starter no longer ships a docs-writing category to projects with no docs. Existing boards migrate; the seed migration now keys on category id rather than on the old description text, which is what used to strand artifactRoots on upgrade.

#### Fixes

- Point every plugin README at the docs site and state the right install scope (SQ-1219) [`40faeb1`](https://github.com/Eigenwise/eigenwise-toolshed/commit/40faeb1b3168c01822cc50158cc529d95330d990)
  Each plugin README now opens with a link to its guide on the docs site, and says whether it installs at user scope or project scope. Model Gateway is user scope only: its wiring writes ~/.claude/settings.json and there is no project-scoped mode.
- Restore the README claims that the plugin contract tests pin (SQ-1229) [`70daf4b`](https://github.com/Eigenwise/eigenwise-toolshed/commit/70daf4b4f76a)
  The README rewrite dropped three claims the suites assert on and introduced an internal identifier one of them forbids.
- Stop the compaction policy tests inheriting SIDEQUEST_COMPACTION_POLICY from the shell (SQ-1230) [`ea34114`](https://github.com/Eigenwise/eigenwise-toolshed/commit/ea341146e3eff3b6ab84d557e60915818a3a6fa5)
  The tests spawned the hook with the developer's own environment, so on a machine with the per-project veto setting the two default-policy tests got the veto policy and failed. That made the release gate red for anyone with a legitimate local setting.

### skill-retro 0.3.0 → 0.3.1

#### Fixes

- Point every plugin README at the docs site and state the right install scope (SQ-1219) [`40faeb1`](https://github.com/Eigenwise/eigenwise-toolshed/commit/40faeb1b3168c01822cc50158cc529d95330d990)
  Each plugin README now opens with a link to its guide on the docs site, and says whether it installs at user scope or project scope. Model Gateway is user scope only: its wiring writes ~/.claude/settings.json and there is no project-scoped mode.

### workbench 0.75.0 → 0.76.0

#### Features

- init-workspace explains what it is doing while it runs (SQ-1220) [`661c213`](https://github.com/Eigenwise/eigenwise-toolshed/commit/661c21358a4bdeb02310fdc6b9a1f7449ddb7f91)
  The skill was written purely as agent instructions, so someone running it got a series of questions with no stated reason. It now orients you before the first question, gives every ask a one-line reason, says which files it writes including the one global settings exception for the compaction window, and ends Phase 5 as a handover rather than a silent stop.
- Build out the init-workspace rule templates for projects that are not codebases (SQ-1223) [`6c1572e`](https://github.com/Eigenwise/eigenwise-toolshed/commit/6c1572e824a12f23b267e635d7689c69595df522)
  The not-a-codebase section was a three-bullet stub sitting under about ten detailed code rules, so a knowledge vault got a thinner workspace than a Python repo. It now covers voice enforcement against the project's own guideline files, per-type frontmatter conformance, dating temporal claims, handling contradictions, link hygiene, and research sourcing. Generated rule text is also told to conform to the target project's own voice rules.
- init-workspace derives categories and rules from the project instead of cloning a starter (SQ-1225) [`02c6582`](https://github.com/Eigenwise/eigenwise-toolshed/commit/02c6582578da792eda1510d02e78863265925550)
  Phase 0 told the agent to propose a small delta from the closest starter, which anchored it on the template and made removing an inherited category feel abnormal. The flow now enumerates what capabilities the work actually needs, requires a per-category justification and a contract, and treats the starters and rule catalogs as reference rather than a base. A generated artifact that comes out byte-identical to a template block is stated as the signal it was copied rather than derived.

#### Fixes

- Point every plugin README at the docs site and state the right install scope (SQ-1219) [`40faeb1`](https://github.com/Eigenwise/eigenwise-toolshed/commit/40faeb1b3168c01822cc50158cc529d95330d990)
  Each plugin README now opens with a link to its guide on the docs site, and says whether it installs at user scope or project scope. Model Gateway is user scope only: its wiring writes ~/.claude/settings.json and there is no project-scoped mode.
- Treat non-codebase projects as a real project class in the init-workspace stack reference (SQ-1224) [`f6c8e90`](https://github.com/Eigenwise/eigenwise-toolshed/commit/f6c8e903e56cbd5238ce6bbfc88356508f93fa7c)
  stack-plugins.md gave non-codebase projects two lines and used them as the leftover bucket. They now get a proper section, so a vault or a writing project gets a considered plugin set instead of whatever did not match a language.
- Restore the README claims that the plugin contract tests pin (SQ-1229) [`70daf4b`](https://github.com/Eigenwise/eigenwise-toolshed/commit/70daf4b4f76a)
  The README rewrite dropped three claims the suites assert on and introduced an internal identifier one of them forbids.

## v3.326.0 (2026-08-01)

### workbench 0.74.0 → 0.75.0

#### Features

- init-workspace configures the auto-compact window globally (per-project window writes removed) (SQ-1208)

## v3.325.0 (2026-08-01)

### model-gateway 0.46.1 → 0.46.2

#### Fixes

- Doctor guidance for CLAUDE_CODE_NO_MODEL_FALLBACK silent-fallback diagnosis (SQ-1204)

### sidequest 3.50.13 → 3.51.0

#### Features

- Add PreCompact compaction-policy hook (board-state pinning + gated veto) (SQ-1201)
- Brief-by-default board MCP read results (SQ-1203)

#### Fixes

- Fix compaction-policy hook registration (matcher never fired on 2.1.220) (SQ-1207)

### workbench 0.73.1 → 0.74.0

#### Features

- init-workspace compaction configuration step (window + policy) (SQ-1202)

## v3.324.0 (2026-08-01)

### model-gateway 0.46.0 → 0.46.1

#### Fixes

- Stop writing ineffective socket setting (SQ-1193)
- Document that Remote Control compatibility costs the Codex rows in the model picker (SQ-1194)

### workbench 0.73.0 → 0.73.1

#### Fixes

- Document that Remote Control compatibility costs the Codex rows in the model picker (SQ-1194)

## v3.323.0 (2026-08-01)

### model-gateway 0.45.0 → 0.46.0

#### Features

- Serve Remote Control through a local socket (SQ-1191)

## v3.322.0 (2026-08-01)

### model-gateway 0.44.4 → 0.45.0

#### Features

- Remove per-project gateway wiring mode so a project file cannot silently shadow the gateway URL (SQ-1190)

### workbench 0.72.0 → 0.73.0

#### Features

- Remove per-project gateway wiring mode so a project file cannot silently shadow the gateway URL (SQ-1190)

## v3.321.0 (2026-08-01)

### model-gateway 0.44.3 → 0.44.4

#### Fixes

- Correct model-gateway Remote Control and wiring documentation (SQ-1186)

## v3.320.0 (2026-08-01)

### model-gateway 0.44.2 → 0.44.3

#### Fixes

- Report effective gateway wiring precedence in doctor (SQ-1181)
- Adopt unmarked Remote Control loopback hosts mappings (SQ-1182)
- Cover the RC-compatibility catalog path (SQ-1183)
- Reconcile recorded project wiring when switching global (SQ-1184)
- Fix the Node 22 custom-lookup contract and a bodyless-request crash in the hosts-bypass path (SQ-1185)

### sidequest 3.50.12 → 3.50.13

#### Fixes

- Point the feature skill at the real orchestration reference and test that the path resolves (SQ-1187)
- Grant read-only executors concrete Sidequest board MCP tools (SQ-1188)

## v3.319.0 (2026-08-01)

### sidequest 3.50.11 → 3.50.12

#### Fixes

- Extract the ticket-warning factory and project store domains behind the unchanged facade (SQ-1174) [`2d5241b`](https://github.com/Eigenwise/eigenwise-toolshed/commit/2d5241b)

## v3.318.0 (2026-08-01)

### sidequest 3.50.10 → 3.50.11

#### Fixes

- Extract the path, cache, config, sweep, and server store domains behind the unchanged facade (SQ-1173) [`66c0aaa`](https://github.com/Eigenwise/eigenwise-toolshed/commit/66c0aaa)

## v3.317.0 (2026-08-01)

### sidequest 3.50.9 → 3.50.10

#### Fixes

- Extract the dispatch record store domain behind the unchanged facade (SQ-1170) [`6f66174`](https://github.com/Eigenwise/eigenwise-toolshed/commit/6f66174)

## v3.316.0 (2026-08-01)

### sidequest 3.50.8 → 3.50.9

#### Fixes

- Extract the ticket lifecycle and submission store domains behind the unchanged facade (SQ-1165) [`9f29eb9`](https://github.com/Eigenwise/eigenwise-toolshed/commit/9f29eb9)

## v3.315.0 (2026-08-01)

### sidequest 3.50.7 → 3.50.8

#### Fixes

- Extract the routing, category, and profile store domain behind the unchanged facade (SQ-1161) [`891f452`](https://github.com/Eigenwise/eigenwise-toolshed/commit/891f452)

## v3.314.0 (2026-08-01)

### sidequest 3.50.6 → 3.50.7

#### Fixes

- Extract the claim, lock, and pulse store domains behind the unchanged facade (SQ-1160) [`8f52ea6`](https://github.com/Eigenwise/eigenwise-toolshed/commit/8f52ea6)

## v3.313.0 (2026-08-01)

### sidequest 3.50.5 → 3.50.6

#### Fixes

- Extract the comment, plan, and board-read store domains behind the unchanged facade (SQ-1157) [`009dd6a`](https://github.com/Eigenwise/eigenwise-toolshed/commit/009dd6a)

## v3.312.0 (2026-08-01)

### sidequest 3.50.4 → 3.50.5

#### Fixes

- Extract the story store domain behind the unchanged facade (SQ-1155) [`c33bc37`](https://github.com/Eigenwise/eigenwise-toolshed/commit/c33bc37)

## v3.311.0 (2026-08-01)

### sidequest 3.50.3 → 3.50.4

#### Fixes

- Extract the notification and worker-registry store domains behind the unchanged facade (SQ-1154) [`5c017c8`](https://github.com/Eigenwise/eigenwise-toolshed/commit/5c017c8)

## v3.310.0 (2026-08-01)

### sidequest 3.50.2 → 3.50.3

#### Fixes

- Fail build:check on untracked generated output, not only modified files (SQ-1152) [`ccec59d`](https://github.com/Eigenwise/eigenwise-toolshed/commit/ccec59d)

## v3.309.0 (2026-08-01)

### sidequest 3.50.1 → 3.50.2

#### Fixes

- Split the CLI command handlers into per-domain modules behind an unchanged command surface (SQ-1146) [`f37c106`](https://github.com/Eigenwise/eigenwise-toolshed/commit/f37c106)

## v3.308.0 (2026-08-01)

### model-gateway 0.44.1 → 0.44.2

#### Fixes

- Extract the request worker and remaining commands so the model-gateway entry point is wiring only (SQ-1149) [`bc828c0`](https://github.com/Eigenwise/eigenwise-toolshed/commit/bc828c0)

### sidequest 3.50.0 → 3.50.1

#### Fixes

- Make the build discover nested sources and extract the first store domain module (SQ-1144) [`7ca873b`](https://github.com/Eigenwise/eigenwise-toolshed/commit/7ca873b)
- Split the MCP tool handlers into per-domain modules behind an unchanged tool surface (SQ-1147) [`efb00ae`](https://github.com/Eigenwise/eigenwise-toolshed/commit/efb00ae)

## v3.307.0 (2026-08-01)

### model-gateway 0.44.0 → 0.44.1

#### Fixes

- Extract pin management, process supervision, settings wiring, and remote control out of the model-gateway entry point (SQ-1145) [`8c9884e`](https://github.com/Eigenwise/eigenwise-toolshed/commit/8c9884e)

## v3.306.0 (2026-08-01)

### sidequest 3.49.0 → 3.50.0

#### Features

- Warn at dispatch when a ticket names symbols or ticket refs that contradict the repo and board (SQ-1141) [`8482435`](https://github.com/Eigenwise/eigenwise-toolshed/commit/84824356eee9375d398fe2cb45aaa500add711fb)

## v3.305.0 (2026-08-01)

### sidequest 3.48.0 → 3.49.0

#### Features

- Refuse prose or environment-broken verify fields at authoring time and validate them before merge (SQ-1125) [`d36c9b5`](https://github.com/Eigenwise/eigenwise-toolshed/commit/d36c9b52f4f05af6d55f35e55ddbf8784e758e2f)
- Executors checkpoint findings to the board and request scope instead of shipping workarounds (SQ-1138) [`053e2ba`](https://github.com/Eigenwise/eigenwise-toolshed/commit/053e2bae5997c616797cc04b0c791b3d9313af9b)

## v3.304.0 (2026-07-31)

### sidequest 3.47.1 → 3.48.0

#### Features

- A green suite's full output was 43k tokens of nothing (SQ-1129) [`1e6d5a1`](https://github.com/Eigenwise/eigenwise-toolshed/commit/1e6d5a1)
  Running the sidequest suite emitted 177,001 bytes across 4,788 lines. Executors run a gate several times, so a single ticket could spend well over 100k tokens ingesting TAP that says 'ok'. Two executors were killed by context exhaustion in one evening with this as the dominant cost.

  Verify discipline now redirects the full gate to a temporary log and prints only the exit status and the TAP summary counts, reading log ranges around a failure rather than dumping the file. Filtered green output is 110 bytes across 6 lines. The wrapper preserves the command's exit code, so filtering never weakens the submission gate, and a briefing can supply the wrapper with the ticket's exact command already filled in.

## v3.303.0 (2026-07-31)

### sidequest 3.47.0 → 3.47.1

#### Fixes

- Contended ticket-lock writers starved the lock holder under load (SQ-1133) [`226f257`](https://github.com/Eigenwise/eigenwise-toolshed/commit/226f257)
  The ticket lock's wait was a busy spin on Date.now(). On a loaded machine the waiting process consumed the CPU the lock holder needed to finish its transaction, so a concurrent close could fail rather than resolving into one idempotent and one non-idempotent winner. It surfaced as an intermittent test failure that only appeared when the machine was saturated, and it failed a release gate on a commit that could not have caused it.

  Contended writers now sleep instead of spinning. The abandoned-lock threshold also moved from 5s to 30s, so a live-but-starved holder is no longer mistaken for a crashed one; a genuinely crashed holder still releases its ticket rather than wedging it forever.

  The test's failure message now reports each call's exit status, signal, stdout and stderr. It previously interpolated stderr alone, so the release log recorded a bare 'done race failed:' with nothing after it.

## v3.302.0 (2026-07-31)

### sidequest 3.46.0 → 3.47.0

#### Features

- Read-only executors were locked out of every MCP but two hardcoded ones (SQ-1122) [`81a95e0`](https://github.com/Eigenwise/eigenwise-toolshed/commit/81a95e0)
  Read-only executor agents now receive MCP tools by default (mcp__*) instead of an enumerated pair. The previous list named only the plugin-provided Playwright server, so a Playwright MCP configured directly in .mcp.json (mcp__playwright__*) was still blocked, as was every other server: Context7, chrome-devtools, a Notion or other data-source MCP. Each new one meant another hardcoded entry, and until someone noticed, executors improvised through Bash while the orchestrator invented per-ticket guardrails.

  The old list was also incoherent about its own purpose. It already granted Bash, which can modify anything, and the board's own MCP tools, which write board state. Blocking a read-only lookup while allowing Bash protected nothing. The contract is that a read-only executor does not modify the repository working tree, and MCP membership is unrelated to that.

  Boards that need to withhold a specific server can set readOnlyDeniedTools. The resolved per-board list feeds the agent-definition cache signature, so two boards with different denylists cannot collide on one cached definition.
- The pending-submission nudge fired once and never again (SQ-1123) [`815cb90`](https://github.com/Eigenwise/eigenwise-toolshed/commit/815cb90)
  A submitted ticket awaiting integration is the highest-value item on a board, and the Stop-hook reminder for it deduplicated on a signature of the open tickets. A submission that just sits there produces an identical signature every turn, so the nudge fired exactly once and stayed silent for every later stop. The board state that most needed escalation was precisely the one that was not changing, and recovery depended on a human noticing an idle orchestrator.

  Pending submissions now re-escalate after three consecutive stops on an unchanged board, naming the specific refs and the action to take rather than repeating the same line. The deduplication is kept for everything else, so a stable board still does not nag.

## v3.301.0 (2026-07-31)

### skill-retro 0.2.0 → 0.3.0

#### Features

- skill-retro amends an existing skill instead of only adding a new one (SQ-1130) [`3abb97b`](https://github.com/Eigenwise/eigenwise-toolshed/commit/3abb97b24b9f3c754247ae2036085ecc0c3ecb4c)

## v3.300.0 (2026-07-31)

### model-gateway 0.43.0 → 0.44.0

#### Features

- Gateway context overflow was indistinguishable from a 32MB body cap (SQ-880) [`fbe245b`](https://github.com/Eigenwise/eigenwise-toolshed/commit/fbe245b)
  The gateway returns HTTP 413 request_too_large when a Codex context crosses its compaction trigger, which is deliberate: that is what makes Claude Code compact and retry. But Claude Code renders any 413 of that type as 'Request too large (max 32MB). Accumulated images and attachments in the conversation pushed the request over the limit.' So an agent overflowing its own token window looked exactly like a byte-cap rejection caused by pasted screenshots, and the only thing saying otherwise was buried in errorDetails.

  The sentry message now identifies itself: 'Prompt is too long for the Codex context window; compact and retry. (<actual> tokens > <trigger> tokens)'. The status and error type are unchanged, so auto-compact still works.

  The orchestration guidance was wrong in the same way and is corrected. It told orchestrators that a 32MB launch failure was non-retryable inherited attachments from the parent and to compact the parent session. Measured wire data says otherwise: executor request bodies peaked at 1.37MB while the orchestrator peaked at 2.44MB, and there is no inherited attachment envelope. The rule now says diagnose first, and for the token signature dispatch one fresh executor with tighter scope rather than compacting the parent.

### sidequest 3.45.0 → 3.46.0

#### Features

- Gateway context overflow was indistinguishable from a 32MB body cap (SQ-880) [`fbe245b`](https://github.com/Eigenwise/eigenwise-toolshed/commit/fbe245b)
  The gateway returns HTTP 413 request_too_large when a Codex context crosses its compaction trigger, which is deliberate: that is what makes Claude Code compact and retry. But Claude Code renders any 413 of that type as 'Request too large (max 32MB). Accumulated images and attachments in the conversation pushed the request over the limit.' So an agent overflowing its own token window looked exactly like a byte-cap rejection caused by pasted screenshots, and the only thing saying otherwise was buried in errorDetails.

  The sentry message now identifies itself: 'Prompt is too long for the Codex context window; compact and retry. (<actual> tokens > <trigger> tokens)'. The status and error type are unchanged, so auto-compact still works.

  The orchestration guidance was wrong in the same way and is corrected. It told orchestrators that a 32MB launch failure was non-retryable inherited attachments from the parent and to compact the parent session. Measured wire data says otherwise: executor request bodies peaked at 1.37MB while the orchestrator peaked at 2.44MB, and there is no inherited attachment envelope. The rule now says diagnose first, and for the token signature dispatch one fresh executor with tighter scope rather than compacting the parent.

## v3.299.0 (2026-07-31)

### model-gateway 0.42.0 → 0.43.0

#### Features

- The request-body guard measures the transcript instead of the request (SQ-879) [`a014120`](https://github.com/Eigenwise/eigenwise-toolshed/commit/a014120)
  The 32MB request-body warning read the whole transcript .jsonl and reported attachments plus 1.1x the rest. Measured against real wire data that overstated the request body by 15x to 40x: the guard reported 29-39MB on a session whose largest actual request was 2.30MB. It counted history discarded by compaction, per-record bookkeeping that never leaves the machine, and pasted images twice, and it went silent above a 36MB transcript, so it was dark on exactly the sessions that needed it. The remedy it printed, run /compact, could not move the number it reported.

  The gateway already computes the true size of every forwarded request, so it now keeps a small per-session high-water record and the hook reads that instead. The guard reflects the real body, works regardless of transcript size, and costs a sub-kilobyte read per spawn rather than a 175ms whole-file scan. The warning threshold is 24MB of the 32MB cap; the largest body ever measured in this project was 7.19MB.

### workbench 0.71.0 → 0.72.0

#### Features

- The request-body guard measures the transcript instead of the request (SQ-879) [`a014120`](https://github.com/Eigenwise/eigenwise-toolshed/commit/a014120)
  The 32MB request-body warning read the whole transcript .jsonl and reported attachments plus 1.1x the rest. Measured against real wire data that overstated the request body by 15x to 40x: the guard reported 29-39MB on a session whose largest actual request was 2.30MB. It counted history discarded by compaction, per-record bookkeeping that never leaves the machine, and pasted images twice, and it went silent above a 36MB transcript, so it was dark on exactly the sessions that needed it. The remedy it printed, run /compact, could not move the number it reported.

  The gateway already computes the true size of every forwarded request, so it now keeps a small per-session high-water record and the hook reads that instead. The guard reflects the real body, works regardless of transcript size, and costs a sub-kilobyte read per spawn rather than a 175ms whole-file scan. The warning threshold is 24MB of the 32MB cap; the largest body ever measured in this project was 7.19MB.

## v3.298.0 (2026-07-31)

### sidequest 3.44.0 → 3.45.0

#### Features

- Read-only executors can't drive Playwright, and their no-write promise is false (SQ-1113) [`bd64515`](https://github.com/Eigenwise/eigenwise-toolshed/commit/bd64515)
  Read-only executor agents now get the Playwright MCP tools, so a visual-review ticket can drive a browser through a sanctioned tool instead of improvising one from Bash. The role note also describes the real boundary now: don't modify the repo working tree, Bash is for inspection and tests, scratch goes in the session scratchpad, no installs into the project's package.json or node_modules. It previously claimed the tools could not change files at all, which was never true with Bash in the same allowlist.

## v3.297.0 (2026-07-31)

### live-rules 2.8.0 → 2.9.0

#### Features

- live-rules migration must remove the monolith it replaces (SQ-1105) [`7f311ed`](https://github.com/Eigenwise/eigenwise-toolshed/commit/7f311ed)
  Migrating a project from .claude/live-rules.md to the atomic .claude/live-rules/ directory now finishes the job: it writes the atomic set, loads it back, compares every rule field for field, and removes the monolith only once they match. On any mismatch it keeps both files and says why. The retired monolith was still a live fallback the loader picked up whenever the manifest failed to parse, so leaving it behind meant a stale copy could silently win later. An explicit LIVE_RULES_PATH is left alone.

## v3.296.0 (2026-07-31)

### live-rules 2.7.3 → 2.8.0

#### Features

- live-rules injection header names the legacy monolith even when atomic rules are loaded (SQ-1104) [`8f873e9`](https://github.com/Eigenwise/eigenwise-toolshed/commit/8f873e9)
  The injected Source line always printed .claude/live-rules.md, even when the atomic .claude/live-rules/ directory was the loader's actual source, so the header contradicted what was loaded. It now names the real source. Rules dropped from an atomic set are also surfaced by name instead of vanishing behind a bare stale flag.

## v3.295.0 (2026-07-31)

### sidequest 3.43.0 → 3.44.0

#### Features

- State resolved worktree identity in dispatch briefings (SQ-1091) [`2808252`](https://github.com/Eigenwise/eigenwise-toolshed/commit/2808252)
  Executors opened by probing for where they were: git rev-parse --git-dir with --git-common-dir and status --short ran 98 times across 7 distinct executor types in four days, 230 runs of that family costing 22.9 minutes, for information dispatch already held when it wrote the briefing. The briefing now states the resolved worktree path, git-dir, and whether the checkout is linked or shared.

#### Fixes

- Retire the dead dev branch from CI and release tooling (SQ-1096) [`f15b6e0`](https://github.com/Eigenwise/eigenwise-toolshed/commit/f15b6e03f020ef9de699a5a8d475d6c285674c03)
  test.yml now runs on main pushes instead of the dead dev branch, which had left main pushes with no test coverage. cut.mjs drops the stale restore-the-invariant instruction and its unused integration-branch flag; release-guard no longer triggers on dev.

## v3.294.0 (2026-07-31)

### codebase-mapper 2.11.3 → 2.12.0

#### Features

- Inject the codebase map into work subagents at SubagentStart (SQ-1089) [`6216880`](https://github.com/Eigenwise/eigenwise-toolshed/commit/6216880)
  Subagents started with no map and re-read it by hand: 851 orienting reads costing ~134 min and ~4.44M fresh tokens across 58 transcripts in four days, with modules.md itself among the most re-read files. The map is now injected at SubagentStart, matcher-scoped to work-executing agent types so cheap recon agents do not pay for context they will not use. Also stops the test suite inheriting CLAUDE_PROJECT_DIR, which had been silently pointing every temp-fixture test at the real repo whenever the variable was set.

### sidequest 3.42.4 → 3.43.0

#### Features

- Preload verify discipline into every dispatched executor (SQ-1090) [`4a68a9a`](https://github.com/Eigenwise/eigenwise-toolshed/commit/4a68a9a)
  Test and check commands were 284.5 of the 341 minutes of shell wall clock measured over four days, 566 of 693 runs by subagents, with test:full averaging 51.3s against 21.5s for a scoped run. A new verify-discipline skill is preloaded through the subagent skills: frontmatter field, which injects full skill content at startup and is the only route that reaches read-only executors, whose tool list omits Skill.

### skill-retro 0.1.0 → 0.2.0

#### Features

- Rank findings by elapsed time, not only occurrence count (SQ-1092) [`e52742b`](https://github.com/Eigenwise/eigenwise-toolshed/commit/e52742b)
  Ranking by count alone could not answer which repeated work actually costs anything: npm ci looked significant at 193 runs but only 16.9 minutes, while the verify loop was 284.5. Elapsed time now flows through from the transcript records and appears alongside occurrence count in the ranked table and per-finding detail.

#### Fixes

- Report an unavailable replay shell instead of calling the script broken (SQ-1093) [`f075bfb`](https://github.com/Eigenwise/eigenwise-toolshed/commit/f075bfb)
  Salvage replay hardcoded bash -lc. Under cmd.exe, where bash is not on PATH, the spawn failure was reported as nonzero-exit, the same status a genuinely broken script gets, so a working salvaged script was labelled broken. An unavailable shell is now a distinct status. Present in 0.1.0 and hidden because CI runs on Linux and local runs use Git Bash.

## v3.293.0 (2026-07-31)

### skill-retro 0.0.0 → 0.1.0

#### Features

- Add skill-retro: mine transcripts for repeated work and route it to durable fixes (SQ-1088) [`19dc097`](https://github.com/Eigenwise/eigenwise-toolshed/commit/19dc09735f83a442fc5e41e42224004cab2c8006)
  Finds the work that keeps getting redone across recent sessions and proposes where each fix belongs: a skill, a bundled script, a live rule, a memory entry, a map edit, or nothing. It reads subagent transcripts too, which is where most of the work in an orchestrated repo actually happens, and the actor decides the route: a skill never reaches an executor, so repetition by executors goes to a script or a rule instead. Transcripts are streamed by a bundled CLI and never loaded into context. Workbench retro now points at it for anything spanning more than the current session.

### workbench 0.70.3 → 0.71.0

#### Features

- Add skill-retro: mine transcripts for repeated work and route it to durable fixes (SQ-1088) [`19dc097`](https://github.com/Eigenwise/eigenwise-toolshed/commit/19dc09735f83a442fc5e41e42224004cab2c8006)
  Finds the work that keeps getting redone across recent sessions and proposes where each fix belongs: a skill, a bundled script, a live rule, a memory entry, a map edit, or nothing. It reads subagent transcripts too, which is where most of the work in an orchestrated repo actually happens, and the actor decides the route: a skill never reaches an executor, so repetition by executors goes to a script or a rule instead. Transcripts are streamed by a bundled CLI and never loaded into context. Workbench retro now points at it for anything spanning more than the current session.

## v3.292.0 (2026-07-31)

### model-gateway 0.41.0 → 0.42.0

#### Features

- Picking a wiring mode now actually wires it (SQ-1085) [`ecb7a0e`](https://github.com/Eigenwise/eigenwise-toolshed/commit/ecb7a0ec0087636c988037476b6d45b4d4fde399)
  env --mode global recorded a preference and wrote nothing, so a machine could sit in global mode with unwired user settings and every project outside an explicitly-wired repo silently had no gateway models. doctor printed that state as a neutral line among healthy ones. Selecting a mode now completes the wiring, doctor treats an unwired active scope as a failure with the repair command and a nonzero exit, and it also names the case where a project env block masks global wiring.

## v3.291.0 (2026-07-31)

### sidequest 3.42.3 → 3.42.4

#### Fixes

- Stop hook stops nagging about tickets a live executor is working (SQ-1083) [`f790c9c`](https://github.com/Eigenwise/eigenwise-toolshed/commit/f790c9c6b602754aa30aae82788444f3ffd572ca)
  The board reconciliation reminder counted every ticket this session dispatched as debt, so a normal parallel wave nagged for its whole duration in one bucket or the other: 'N tickets in doing' while executors worked, 'N tickets still open' before they claimed. It now keys on dispatch liveness instead of status. A live dispatch is never debt. A dispatch that went terminal without a submission still is, which is the stranded-executor case the reminder is actually for.
- Executors are told to run gates in the foreground (SQ-1084) [`7593b20`](https://github.com/Eigenwise/eigenwise-toolshed/commit/7593b2062ace6c93175e1045aa3b69ba828d9c2c)
  Two executors backgrounded their gate runs behind monitors of processes that were never started, then slept forever holding their claims while the board read healthy. Every dispatched executor prompt now carries the rule: foreground with a bounded timeout, never sleep on a monitor for your own work, and if a run must be backgrounded, confirm it started and poll in a bounded loop that fails loud.

## v3.290.0 (2026-07-31)

### sidequest 3.42.2 → 3.42.3

#### Fixes

- Do not reclaim a claim while its verify is still running (SQ-1082) [`caf24ba`](https://github.com/Eigenwise/eigenwise-toolshed/commit/caf24baf68867fd9a7948092e7dc9cf685461b07)
  An executor blocked on a long verify looked identical to a dead one, so its claim could be swept out from under it and its commit refused. Claims now carry a verification marker, pulse reports whether a claim is verifying, and a claim is not reclaimable while that marker is live. An uncompleted marker still releases at the existing abandon backstop, so a crashed executor cannot pin a claim forever.

## v3.289.0 (2026-07-30)

### sidequest 3.42.1 → 3.42.2

#### Fixes

- Warn about build output, read-only browser reviews, and unrunnable verify commands (SQ-1081) [`6c5ec3b`](https://github.com/Eigenwise/eigenwise-toolshed/commit/6c5ec3bf7bf43d040e24b969871eb8dae8b34779)
  Filing a ticket now warns when its scope changes source for a package whose build output is tracked but left out of scope, when a read-only ticket asks for browser or visual review work an executor with no write tool cannot do, and when a recorded verify command would not run from the directory it names. Adds short guidance that one ticket per wave owns a content-hashed build, and that a different test failing each run points at the runner rather than the tests.

## v3.288.0 (2026-07-30)

### sidequest 3.42.0 → 3.42.1

#### Fixes

- Dashboard tour and board menu follow-ups (SQ-1079) [`5e4daad`](https://github.com/Eigenwise/eigenwise-toolshed/commit/5e4daad7bbe9326c22e0062e3b75a03918351212)
  The tour opens the most illustrative ticket rather than the first (SQ-1074), and ends by showing how to archive or delete a board, noting it comes back when an agent starts work there again (SQ-1079). Right-clicking a board opens its menu at the pointer, flipped and clamped to stay on screen (SQ-1078), and that menu now shows Archive and Delete for active boards instead of misreading an archived-ticket count as an archived board (SQ-1060).
- Stabilize the full test runner (SQ-1080) [`e7c4fe0`](https://github.com/Eigenwise/eigenwise-toolshed/commit/e7c4fe0d56317df1fc86f7896f2399dcc611c643)
  The runner handed every test file to Node's default 32-way concurrency while several of those files spawn their own Git, SQLite, dashboard and hook subprocesses, so unrelated tests failed at random under the load. It now sorts the file list and caps test-file concurrency at 4.

## v3.287.0 (2026-07-30)

### model-gateway 0.40.0 → 0.41.0

#### Features

- Catalog schema v4: provider-generic models and readiness (SQ-1070) [`e89a01c`](https://github.com/Eigenwise/eigenwise-toolshed/commit/e89a01cd99adaacef3c3943aa8fe98722d1708e5)
  Catalog entries now carry a provider slug, Grok models are advertised alongside Codex, and a per-provider readiness map replaces the codex-only key (codexReadiness still mirrored for older readers).

### sidequest 3.41.0 → 3.42.0

#### Features

- Provider-generic dispatch readiness (SQ-1071) [`2b2a720`](https://github.com/Eigenwise/eigenwise-toolshed/commit/2b2a72088d8229dafcc39b8966553acf037d5a9b)
  Dispatch readiness is no longer codex-only: the route's model resolves to its catalog provider and that provider's readiness is checked, refusing loudly on unknown or unready backends (Grok included). Schema 2/3 catalogs keep today's behavior.
- Interactive first-run tour for the dashboard (US-35) [`ef198e7`](https://github.com/Eigenwise/eigenwise-toolshed/commit/ef198e70e50a213aa4a4e439bbeb74f7f4ddc057)
  Auto-starts once on a first visit and walks the board as read-first orientation: what each surface is and where to look, since agents file most tickets and people are mostly reading. Spotlights each target, opens a real ticket to show the comment thread, and remembers where you stopped. Replay it from Settings under Appearance, or press ?.

#### Fixes

- Cross-board Model routing settings table (SQ-1059) [`7a6ead9`](https://github.com/Eigenwise/eigenwise-toolshed/commit/7a6ead9)
  Replaced the single-board 'Routing enabled' toggle in Settings with a cross-board table (one row per board, per-row checkbox, Check all/Uncheck all).

### workbench 0.70.2 → 0.70.3

#### Fixes

- init-workspace wires the gateway mode it asks about, global now recommended (SQ-1061) [`9b03dfa`](https://github.com/Eigenwise/eigenwise-toolshed/commit/9b03dfa37b443ae7a3cf305a96f455e7e29420b8)
  init-workspace now recommends global gateway wiring (per-project wiring never reaches executor worktrees), runs env --write-project immediately when per-project is still chosen, and reports wiring status in the wrap-up. Docs prose updated to match.

## v3.285.0 (2026-07-29)

### sidequest 3.40.2 → 3.40.3

#### Fixes

- Publishing from a scratch worktree inside the OS temp dir fails Sidequest tests (SQ-891) [`3bc6e7f`](https://github.com/Eigenwise/eigenwise-toolshed/commit/3bc6e7f)
  Make the outside-temp cleanup fixture path-independent so release suites pass from clean scratch worktrees under the OS temp directory.
- Helper routing must prefer board categories before generic fallback (SQ-1045) [`2adc155`](https://github.com/Eigenwise/eigenwise-toolshed/commit/2adc155)
  Require category-first board routing, allow safeguarded generic helpers only when no category applies, and route audit/review prompts through review-audit.
- Apply inline-safe gate before ticketing one-line housekeeping (SQ-1046) [`2389d92`](https://github.com/Eigenwise/eigenwise-toolshed/commit/2389d92)
  Run the inline-safe check before solo-fit and ticket filing; exact one-line .gitignore housekeeping now stays inline.

## v3.284.0 (2026-07-29)

### sidequest 3.40.1 → 3.40.2

#### Fixes

- Mixed scope requests stay coherent through approval (SQ-1020) [`7e64ec2`](https://github.com/Eigenwise/eigenwise-toolshed/commit/7e64ec2d1a4808b19a9c216efae4710aa11bad7c)
  A request mixing already-effective and pending paths reports exactly which paths need approval, keeps the full intended commit scope after approval, and can no longer produce a partial commit of only the pre-approved subset.

## v3.283.0 (2026-07-29)

### sidequest 3.40.0 → 3.40.1

#### Fixes

- Files-only ticket updates no longer emit stale unknown-ref warnings (SQ-1018) [`fb4387e`](https://github.com/Eigenwise/eigenwise-toolshed/commit/fb4387ecc03becef7fbee9d4ee40a7b82c4c46b9)
  Reference warnings are derived only from the fields an update actually changed, so approving scope no longer resurfaces unknown refs quoted in older ticket text.

## v3.282.0 (2026-07-29)

### sidequest 3.39.1 → 3.40.0

#### Features

- Dispatch refuses GPT-routed tickets when Codex is down (SQ-1025) [`c3c66b8`](https://github.com/Eigenwise/eigenwise-toolshed/commit/c3c66b8bec14ed1072c238616fe2a83cee8f234c)
  prepareDispatch requires live provider readiness before preparing a token: a dead Codex backend refuses the dispatch with recovery steps, same-provider fallback records fallbackReason, and silent cross-provider substitution to a Claude model is no longer possible.

## v3.281.0 (2026-07-29)

### workbench 0.70.1 → 0.70.2

#### Fixes

- Updater migrates installed codex-gateway after the rename (SQ-1022) [`dd430c5`](https://github.com/Eigenwise/eigenwise-toolshed/commit/dd430c56ed29731e16586919e81fe0e8d7e782c0)
  update-toolshed recognizes a recorded codex-gateway install, migrates it to model-gateway at the same scope, and documents the manual path.

## v3.280.0 (2026-07-29)

### sidequest 3.39.0 → 3.39.1

#### Fixes

- Stop-time board reminder now reaches the agent (SQ-1031) [`8f22a2d`](https://github.com/Eigenwise/eigenwise-toolshed/commit/8f22a2d04c17064e76d273e80a9451720b6ab4ab)
  The reconciliation reminder emits Stop additionalContext the model acts on, guarded by stop_hook_active and a per-state ceiling, alongside the user-visible line.
- Helpers no longer cite the ticket's own strings as evidence (SQ-1032) [`1b77c02`](https://github.com/Eigenwise/eigenwise-toolshed/commit/1b77c024faa9bb980556bf06a0a7d9d8e9cd3135)
  Helper searches resolving into the current session's own transcripts are reported as self-reference, and executor guidance names the quoted-evidence trap.

## v3.279.0 (2026-07-29)

### sidequest 3.38.8 → 3.39.0

#### Features

- Integrate runs the recorded verify command and refuses done on failure (SQ-1035) [`46c7191`](https://github.com/Eigenwise/eigenwise-toolshed/commit/46c7191d65dded23b5f7e3e92d269ea6367749d3)
  Integration now machine-checks the submission's verify command against the delivered result: failure or timeout delivers but refuses done with exit code and output tail; skipping requires an explicit recorded flag.

## v3.278.0 (2026-07-29)

### sidequest 3.38.7 → 3.38.8

#### Fixes

- Dispatch worktrees honor integrationBranch (SQ-1034) [`4e68f71`](https://github.com/Eigenwise/eigenwise-toolshed/commit/4e68f71e41fe5a9e0945dacbba78f59843ade144)
  An explicit integrationBranch now sets the executor worktree base and the delivery target; an unresolvable branch refuses the dispatch with the ref named instead of silently substituting the default base.

## v3.277.0 (2026-07-29)

### sidequest 3.38.6 → 3.38.7

#### Fixes

- Shared-tree gate no longer blocks done over unrelated dirty files (SQ-1033) [`a3b276b`](https://github.com/Eigenwise/eigenwise-toolshed/commit/a3b276ba731085dd40938854bcd93b9f7ade06af)
  The done-path dirty check is scoped to the ticket's own files; bystander changes elsewhere in a shared checkout no longer strand finished, committed work in doing.

## v3.276.0 (2026-07-29)

### sidequest 3.38.5 → 3.38.6

#### Fixes

- Terminal executors cannot write after resurrection (SQ-1030) [`172817d`](https://github.com/Eigenwise/eigenwise-toolshed/commit/172817dcc7057d3213ed3f9a0a42095db046aace)
  The worktree-isolation guard used to drop its record on submit/release, so a resumed executor fell through to the shared checkout. It now fails closed: a terminal ticket, a missing dispatch record, or a cross-project target all refuse the write.

## v3.275.0 (2026-07-29)

### sidequest 3.38.4 → 3.38.5

#### Fixes

- Constrain executor sub-delegation (SQ-1029) [`661f473`](https://github.com/Eigenwise/eigenwise-toolshed/commit/661f473538e358f1079caa53dec2bee380294d17)
  Executor helper spawns are limited to an allowlist, forced into the background so they stay steerable, denied a default model, and no longer isolated into a worktree that cannot see the parent's work.

## v3.274.0 (2026-07-29)

### model-gateway 0.39.0 → 0.40.0

#### Features

- Gateway: one Codex readiness predicate shared by ensure, doctor, and consumers (SQ-1024) [`d636ec5`](https://github.com/Eigenwise/eigenwise-toolshed/commit/d636ec5d2d554403ae48ac22b941ddad1eb45939)
  Adds an event-driven readiness signal covering binary, proxy, auth, shim, serving version, and a retained upstream-blocked state; ensure and doctor now read one predicate instead of re-deriving liveness.

## v3.273.0 (2026-07-29)

### sidequest 3.38.3 → 3.38.4

#### Fixes

- Sidequest blocks sub-delegation from generic subagents (SQ-1027) [`2ce5843`](https://github.com/Eigenwise/eigenwise-toolshed/commit/2ce5843c92664e6f64e5dc203d216ead06f9fa24)
  The generic-Agent guard now keys on spawn depth, so an already-running subagent can sub-delegate; the main-loop deny is unchanged.

## v3.272.0 (2026-07-29)

### model-gateway 0.38.1 → 0.39.0

#### Features

- Streamline gateway model IDs (SQ-1004) [`e675027`](https://github.com/Eigenwise/eigenwise-toolshed/commit/e675027)
  Advertises claude-gpt-* and claude-grok-4.5 while preserving legacy IDs and existing Sidequest catalog slugs.

### sidequest 3.38.2 → 3.38.3

#### Fixes

- Streamline gateway model IDs (SQ-1004) [`e675027`](https://github.com/Eigenwise/eigenwise-toolshed/commit/e675027)
  Advertises claude-gpt-* and claude-grok-4.5 while preserving legacy IDs and existing Sidequest catalog slugs.

### workbench 0.70.0 → 0.70.1

#### Fixes

- Streamline gateway model IDs (SQ-1004) [`e675027`](https://github.com/Eigenwise/eigenwise-toolshed/commit/e675027)
  Advertises claude-gpt-* and claude-grok-4.5 while preserving legacy IDs and existing Sidequest catalog slugs.

## v3.271.0 (2026-07-29)

### sidequest 3.38.1 → 3.38.2

#### Fixes

- Warn when a write-scope ticket is filed with no declared files (SQ-1009) [`8ae8f5d`](https://github.com/Eigenwise/eigenwise-toolshed/commit/8ae8f5d757b6f1bc7e07cb289c3c9a9a67378a29)
- Releasing a ticket must clear its submission so redispatch works (SQ-1010) [`c778141`](https://github.com/Eigenwise/eigenwise-toolshed/commit/c778141508f317a72530b3b0fd7945cbaaa4e553)
- Give tickets a plan document: large storage, on-demand read, never inlined (SQ-1015) [`2dc8ae5`](https://github.com/Eigenwise/eigenwise-toolshed/commit/2dc8ae5ea45bb7221f6e6e0a3372f6bdc6378914)
- Dispatch must refuse before spawning when the target project has no Sidequest MCP install (SQ-1017) [`641ceb3`](https://github.com/Eigenwise/eigenwise-toolshed/commit/641ceb36600bf92c32ed127b2667d3ff5b195c78)

## v3.270.0 (2026-07-29)

### sidequest 3.38.0 → 3.38.1

#### Fixes

- Executor stops after Monitor timeout while its required background job keeps running (SQ-1016) [`41459b5`](https://github.com/Eigenwise/eigenwise-toolshed/commit/41459b5b2504e302db3b917c51f874bc3e0722d4)

## v3.269.0 (2026-07-28)

### sidequest 3.37.1 → 3.38.0

#### Features

- Partial submissions can no longer report themselves ready for integration (SQ-1008) [`0b2605d`](https://github.com/Eigenwise/eigenwise-toolshed/commit/0b2605d3d81e9f9b39fbcc47114af512c20bb8ea)

#### Fixes

- Hook byte-budget tests no longer measure the repo's own path (SQ-1011) [`7c1bdc0`](https://github.com/Eigenwise/eigenwise-toolshed/commit/7c1bdc0c23b515d087366b40d4c1755e67a522c9)
- The pinned test plugin root is per-checkout, so concurrent worktrees stop sharing one junction (SQ-1013) [`e98b876`](https://github.com/Eigenwise/eigenwise-toolshed/commit/e98b876ef10210a99e83cf22f60f5e1683b6a401)

## v3.268.0 (2026-07-28)

### model-gateway 0.38.0 → 0.38.1

#### Fixes

- Docs moved to the model-gateway name, with redirects for the old slugs (SQ-1002) [`2cc5824`](https://github.com/Eigenwise/eigenwise-toolshed/commit/2cc5824c3b69835343df94d285949014b7ce47c7)
- The CLI no longer tells users to run a slash command that was renamed away (SQ-1007) [`d021499`](https://github.com/Eigenwise/eigenwise-toolshed/commit/d0214990710a76e0844bc3d38e6f30e06f133edd)

## v3.267.0 (2026-07-28)

### model-gateway 0.37.0 → 0.38.0

#### Features

- Renamed the codex-gateway plugin to model-gateway (SQ-1001) [`19e36c0`](https://github.com/Eigenwise/eigenwise-toolshed/commit/19e36c0987cad1b1b341eb5d5f2cfa154de68885)

## v3.266.0 (2026-07-28)

### codex-gateway 0.36.3 → 0.37.0

#### Features

- WebSearch works on Grok via its native server-side web_search tool (SQ-1000) [`6e004bd`](https://github.com/Eigenwise/eigenwise-toolshed/commit/6e004bdddf741b5be8e902cc45e9d4e0e3f1242a)

## v3.265.0 (2026-07-28)

### codex-gateway 0.36.2 → 0.36.3

#### Fixes

- Grok Build no longer sends reasoning effort it cannot accept (SQ-998) [`e7babd4`](https://github.com/Eigenwise/eigenwise-toolshed/commit/e7babd409150f3a5f3d00eea00bdc04b92adbb25)

## v3.264.0 (2026-07-28)

### codex-gateway 0.36.1 → 0.36.2

#### Fixes

- Fix Grok streaming tool calls losing their name and call id (SQ-995) [`679c65b`](https://github.com/Eigenwise/eigenwise-toolshed/commit/679c65bc3d20f5679d1d4c7b0e448612dc0f78e2)
- Enforce a single gateway supervisor and report the serving version (SQ-996) [`52e6b8f`](https://github.com/Eigenwise/eigenwise-toolshed/commit/52e6b8f8be8e89a657eb2960f2b8826dc927ee48)
- Stop gateway-usage temp-dir teardown flaking on Windows (SQ-997) [`1b838a9`](https://github.com/Eigenwise/eigenwise-toolshed/commit/1b838a9be70ff5c945e108b30838083ee3f5920e)

## v3.263.0 (2026-07-28)

### codex-gateway 0.36.0 → 0.36.1

#### Fixes

- Fix Grok 422 on transcripts containing tool calls (SQ-994) [`29afd90`](https://github.com/Eigenwise/eigenwise-toolshed/commit/29afd9017ef22ef2bbf6e4da43aa1f0fa5018861)

## v3.262.0 (2026-07-28)

### codex-gateway 0.35.1 → 0.36.0

#### Features

- Grok subscription backend via cli-chat-proxy.grok.com (SQ-992) [`41e98e5`](https://github.com/Eigenwise/eigenwise-toolshed/commit/41e98e57dee92ef2ed550d3e815eb4ff880e5bab)

## v3.261.0 (2026-07-28)

### sidequest 3.37.0 → 3.37.1

#### Fixes

- Worktree sweep bounds its orphan-branch scan (SQ-990) [`cf04a72`](https://github.com/Eigenwise/eigenwise-toolshed/commit/cf04a72)

## v3.260.0 (2026-07-28)

### sidequest 3.36.0 → 3.37.0

#### Features

- SessionStart no longer blocks on worktree sweep (SQ-988) [`ebf9c7a`](https://github.com/Eigenwise/eigenwise-toolshed/commit/ebf9c7a)

## v3.259.0 (2026-07-28)

### sidequest 3.35.1 → 3.36.0

#### Features

- Integrator delivery modes: merge, replay, apply (SQ-980) [`dcbe1a7`](https://github.com/Eigenwise/eigenwise-toolshed/commit/dcbe1a7)

### workbench 0.69.2 → 0.70.0

#### Features

- Honest dispatch cost: codex-auto exclusion and gateway cost panel (SQ-984) [`dcbe1a7`](https://github.com/Eigenwise/eigenwise-toolshed/commit/dcbe1a7)

## v3.258.0 (2026-07-28)

### workbench 0.69.1 → 0.69.2

#### Fixes

- otel-collector sample config includes gateway logs (SQ-985) [`4b030a9`](https://github.com/Eigenwise/eigenwise-toolshed/commit/4b030a9)

## v3.257.0 (2026-07-28)

### workbench 0.69.0 → 0.69.1

#### Fixes

- Haiku 4.5 priced in the usage dashboard (SQ-981) [`9f763e6`](https://github.com/Eigenwise/eigenwise-toolshed/commit/9f763e6)

## v3.256.0 (2026-07-28)

### sidequest 3.35.0 → 3.35.1

#### Fixes

- Stronger agent-teams usage directive (SQ-979) [`7b99395`](https://github.com/Eigenwise/eigenwise-toolshed/commit/7b99395)

## v3.255.0 (2026-07-28)

### sidequest 3.34.0 → 3.35.0

#### Features

- Direct-ok ceremony replaced by inline-safe allowlist (SQ-976) [`02bd413`](https://github.com/Eigenwise/eigenwise-toolshed/commit/02bd413)

## v3.254.0 (2026-07-28)

### sidequest 3.33.0 → 3.34.0

#### Features

- Submission rejection preserves verified work: quarantine ref + needs-rebase recovery; parent-history merge commits no longer invalidate ranges (dispatch baseline) (SQ-971) [`3448b9e`](https://github.com/Eigenwise/eigenwise-toolshed/commit/3448b9ee9c16a6be001557005edec3dea6d67915)

## v3.253.0 (2026-07-28)

### sidequest 3.32.0 → 3.33.0

#### Features

- Parallel-first orchestration: maximize the ready set; same-file overlap is assessed, never auto-serialized; teammate shape preferred when agent teams is on (SQ-973) [`c39e1f1`](https://github.com/Eigenwise/eigenwise-toolshed/commit/c39e1f1f19c464f99697a857ff7b2c72c6cef6cf)

### workbench 0.68.1 → 0.69.0

#### Features

- init-workspace enables the agent-teams flag per project; workbench-doctor flags global-env masking (SQ-972) [`c39e1f1`](https://github.com/Eigenwise/eigenwise-toolshed/commit/c39e1f1f19c464f99697a857ff7b2c72c6cef6cf)

## v3.252.0 (2026-07-28)

### sidequest 3.31.0 → 3.32.0

#### Features

- Guard refusals and guidance close the reroute: blocked steps gate dependent actions (PR/merge/ship) (SQ-968) [`34c20c7`](https://github.com/Eigenwise/eigenwise-toolshed/commit/34c20c79a5c7f89f685394fb7c1064d3a81c5666)

## v3.251.0 (2026-07-28)

### sidequest 3.30.0 → 3.31.0

#### Features

- Shared-tree artifact dispatches work again: artifact-mode briefing and executor shape reconciled with scope hardening (SQ-966) [`c5e4479`](https://github.com/Eigenwise/eigenwise-toolshed/commit/c5e4479732a4cb1456953a1c8c7acb4285d62c8c)

## v3.250.0 (2026-07-28)

### sidequest 3.29.0 → 3.30.0

#### Features

- Board-config generatedPairs: declared sources auto-pair their tracked compiled outputs across all scope gates (SQ-958) [`190684d`](https://github.com/Eigenwise/eigenwise-toolshed/commit/190684dfa9eb964d67a9dd7eef9e18c1ac926c3c)

## v3.249.0 (2026-07-28)

### sidequest 3.28.0 → 3.29.0

#### Features

- Done closures inspect the full dispatch-base delta; PreToolUse guard blocks raw git commit in shared-tree dispatches (US-28 part C) (SQ-956) [`5826e26`](https://github.com/Eigenwise/eigenwise-toolshed/commit/5826e26456d5af444dbcb671b3ef209fa94fb508)
- Helper subagent writes bound to the parent ticket's scope (US-28 part D) (SQ-957) [`7742fb5`](https://github.com/Eigenwise/eigenwise-toolshed/commit/7742fb54b0ab1bcb3a29f254bedcaf967c22aee0)

#### Fixes

- Story log: orchestrator no-ref append works; refusal messages carry real refs (SQ-964) [`7742fb5`](https://github.com/Eigenwise/eigenwise-toolshed/commit/7742fb54b0ab1bcb3a29f254bedcaf967c22aee0)

## v3.248.0 (2026-07-28)

### sidequest 3.27.0 → 3.28.0

#### Features

- Fail-closed scope validation at queue admission and integration closure (US-28 scope hardening, part B) (SQ-955) [`915c7e1`](https://github.com/Eigenwise/eigenwise-toolshed/commit/915c7e10e9c2d9d6136ce48fd6d8db0e654dd3fa)
- End-of-turn board reconciliation reminder hook, silent on quiet boards (SQ-963) [`915c7e1`](https://github.com/Eigenwise/eigenwise-toolshed/commit/915c7e10e9c2d9d6136ce48fd6d8db0e654dd3fa)

## v3.247.0 (2026-07-28)

### sidequest 3.26.5 → 3.27.0

#### Features

- Story decision log: executor-appendable shared memory per story, story-first wave orchestration, scope-expansion control-plane gate (US-27) [`619e96b`](https://github.com/Eigenwise/eigenwise-toolshed/commit/619e96bd149c8f1ce517ba5cd29aa8531cee7f91)

### workbench 0.68.0 → 0.68.1

#### Fixes

- retro files an improvement story instead of applying fix lists inline when a board is active (SQ-951) [`619e96b`](https://github.com/Eigenwise/eigenwise-toolshed/commit/619e96bd149c8f1ce517ba5cd29aa8531cee7f91)

## v3.246.0 (2026-07-27)

### sidequest 3.26.4 → 3.26.5

#### Fixes

- Executor briefings: mid-task cheap sub-work goes to explicitly cheap subagents, never gateway web research (SQ-945) [`678da44`](https://github.com/Eigenwise/eigenwise-toolshed/commit/678da440f729c2dd3906a00e75f910da4ef90347)

## v3.245.0 (2026-07-27)

### workbench 0.67.0 → 0.68.0

#### Features

- Managed LGTM container supports telemetry deletes: Prometheus admin API and Loki delete endpoint enabled (SQ-942) [`b24b5a7`](https://github.com/Eigenwise/eigenwise-toolshed/commit/b24b5a75108293aa2b9c3ffc0a778d9346bf40a5)

## v3.244.0 (2026-07-27)

### sidequest 3.26.3 → 3.26.4

#### Fixes

- Bookend supervision: two touches per ticket, integrate by oracle, never by reading the diff (SQ-944) [`9992e18`](https://github.com/Eigenwise/eigenwise-toolshed/commit/9992e18c9a48d6b9fad9a2272bc76c003433a1df)

## v3.243.0 (2026-07-27)

### sidequest 3.26.2 → 3.26.3

#### Fixes

- Upfront backlog before first dispatch; evidence-gated unpinnable-contract branch (SQ-943) [`0b598be`](https://github.com/Eigenwise/eigenwise-toolshed/commit/0b598be477a6619a87cbb539ed90f384c2a02064)

## v3.242.0 (2026-07-27)

### sidequest 3.26.1 → 3.26.2

#### Fixes

- Solo-fit gate v2: never-inline invariant, contract-first parallel waves, restored economy guards (SQ-941) [`1849c79`](https://github.com/Eigenwise/eigenwise-toolshed/commit/1849c7952febb11daf75bbe78b236c5c36c9e9ef)

## v3.241.0 (2026-07-27)

### sidequest 3.26.0 → 3.26.1

#### Fixes

- Right-size ticket decomposition: solo-fit gate, deterministic-verify audit skip, wave-batched integration (SQ-938) [`d0ca9d9`](https://github.com/Eigenwise/eigenwise-toolshed/commit/d0ca9d958c556debc49eff898a95a3947e615908)
