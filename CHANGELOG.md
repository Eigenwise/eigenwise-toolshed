# Changelog

One section per release window. Each window is a single commit on `main` that moves every
changed plugin at once, tagged `v<marketplace version>`, with matching per-plugin changelogs
under `plugins/<name>/CHANGELOG.md`.

Releases before v3.208.0 predate this file and are not backfilled; `git log` is the record for
those. Entries are generated from `.release/unreleased/*.md` by `scripts/release/cut.mjs`, so
nothing here is hand-written.

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
