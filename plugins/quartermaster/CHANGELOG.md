# Changelog

## 0.11.9 (2026-09-30)

Released in v3.585.0, up from 0.11.8.

### Fixes

- The gateway launcher, doctor's install scope and Quartermaster's gateway check find a model-gateway installed from any marketplace (#380) (SQ-3174)
  Three readers of `installed_plugins.json` only looked at `model-gateway@eigenwise-toolshed`, so a model-gateway installed from a fork's marketplace was invisible to them. The stable launcher at `~/.claude/model-gateway/model-gateway.js` exited with "no installed Model Gateway CLI was found", `doctor` couldn't report the install scope, and Quartermaster's SessionStart check skipped the gateway health check entirely.

  All three now read every `model-gateway@<marketplace>` entry. The launcher still runs the newest version (then the most recently updated), and Quartermaster checks the newest install when there is more than one.

## 0.11.8 (2026-09-30)

Released in v3.584.0, up from 0.11.7.

### Fixes

- CRAP gate measures a function lizard cuts off at its parameter list over its real body and complexity (GH-315)
  The CRAP gate no longer exits 2 "coverage unverified" for a function whose parameter list holds
  parentheses of its own, such as a React component with a function-typed prop
  (`onSelect: (card: Card) => void`) or a function with a default arrow parameter. lizard's JavaScript,
  TypeScript and TSX readers end such a function inside its own signature, where coverage has no line
  data, and leave every branch in its body out of its complexity. The gate now reads the source, measures
  coverage over the function's real body, and scores the larger of lizard's complexity and the body's own
  branch count, so an uncovered branchy function fails instead of passing at complexity 1. An edit to
  that body counts as a change against the base revision. When the gate cannot find where the body ends,
  the function is still reported as unverified.

## 0.11.7 (2026-09-29)

Released in v3.582.0, up from 0.11.6.

### Fixes

- Quartermaster CRAP gate reports phantom complexity in .tsx: lizard loses a self-closing JSX tag after brace attributes plus a hyphenated attribute and attributes later functions to that component (GH-239)
  lizard 1.24.0's TSX reader abandons an opening tag as soon as an attribute is not `name="text"` or `name={expr}` — a hyphenated attribute like `data-testid`, a valueless one like `required`, a spread, even tag text holding `(`, `)`, `;` or `=` — and re-emits the `{` of every brace attribute it had already matched. Those unbalanced braces kept the enclosing component open to the end of the file, so a React component was charged with a complexity nothing in it branches on and the functions it swallowed were never gated at all. The gate now measures `.tsx` and `.jsx` through lizard's TypeScript reader, from a byte-for-byte copy of the file under a `.ts` or `.js` name, on both sides of the ratchet. Nothing in the source is rewritten, so line numbers, coverage ranges and baseline identity still come from the real file, and every offender line for those files names the measurement behind it.

## 0.11.6 (2026-09-28)

Released in v3.581.0, up from 0.11.5.

### Fixes

- Auto-allowlist vetoes loop keywords, shell fragments, variable-only cd, and version-pinned paths (GH-165) [`e222dd0`](https://github.com/Eigenwise/eigenwise-toolshed/commit/e222dd0e6676e9cbf9ca5e1f7fffffdc8b7a3e08)
- CRAP ratchet pairs each function one-to-one with its baseline copy by source text, so an inserted anonymous function no longer shifts its neighbours onto the wrong row (GH-167)
- CRAP gate measures the worktree it runs in and isolates coverage output per run (GH-169)
- CRAP ratchet pairs a function to its baseline by source text, so an insertion cannot flag its untouched neighbours (GH-182)
  Inserting one function shifted the position of every later function sharing its name, so the ratchet compared untouched namesakes against the wrong baseline row: one came back as a regression and the one pushed past the baseline's ordinals came back as a new function over the ceiling. Every function now pairs with its baseline copy by exact source text first, then by name and position among its namesakes, and pairing is one-to-one: a baseline function is claimed by at most one of today's functions, and a function that claims nothing answers to the ceiling on its own. A byte-identical copy of an over-ceiling function is therefore new code over the ceiling, and so is a third `run` in a file that already had two.
- CRAP gate's unmeasured-files check now honours the config's exclude patterns (GH-270)
  The CRAP gate's unmeasured-files check now skips files covered by the configured `exclude`
  patterns instead of treating every excluded, function-bearing file as an unverified measurement.
  A changed file that matches an exclude pattern no longer forces the gate to exit with a spurious
  "lizard reported zero functions" error.
- status, doctor and ensure agree on the shim's state, and ensure stops fighting its own shim (SQ-3124)
  `status`, `doctor` and `ensure` now read the shim through one shared probe and print the same state:
  `running-ours`, `running-foreign`, `starting` or `stopped` (#275). `ensure` against a shim that is ours
  and already at the installed version is a no-op success instead of a second supervisor failing on
  `EADDRINUSE` (#230), and a supervisor that is still starting gets the startup window to answer before
  anything replaces it.

  The supervisor no longer starts a second proxy while the first is still warming up: a proxy it started
  gets 30 seconds to answer `/v1/models` before recovery replaces it, and a replacement stops the old
  child first (#251).

  On Windows, port-owner detection reads `netstat`'s foreign-address and PID columns instead of the
  localized `LISTENING` text, so a German or French UI no longer hides the owner and upgrades replace the
  running shim (#296). The advised command path already falls back to the CLI until SessionStart writes
  the stable launcher (#77).

  Quartermaster's session-start gateway audit reads the new shim line: `running-ours` counts as a running
  shim, and a `running-foreign` listener no longer passes for one.
- Model Gateway keeps its built-in fallback model list out of Claude Code's discovery cache, and updating Toolshed no longer wires the directory the updater runs from (SQ-3126)
  GH-297: the discovery cache is written only from a list the proxy answered. While the proxy is
  unreachable the shim serves `models.json` or its built-in list from memory, keeps the previous cache,
  retries the proxy on its next refresh tick, and `status` reports `fallback catalog (proxy unreachable)`.

  GH-292: the stable updater runs `setup --preserve-wiring`. It refreshes Claude alias pins only in
  projects already recorded as wired, and only when a pin changed, so an update that changes no version
  touches no settings file. Wiring a project stays a deliberate `setup` or `env --write-project` inside it.
- Quartermaster: fix crap base/ratchet docs, add decisions update/remove, name real doctor failures, and stop counting hook blocks as denials (SQ-3128)
  Four small fixes: the crap gate's config key is documented and read as base, with ratchet kept as a deprecated alias (GH-267). decisions gained update and remove verbs so a status change no longer needs a stale duplicate row (GH-265). The model-gateway health notice now names doctor's own first failing check instead of always blaming Grok auth (GH-141). mine/verify now detect a PreToolUse hook's own stderr wrapper, classify it as hook_block, and exclude it from denial friction and allowlist candidates while still showing its count separately (GH-302 item 2).

## 0.11.5 (2026-09-28)

Released in v3.580.0, up from 0.11.4.

### Fixes

- Quartermaster CLI loads again from the plugin cache: the CRAP module now ships inside the plugin (GH-261, GH-262, GH-301, GH-302, GH-309) (SQ-3095)

## 0.11.4 (2026-09-22)

Released in v3.575.0, up from 0.11.3.

### Fixes

- Align CRAP gates with the strict six-point standard (SQ-3047)
  Makes CRAP measurement fail closed, checks only functions a change writes, and uses the shared quality parser for Quartermaster and plugin sources.

## 0.11.3 (2026-09-22)

Released in v3.574.0, up from 0.11.2.

### Fixes

- Repair complete inventoried privacy and signal routing documentation (SQ-3019)
  Correct privacy storage wording and document the consent-filtered log outbox with separate trace and metric Collector sink pipelines.
- Restore lost privacy matrix assertions (SQ-3024)
  Restore two SQ-3013 privacy-matrix test protections dropped in SQ-3019: exact
  Windows/fallback `observability.json` path checks and the setup-reference
  "private config" / "current-user-only permissions" prohibitions. Test-only
  fix, no runtime or documentation prose changes.
- Clarify Gateway recovery and RC hosts handling (SQ-3026)
  Clarifies Gateway recovery after attributed OpenAI rejections and the confirmation-gated RC hosts update. The `env` RC-compatibility line now points users at `remote-control enable --confirm`, the command that actually backs up and writes the hosts entry, instead of telling them to add it themselves.

## 0.11.2 (2026-09-19)

Released in v3.572.0, up from 0.11.1.

### Fixes

- Fix resupply eval schema (SQ-2995)
  Make Quartermaster's resupply host-capability evals compatible with skill-creator.

## 0.11.1 (2026-09-15)

Released in v3.570.0, up from 0.11.0.

### Fixes

- quartermaster: decisions list now respects --project (SQ-2920) [`e91abdf`](https://github.com/Eigenwise/eigenwise-toolshed/commit/e91abdf037f2f51105a315212dce314dce3d438a)

## 0.11.0 (2026-09-15)

Released in v3.568.0, up from 0.10.2.

### Features

- quartermaster crap gate measures per-function CRAP from lcov and lizard (SQ-2904)
  `node bin/quartermaster.js crap` scores every function with `cc^2 * (1 - coverage)^3 + cc`, taking coverage from an lcov file and complexity from lizard, so it works in any language lizard reads. A new project gets a ceiling on every function; an existing one can set `ratchet` to a git ref, which fails any function in a changed file that got worse, holds new functions to the ceiling, and reports how many pre-existing functions already sit above it. Settings live in `.claude/quartermaster/crap.json`. It exits 2 when it cannot measure, with the install hint for lizard, rather than reporting a pass it did not earn.

### Fixes

- Explain and install the CRAP gate (SQ-2905)
  Explain the CRAP gate in setup, resupply, and the Quartermaster guide.
- Fix quartermaster README CLI drift (SQ-2913)
  The README's `mine` line was missing `--no-subagents`, `decisions add --status` was missing the `deferred` status, and `enable-auto-allowlist` showed `--project` as required when it is optional. All three now match `quartermaster --help`.

## 0.10.2 (2026-09-12)

Released in v3.562.0, up from 0.10.1.

### Fixes

- Check plugin recommendations against current reality (SQ-2803)
  Quartermaster checks current plugin status and reported experience before it proposes an install.
- Stop retiring proposals the user never rejected (SQ-2812)
  A recorded rejection now only silences the project it was recorded in, instead of every project on the machine, and the skills say plainly that `rejected` records the user saying no to something they were actually shown, never Quartermaster's own decision not to raise it. A plugin from a marketplace you have not added yet is proposed with its `marketplace add` command rather than dropped as uninspectable.

## 0.10.1 (2026-09-12)

Released in v3.560.0, up from 0.10.0.

### Fixes

- Find desktop-installed Claude Code (SQ-2791)
  Toolshed updates now find Claude Code installed by the Windows desktop app when it is not on PATH, and report failed updates without false reload advice.

## 0.10.0 (2026-09-11)

Released in v3.558.0, up from 0.9.4.

### Features

- Reopen resupply offers on strong new evidence (SQ-2762)
  Preserve evidence after declined rounds and back off consecutive declines.

## 0.9.4 (2026-09-11)

Released in v3.557.0, up from 0.9.3.

### Fixes

- Ignore harness messages in correction signals (SQ-2494)
  Quartermaster no longer treats leading harness task notifications or system reminders as user corrections.
- Refresh plugin versions after reload (SQ-2536)
  Reloading plugins now refreshes their loaded-version records, so stale reload warnings stop after a successful reload.

## 0.9.3 (2026-09-11)

Released in v3.556.0, up from 0.9.2.

### Fixes

- Keep resupply offers current for active sessions (SQ-2740)
  Count current-project transcript metadata so resupply can become due after sessions that do not end cleanly.

## 0.9.2 (2026-09-11)

Released in v3.555.0, up from 0.9.1.

### Fixes

- Preflight Claude Code before Toolshed updates (SQ-2732)

## 0.9.1 (2026-09-11)

Released in v3.554.0, up from 0.9.0.

### Fixes

- Block bare PowerShell suggestions (SQ-2727)
  Quartermaster no longer automatically suggests or writes bare PowerShell permissions.

## 0.9.0 (2026-09-10)

Released in v3.552.0, up from 0.8.1.

### Features

- Retire Whittle into Quartermaster's clean-code baseline (SQ-2710)
  Quartermaster setup now seeds the clean-code baseline as its single policy home, and the Whittle plugin is retired.

### Fixes

- Strip Whittle to its Claude Code integration (SQ-2708)
  Stale third-party notices are dropped from Sidequest and Quartermaster, and Quartermaster setup no longer offers a separate clean-code plugin.

## 0.8.1 (2026-09-10)

Released in v3.546.0, up from 0.8.0.

### Fixes

- Report host policy blocks without inventing permission provenance (SQ-2682)
  Clarify that permission-rule is a host policy label, not permission-rule provenance.

## 0.8.0 (2026-09-09)

Released in v3.537.0, up from 0.7.7.

### Features

- Add Whittle clean-code policy (SQ-2600)
  Whittle applies one clean-code policy through Claude Code lifecycle hooks, native host adapters, static instruction exports, and a read-only MCP prompt/tool. It has no modes, saved preferences, or switching commands. Quartermaster offers it without changing consumer configuration. Native adapter checks cover callback contracts; live OpenCode, Pi, and Hermes hosts were not run.

### Fixes

- Seed reuse-first Quartermaster project rules (SQ-2590)
  Seed generated Quartermaster project rules with reuse-first implementation guidance and approval-gated resupply.
- Keep improvement decisions with orchestrator (SQ-2601)
  Keep improvement selection and boundaries with the orchestrator while executors implement the pinned plan.

## 0.7.7 (2026-09-09)

Released in v3.534.0, up from 0.7.6.

### Fixes

- Correct Quartermaster maintenance guidance (SQ-2534)
  Use the namespaced Quartermaster commands and document Live Rules reinjection cadence accurately.

## 0.7.6 (2026-09-08)

Released in v3.533.0, up from 0.7.5.

### Fixes

- Clarify Quartermaster setup and privacy guidance (SQ-2512)
  Clarifies the guided setup handoff, registry-wide update scope, bounded session-summary privacy boundary, and maintenance reload rules.
- Sync skill-text assertions after the documentation reword (SQ-2522)
  Test-only: the handoff and updater skill assertions now match the reworded prose without weakening the contract they check.

## 0.7.5 (2026-09-07)

Released in v3.525.0, up from 0.7.4.

### Fixes

- Recommend a consistent Codex compaction window (SQ-2493) [`2994017`](https://github.com/Eigenwise/eigenwise-toolshed/commit/2994017d5dc91ffc86c309589dbfbc8b7cf0cacb)

## 0.7.4 (2026-09-07)

Released in v3.523.0, up from 0.7.3.

### Fixes

- Refresh marketplace freshness at Stop time (SQ-2489)

## 0.7.3 (2026-09-06)

Released in v3.520.0, up from 0.7.2.

### Fixes

- Give local prompt hooks room under load (SQ-2466)
  Raise the local observability lifecycle hooks, request-body preflight, and Quartermaster prompt freshness hook from 2-3 seconds to 10 seconds. Session-start hooks that spawn processes or make network calls keep their existing budgets.

## 0.7.2 (2026-09-05)

Released in v3.519.0, up from 0.7.1.

### Fixes

- Preserve gateway startup health-check failures (SQ-2445)
- Ignore archived Sidequest boards in health audit (SQ-2449)
  Quartermaster now ignores archived Sidequest boards when reporting project and local install health.

## 0.7.1 (2026-08-27)

Released in v3.506.0, up from 0.7.0.

### Fixes

- Summarize blocked permission allowlist reports (SQ-2361)
- Keep successful hook attachments out of Quartermaster errors (SQ-2364)
  Quartermaster now separates hook timeouts from failed hooks and ignores successful context attachments.
- Improve existing Quartermaster capabilities during resupply (SQ-2366)

## 0.7.0 (2026-08-25)

Released in v3.505.0, up from 0.6.1.

### Features

- Force the Quartermaster resupply offer at a real pause (SQ-2360)

## 0.6.1 (2026-08-23)

Released in v3.503.0, up from 0.6.0.

### Fixes

- Quartermaster scope guidance defaults to project installs (SQ-2347)
  Quartermaster guidance now covers every supported scope and defaults examples to project installs.
- Describe scoped gateway wiring (SQ-2350)
  Describe Model Gateway project and machine-wide wiring scopes in updater and telemetry guidance.
- Refresh renamed plugin prose (SQ-2352)
  Refresh stale Workbench and codex-gateway prose to the current Observability and model-gateway names, and clarify Quartermaster's managed status-line healing output.

## 0.6.0 (2026-08-20)

Released in v3.494.0, up from 0.5.5.

### Features

- Move Workbench into Quartermaster (SQ-2307)
  Quartermaster now includes Toolshed updates, health checks, workspace settings support, and freshness hooks. The separate Workbench plugin is gone.
- Use project scope for new Toolshed installs (SQ-2308)

## 0.5.5 (2026-08-20)

Released in v3.491.0, up from 0.5.4.

### Fixes

- Align the Workbench and Quartermaster READMEs with what code-intel and live rules actually do (SQ-2291)
  Name Python and the upward language-server search in the code-intel section, and stop describing the setup-seeded live rule as per-prompt.

## 0.5.4 (2026-08-17)

Released in v3.481.0, up from 0.5.3.

### Fixes

- Canonicalize Quartermaster project state paths (SQ-2216)
  Quartermaster now shares state and decision verification across equivalent project path spellings, and migrates existing raw-keyed state files on first read.

## 0.5.3 (2026-08-15)

Released in v3.463.0, up from 0.5.2.

### Fixes

- Remove the retired retro runtime alias (SQ-1966)
  Quartermaster no longer accepts the retired `mark-retro` command. Use `mark-resupply`.

## 0.5.2 (2026-08-13)

Released in v3.462.0, up from 0.5.1.

### Fixes

- Add approved optimization rounds (SQ-1908)
  Quartermaster now proactively offers a focused development-setup optimization round and waits for current approval unless the user has explicitly granted standing permission. Sidequest now keeps specific one-file and one-prompt requests inline by default, while requiring approval before proactive or expanded work unless standing permission covers it.

## 0.5.1 (2026-08-13)

Released in v3.460.0, up from 0.5.0.

### Fixes

- Learn repeated permission approvals (SQ-1859)
  Quartermaster can now opt into learning repeatedly approved safe permission rules for each project.

## 0.5.0 (2026-08-12)

Released in v3.456.0, up from 0.4.1.

### Features

- Add C++ code intelligence (SQ-1840)
  Workbench can use clangd for C and C++ when the project supplies a current compile database.

## 0.4.1 (2026-08-12)

Released in v3.455.0, up from 0.4.0.

### Fixes

- Generalize code-intel tools across languages (SQ-1836) [`94e32b0`](https://github.com/Eigenwise/eigenwise-toolshed/commit/94e32b07)
  Generalized the code-intel MCP tools from typescript_definition, typescript_references, and typescript_diagnostics to definition, references, and diagnostics; each call now selects its language server from the requested file extension. Client registry keys by (root, language) so one root can host several servers. Quartermaster setup reference updated to the new tool names.

## 0.4.0 (2026-08-11)

Released in v3.448.0, up from 0.3.0.

### Features

- Carry the capability-capture charter into every session and run resupply proactively (SQ-1822)
  The SessionStart hook now keeps the capability-capture charter in front of Claude (turn the task done three times into a skill, map entry, rule, or measurement, offered in the moment), stepping aside where setup seeded the per-prompt live rule. The resupply nudge has Claude run the pass at the next natural pause instead of merely suggesting it, and fires sooner: 4 sessions / 6 friction events / 24h cooldown.

## 0.3.0 (2026-08-11)

Released in v3.444.0, up from 0.2.2.

### Features

- /quartermaster:retro becomes /quartermaster:resupply, and asks what would make the work easier (SQ-1815)
  **The command changed: `/quartermaster:retro` is now `/quartermaster:resupply`.** Your session tallies and decision ledger carry over untouched, including the timestamp of your last pass.

  The old skill was a friction hunt: count the denials, the corrections, the interrupts, the commands you kept retyping, then fix those. That misses the improvements that matter most, because the best ones leave no trace. When you need a measurement that doesn't exist yet, nothing errors, nothing gets denied, nobody corrects you, and you only do it once, so every "did this happen repeatedly" threshold skips right past it. Removing friction gets you back to the speed you already expected. Adding a capability moves that baseline.

  So the pass now starts from what you're actually trying to get done, then looks for what's missing against it, in value order: something you have no way to measure, work you keep doing by hand, knowledge you keep re-deriving, and only then the setup pushing back at you. Findings route to a new destination list that puts a measurement built as a committed skill at the top and permissions near the bottom, with a project-knowledge destination that didn't exist before.

  A goal phrased as a standard ("make it reliable", "make sure the output is correct") is the case this is really aimed at. You can't close one of those without a way to check it, so every fix underneath stays a guess and the same argument reopens a week later. That missing ruler is now the highest-value thing the skill can propose.

  Hence the name. A quartermaster keeps a unit supplied: `setup` outfits a new workspace, and `resupply` works out what an existing one is short of and gets it. "Retro" pointed backwards at what went wrong, which is exactly the frame this drops.

  The self-improvement live rule that quartermaster installs on every workspace got the same treatment, and both it and the skill now send new skills through skill-creator instead of suggesting it in passing. Hand-rolled skill files tend to encode the one example in front of you and end up too vague to trigger when you need them.

  Value order is where the pass *looks*, not the order it *proposes* in. A missing measurement leads only when the history actually attests it: a goal restated and never met, a check improvised dozens of times, one question answered two different ways. Read off a single session title plus a habit, it gets labelled as inference and ranks below the cheap fixes you can be sure about, and on a project holding no standard at all the honest answer is that there's nothing to build. That distinction came out of running the skill against three sandboxed histories: without it, a project shipping steadily against a working test suite got an invented measurement gap ranked first, above two well-evidenced fixes.

  Numbers quoted back at you are now the aggregate's numbers as it reports them, and nothing gets shown as a command that was run unless it was. The whole point of mining is that you don't have to take the pass on trust.

## 0.2.2 (2026-08-10)

Released in v3.441.0, up from 0.2.1.

### Fixes

- Retire Codegraph (SQ-1812)
  Codegraph is gone: the plugin, its marketplace entry, its docs page, and its MCP server. It never earned its keep next to the tools already in the shed. Grep, LSP, and Codebase Mapper cover the same ground without a pinned Pyright, a pinned TypeScript, a SQLite graph, and a 16-second query.

  Nothing else depended on it. Quartermaster's setup skill no longer has to explain why not to recommend it.

  If you have it installed, remove it in `/plugin` and delete `~/.claude/codegraph` (the graph snapshots and the pinned runtimes, which run to a gigabyte or so). Nothing else on disk is left behind.

## 0.2.1 (2026-08-10)

Released in v3.438.0, up from 0.2.0.

### Fixes

- Quartermaster setup explains what each Toolshed plugin is (SQ-1798)
  The setup skill now describes what each Toolshed plugin does before the reason to install it, so Claude can explain a proposal instead of only naming it. It also says plainly that every piece is independent and opt-in, and that Sidequest is the routing and executor system rather than a ticket tracker.

## 0.2.0 (2026-08-10)

Released in v3.437.0, up from 0.1.0.

### Features

- Add quartermaster; retire playbook and init-workspace (QM-1)
  quartermaster joins the shed: transcript-mining retros with a decision ledger and outcome verification, plus a history-grounded workspace setup skill that replaces workbench's init-workspace. playbook is retired; its verify-discipline skill moves into sidequest (executor skill pin updated to sidequest:verify-discipline).

## 0.1.0

Initial release.

- `mine`: streamed signal extraction from recent transcripts (friction, attribution, habits),
  bounded output, subagent transcripts included.
- `retro` skill: findings routed to plugin installs, rules, permission allowlist entries,
  disables, or new skills; per-item approval; decision ledger with rejection memory.
- `setup` skill: workspace setup for new or existing projects, grounded in cross-project
  history; installs and verifies the Toolshed core and stack plugins around the reload boundary.
  Replaces workbench's `init-workspace` and inherits its reference catalog.
- `verify`: before/after per-session comparison of the signal each applied decision targeted.
- SessionEnd tally hook and threshold-gated SessionStart nudge (72h cooldown, no analysis).
