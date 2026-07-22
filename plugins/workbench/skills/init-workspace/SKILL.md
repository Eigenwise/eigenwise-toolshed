---
name: init-workspace
description: >-
  Set up a complete Claude Code workspace for a project, new or existing. Runs a short interview, installs
  the selected project plugins, then writes .claude/ end to end: live rules, a codebase map, and structure
  notes, wired around the plugin-reload boundary and verified firing. Use for WHOLE-workspace setup: "set up
  a Claude workspace", "init/bootstrap this project for Claude", "configure Claude Code for this repo",
  "set up .claude / the toolshed here", "get this project ready for Claude Code". Holistic orchestrator:
  it sequences codebase-mapper, live-rules, sidequest, skill-creator, and the built-in /init. Prefer it
  whenever the user wants the whole setup (for only a map use map-codebase; for only one rule use add-rule).
---

# Init Workspace

Set up a project's `.claude/` workspace end to end. You are an **orchestrator**: the pieces already
exist (codebase-mapper's `map-codebase`, live-rules, sidequest, `skill-creator`, the built-in
`/init`, and Workbench's bootstrap installer). Your job is to interview the user, make the installer
plan, sequence workspace artifacts around the plugin-reload boundary, and verify the result actually
works before you call it done.

The only prerequisite is **Workbench installed at user scope**. If it is not installed, stop and give
the user the Install commands from the Workbench README. Do not install Workbench as part of generated
project settings.

Keep the whole thing **tech- and purpose-agnostic**: the logic below is generic. The stack-specific
choices come from `references/stack-plugins.md` (which plugins) and `references/rule-templates.md`
(which starter rules), plus what you detect in the repo. Never hard-code a stack into the flow.

## The shape of the job

There is one hard constraint that dictates everything: plugins must be installed before any workspace
artifact relies on them, and installed plugins take effect only after Claude reloads them. Ask for
telemetry consent before inspecting the project, then learn the project's intent before recommending
any Toolshed plugins. Split the project setup at its reload boundary:

1. **Telemetry consent** — ask first, then stop for a restart only when the user opts in.
2. **Project intent** — ask what the project is for, with any useful clues from a non-empty repo.
3. **Plugin picker** — offer the current marketplace catalog with recommendations based on that intent.
4. **Assess** the project (Phase 0).
5. **Interview and select project details** (Phase 1).
6. **Install selected plugins, then write pre-reload artifacts** (Phase 2).
7. **Reload boundary** — stop, ask the user for one reload, and wait (Phase 3).
8. **Post-reload** — build the map, bring up the board, and verify every selected plugin is loaded and
   usable (Phase 4).
9. **Wrap up** — commit reminder and what they got (Phase 5).

Read `references/stack-plugins.md` before the plugin picker and `references/rule-templates.md` before
Phase 1; read `references/self-improvement.md` and `references/structure-notes.md` when you reach those
steps. The `enable-project-telemetry` skill owns telemetry mechanics and verification.

## Before Phase 0 — Toolshed setup

### Telemetry consent

This is the first question in the whole flow. Before inspecting the directory, asking about the stack, or
asking any project question, check the project-local telemetry settings and the result of the telemetry skill's
verification command. `found` means telemetry is verified. A healthy-observer `not-found` means telemetry is
**configured, pending first export**, never verified. In either enabled state, say so briefly and skip this
question on re-entry. A pending result schedules exactly one re-check in Phase 4 after real session usage exists.

When telemetry is not enabled, use one `AskUserQuestion` with this plain explanation: **"Enable local
project telemetry? Each project must opt in: this writes only its `.claude/settings.local.json` and sends usage
metadata through the local Collector to local Grafana. You can see API-equivalent cost; input, output, and cache
token totals; tool-call names and counts; plus model, session, agent, and activity information. It never records
prompt or response text, code or file contents, tool inputs or results, credentials, or environment values."**

- **Yes:** hand off to `/workbench:enable-project-telemetry`; it owns consent confirmation, setup, and
  verification. After it finishes, stop. Tell the user to restart Claude Code because its OTEL settings only
  apply to a new session, then re-run `/workbench:init-workspace`. Do not assess the project or ask the
  plugin question first.
- **No:** continue immediately to the project-intent question. Do not ask again during this run.

A telemetry restart also satisfies a pending plugin reload boundary. On re-entry, detect the completed
telemetry setup and continue with the project-intent question, picker, or later phase without repeating
answered setup questions.

### Project intent

Ask this plain-text question before listing any plugin options: **"What is this project for, and who is
it for? One or two lines is plenty."** For a non-empty repo, first inspect only enough of the visible
project signals to pair the question with a useful inference, such as "I see a Rust audio-plugin project;
what does it make and who uses it?" Keep that inference tentative and let the user correct it.

Keep the answer in the session/bootstrap plan. On re-entry, use a previously captured answer rather than
asking again. A telemetry restart does not create an answer because this question happens after the restart.

### Plugin picker

Ask this third, before Phase 0. Read the current Toolshed marketplace manifest and
`references/stack-plugins.md`, then offer the available plugins with a one-line plain-language description
and a recommendation grounded in the stated project purpose and any visible stack signals. Say why when
a plugin fits (for example, "recommended for this project because ...") and say "probably not needed
here" when it does not. Do not fall back to generic core/extra tiers. Do not maintain a hard-coded plugin
list in this skill: the current marketplace/catalog is the source of truth. Include the already-installed
state in the options, so a re-entry does not ask the user to install a plugin that is already present. Use
`AskUserQuestion` with multi-select when the current catalog fits its option limit; otherwise present
grouped choices and collect the selection before moving on.

The picker is a broad Toolshed choice informed by the project purpose, not a substitute for the later
assessment. Keep the selected set for the installer plan; Phase 1 may recommend only missing, relevant
stack extras rather than re-asking for the whole set.

## Phase 0 — Assess

Get the lay of the land before asking anything. Two axes matter:

- **New vs existing.** Count real source files (ignore `.git/`, `node_modules/`, `vendor/`, `dist/`,
  `build/`, `.venv/`, lockfiles, generated code). A repo with real code is *existing*; an empty repo,
  bare scaffold, or just a README/spec is *greenfield*.
- **Codebase vs not-a-codebase.** Is this actually code, or is it a wiki / notes vault / docs site /
  content repo / design folder? This decides whether you generate a codebase map at all (a wiki
doesn't need `map-codebase`; it may still want live-rules and sidequest).

Also check what's already there:

- **Existing `.claude/`?** If `settings.json`, `live-rules.md`, or a map already exist, you are
  **augmenting, not clobbering.** Read them first and merge; never overwrite a user's existing config
  or rules. Call out what you'll add and what you'll leave alone.
- **Detect the stack** from manifest/config files (`package.json`, `pyproject.toml`, `Cargo.toml`,
  `go.mod`, `svelte.config.js`, `*.csproj`, `Gemfile`, etc.). See codebase-mapper's
  `references/language-detection.md` if you need the signal-file map. This detection seeds the
  interview so you propose rather than interrogate.
- **Git?** Note whether it's a git repo (affects the commit reminder and the map's state file).

### Pre-enable Sidequest lookup

When this flow needs Sidequest before reload, read `~/.claude/plugins/installed_plugins.json` and select the
`sidequest@eigenwise-toolshed` entry for the current project (or its user-scope entry). Its `installPath` must
match `~/.claude/plugins/cache/eigenwise-toolshed/sidequest/<version>` and its final segment must equal the
entry's `version`; otherwise stop and ask the user to reinstall Sidequest. Invoke
`node "<installPath>/plugins/sidequest/bin/sidequest.js" profile list`. Never PATH-probe or search the cache.

### Routing profile

When Sidequest is selected, make one routing choice immediately after this scan and before the Phase 1
interview. Infer a starter from plain repo signals: code and build files → `coding`; docs, posts, or
content → `writing`; source corpora, datasets, or citation-heavy material → `research`; audio, scores,
or music-production files → `creative-music`. If signals conflict, choose the closest fit and say why.

Use one `AskUserQuestion` that proposes the inferred starter and offers: **Use this profile**, **Choose
another starter**, or **Make a project profile**. Keep it conversational: do not turn category routing into
a form or walk through every category. If the user chooses another starter, show the available profiles from
`sidequest profile list` and let them name one in plain text. Record the accepted profile choice in the
session/bootstrap plan; if Sidequest was not selected, skip this step.

For **Make a project profile**, propose a small delta from the closest starter using the scan and the stated
project purpose. Say which categories would change and why, then let the user confirm or tweak that delta in
plain language. Create `<project>-routing` by cloning the closest starter, apply only the confirmed delta,
and select it for the board:

```sh
sidequest profile create <project>-routing --from <starter> --description "<confirmed purpose>"
sidequest profile use <project>-routing --project <board>
```

Apply profile-category changes with `--profile <project>-routing`, never `--profile <starter>`. A starter is
shared policy and setup must never mutate it. Do not create a project profile when the user accepts or picks
a starter. Keep the selected profile and any confirmed delta in the plan; Phase 4 applies the profile after
Sidequest creates or opens the board.

## Phase 1 — Interview and selection

Before the normal interview, invoke `/codex-gateway:codex-gateway` and use its `env --show-mode` command to inspect the machine-local gateway mode. Do not invoke a bare `codex-gateway` shell command, since the installed plugin command is not on PATH. When no mode is saved, ask exactly once: **"Global (all projects wired automatically via user settings) or per-project (each project opts in via its private settings.local.json — recommended)?"** Global gives zero-friction coverage everywhere. Per-project keeps personal wiring out of shared repos and makes each opt-in explicit. Persist the choice through that skill with its `env --mode global` or `env --mode local` command; do not ask again once a mode exists, and later setup flows honor it silently. Do not ask during non-interactive setup: default to local and say `wiring mode defaulted to per-project; use /codex-gateway:codex-gateway to run its env --mode global command to change`.

Keep it short and propose defaults from what you detected, so the user confirms rather than types
essays. The project-intent answer was collected before the picker; use it to seed the map and structure
notes, and do not ask it again. Ask what you genuinely can't infer. A good compact set (adapt, don't
recite):

1. **Stack** — confirm what you detected, and anything not yet visible (intended stack for
   greenfield; test framework; deploy target like Cloudflare/Vercel/AWS).
2. **Codebase or not?** Confirm your Phase 0 read ("this looks like a docs wiki, so I'll skip the
   codebase map, sound right?").
3. **Team or solo, and any existing conventions** worth encoding as rules (commit style, a
   `CONTRIBUTING` or style doc to point a rule at, house preferences).
4. **Stack extras** — recommend only missing catalog plugins that fit the confirmed project. Keep the
   picker selection unless the user changes it; do not repeat the broad Toolshed plugin question.
5. **CLAUDE.md?** Recommend a lightweight static one seeded through `/init`; they can skip it for now if they prefer. Either answer keeps the live-rules plan. CLAUDE.md holds always-loaded project context; live rules handle conditional behavioral enforcement.

Use the `AskUserQuestion` tool for the choices with clear options (stack extras, codebase-or-not,
`CLAUDE.md` yes/no); ask the open ones (what is this, conventions) in plain text. If the user said
"just set it up, use good defaults", keep their picker selection and add only obviously useful missing
stack extras.

Before creating an LSP plugin plan, run its required binary check from the catalog. Report a missing
binary and its exact install hint, but never run a package manager yourself. Let the user either install
it, continue knowing code intelligence stays unavailable until they do, or drop that plugin.

### Git setup for non-repos

If Phase 0 found that the project directory is not a git repo, ask once with `AskUserQuestion` after
the user has confirmed their intended stack and before any pre-reload artifact is written. Recommend
`git init` with this short reason: it preserves the workspace setup and lets future sessions share it.

- On yes, run `git init` in the project root, then write or merge a stack-appropriate `.gitignore`
  derived from the detected or confirmed stack. Never overwrite an existing `.gitignore`.
- On no, respect it without asking again. Record that the user declined so Phase 5 can give the one
  relevant reminder.
- Never auto-commit. Git initialization and `.gitignore` are the only changes in this step; the user
  still owns the first commit.

## Phase 2 — Install, then pre-reload writes

### 2a. Build and run the plugin plan

Build the installer plan in the **current session scratchpad** for
`install-workspace-plugins.js`. Include `version: 1`, the detected/confirmed absolute `projectDir`,
selected marketplaces, selected plugins, their scopes, `userScopeConfirmed` when needed, LSP preflight
records, and only non-plugin settings to merge.

- Select the core from the catalog: `codebase-mapper` and `live-rules`, plus `sidequest` unless the
  user opts out. Add only the confirmed extras.
- Default every selected workspace plugin to `project`. Use `local` only when the user explicitly
  calls it personal to this repo. Use `user` only when they explicitly request a cross-project install
  and record that confirmation in the plan.
- Include a portable marketplace declaration only when the catalog has a reproducible source. The
  official marketplace is already available and needs no declaration.
- Do **not** hand-write or merge `enabledPlugins`. `claude plugin install --scope project` owns those
  entries and the helper verifies the CLI inventory afterwards. After a successful install, merge only
  the plan's non-plugin settings and portable marketplace declarations that the CLI did not make
  project-visible. Preserve every existing setting and never duplicate or contradict the CLI's output.

Run the helper's read-only pass first, then show the user the install delta. The LSP checks already run
in Phase 1, so use their results to settle any missing-binary choice before the install:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/install-workspace-plugins.js" --plan "<session-scratchpad>/workspace-plugin-plan.json" --check
```

After the user settles any missing-binary choice, run the installer before writing any artifact that
depends on a selected plugin:

```sh
node "${CLAUDE_PLUGIN_ROOT}/bin/install-workspace-plugins.js" --plan "<session-scratchpad>/workspace-plugin-plan.json"
```

If either command fails, stop. Report the helper's exact failed command and error, say which steps
succeeded and which were not run, and give this recovery: fix the reported problem, then rerun the
same installer command with the same plan. It is idempotent. Do not write dependent artifacts, request
a reload, or claim the workspace setup completed after a partial install. After a successful result,
merge the plan's non-plugin settings without replacing existing values, then continue with the other
pre-reload artifacts.

### 2b. Telemetry and reload handling

Telemetry is never enabled in this phase. When the user enabled it before Phase 0, the required session
restart happens before this phase and satisfies this reload boundary too. Otherwise, request the single
plugin reload in Phase 3.

### 2c. Atomic live rules

After a successful install, create a new workspace's `.claude/live-rules/` directory directly. Write
every selected starter rule as one `.claude/live-rules/rules/<stable-name>.md` file, then atomically
write `.claude/live-rules/manifest.json`. Follow the exact individual-rule and manifest format in
`references/rule-templates.md`: every manifest entry needs its relative rule path, the SHA-256 hash of
the exact UTF-8 rule file contents, and copied applicability metadata (`description`, `globs`, `dirs`,
`prompt`, `enabled`). Generate and validate those hashes mechanically, never by hand. A fresh workspace
never creates `.claude/live-rules.md`.

- The **craft baseline** (global, `priority` 90–100): atomic commits / two hats, simple design,
  surgical/Karpathy directive, verify-before-done, no-inline-comments/naming. Ship these on every
  workspace.
- The **self-improvement rule** from `references/self-improvement.md` — the baked-in loop. Ship it on
  every workspace.
- The **stack-specific rules** for the detected stack (`priority` 50–70, scoped with `globs`/`dirs`/
  `prompt`): e.g. the Python-uv rule, the Svelte-runes rule, the RL reproducibility bundle. Only add
  rules whose scope matches files that exist or clearly will.
- Optionally the **guidelines-pointer** rule plus a copied `clean-code-principles.md` if the user
  wants the deeper digest available (copy `references/clean-code-principles.md` into `.claude/`).

Keep bodies tight. Follow the live-rules format exactly (no bare `---` inside a body, use `***`). Write
rule files plus the manifest through temporary siblings and rename them into place together. If a
project already has `.claude/live-rules.md`, migrate its rules into atomic files without deleting the
original until the manifest and matcher behavior have been checked.

### 2d. Structure notes

Write a short `.claude/.codebase-info/structure.md` (or, for a not-a-codebase project, a top-level
note) capturing **how the project is meant to be laid out** — the organizing principle, where things
go, what belongs where. See `references/structure-notes.md`. This matters most for **greenfield**:
it's where intent gets written down before there's code for `map-codebase` to read. For an existing
codebase this is light (the map will cover structure); for greenfield it's a real deliverable.

### 2e. `CLAUDE.md` (optional)

Recommend a lightweight `CLAUDE.md` alongside live rules. They have separate jobs: `CLAUDE.md` is the
always-loaded, static project context — what the project is, its stack, and its build and test commands.
Live rules are conditional, targeted behavioral enforcement that gets injected when applicable. One does
not replace the other; together they are the default setup.

If the user wants `CLAUDE.md`, **delegate to the built-in `/init`** rather than hand-rolling it. Note the
deliberate exception: every other toolshed plugin says never touch `CLAUDE.md`, because their hooks
handle injection. `init-workspace` is the one-time static setup, so seeding `CLAUDE.md` here is correct,
and the self-improvement loop is explicitly allowed to update it later. Say this out loud so it doesn't
read as breaking the house rule.

## Phase 3 — Reload boundary

All pre-reload writes and the complete installation must succeed before this boundary. A Claude Code restart
that completed the telemetry flow counts as this boundary when it happened after the selected plugins were
installed. Otherwise request one reload and wait:

> The selected plugins are installed and the workspace files are ready. Run **`/reload-plugins`**, then
tell me to continue. If Claude Code refuses because the reload changes MCP or LSP servers, run
**`/reload-plugins --force`**. Restart Claude Code only if reload still does not load them.

Do not request an earlier or second reload. Do not pretend the plugins are loaded and barrel into
Phase 4 in the same turn — the whole point is to verify against really-loaded plugins.

## Phase 4 — Post-reload: build and verify

Now the plugins are live. First run `claude plugin list --json` and confirm every selected plugin is
installed, enabled, and at its requested scope. Then do the work that needed them and verify each piece
empirically — this is the part that separates "wrote some files" from "set up a working workspace."

1. **Telemetry.** When the project opted in, run:

   ```sh
   node "${CLAUDE_PLUGIN_ROOT}/bin/verify-project-telemetry.js" --project "<absolute-current-project-dir>"
   ```

   `found` verifies telemetry. With a healthy observer, `not-found` means **configured, pending first export**.
   Report it as unverified and give the user that exact command to run later. Do not schedule another re-check.
2. **Codebase map** (skip for a not-a-codebase project). Invoke `map-codebase`. For a big repo it
   fans out; with a ready Sidequest it can hand off an existing-code map and resume on the writer's
   completion. Wait for that completion before Phase 4 continues, then confirm
   `.claude/.codebase-info/INDEX.md` exists.
3. **live-rules is injecting.** On this turn, confirm the live-rules content is actually in your
   context (the plugin injects a recognizable rules block on SessionStart and every prompt). If you
   can see your starter rules injected, it's wired. If not, the plugin isn't loaded, so send the user
   back to reload/restart.
4. **codebase-mapper is injecting.** Same check: confirm the `INDEX.md` hub is being injected on the
   prompt. Seeing it in context is the proof the hook fired.
5. **sidequest board.** If selected, bring up the board (`sidequest dashboard`, or ask the board skill), then
   apply the profile recorded after Phase 0 with `sidequest profile use <profile> --project <board>`. For a
   new project profile, create it from its recorded starter and apply only its confirmed delta before using
   it. Report the URL and selected profile, so the user sees the Kanban and its routing policy are live.
6. **Optional plugins.** Verify each selected extra is usable: an LSP responds and its binary is on
   `PATH`, a named skill resolves, or its documented integration opens. Keep it quick, but verify every
   selected plugin rather than assuming a loaded entry works.

If any check fails, fix it (usually a settings merge mistake, an unavailable prerequisite, or a rule
scope that matches nothing) and re-verify. Report what you confirmed, concretely, not "should work."

## Phase 5 — Wrap up

- Tell the user **exactly what they got**: which plugins are enabled, which rules are live (and that
  editing them takes effect next prompt), whether a map was built, and where the board is.
- **Commit reminder.** If the project is a git repo, tell them to commit `.claude/` so the team and
  every future session share the setup. Offer to do it (ship-by-default if that's their preference). If
  they declined Git setup, say once that the workspace is uncommitted and that they can run `git init`,
  add a stack-appropriate `.gitignore`, then commit `.claude/` when they want to back it up.
- **Point at the self-improvement loop.** Remind them the workspace now nudges itself to improve after
  work, and that `retro` runs a deeper reflection pass on demand.

## Guidelines

- **Orchestrate, don't reinvent.** Use the bootstrap helper for plugin installation, `map-codebase` for
  the map, `/init` for `CLAUDE.md`, `add-rule` / `skill-creator` where they fit. You write the glue and
  the sequencing.
- **Generic by construction.** No stack is baked into the flow. Everything stack-specific comes from
  the reference catalog, which you extend when you meet a stack it doesn't cover yet (that extension is
  itself a self-improvement move).
- **Never clobber.** Merge into existing `.claude/` files; a user's rules and config survive.
- **Verify against reality.** The success test is selected plugins loaded and usable in a really-loaded
  session, plus the relevant hooks firing, not files on disk. Watch them fire.
- **Respect the reload boundary.** Don't collapse Phases 2 and 4 into one turn.
- **Don't leak secrets.** Rules and notes say where config lives, never actual credential values.

## Success criteria

- [ ] Workbench is installed at user scope
- [ ] Telemetry consent was the first question; a yes completed the telemetry flow and restarted Claude Code
      before resuming
- [ ] Project intent was asked before the picker; current marketplace catalog plugin picker came third with
      intent-grounded recommendations, before Phase 0
- [ ] Phase 0 assessment done (new/existing, codebase/not, existing `.claude/` read and merged)
- [ ] Stack and compact project-detail interview complete; LSP binary prerequisites checked
- [ ] Bootstrap plan created in the session scratchpad; helper check and install both succeeded
- [ ] CLI-owned `enabledPlugins` left to `claude plugin install`; only non-plugin settings and portable
      marketplace declarations merged
- [ ] Live rules and structure notes written after the successful install
- [ ] Codebase map built via `map-codebase` (or deliberately skipped for a not-a-codebase project)
- [ ] One reload requested after all pre-reload work; user reloaded before Phase 4
- [ ] Every selected plugin verified installed, enabled, requested-scope, and usable; relevant hooks fire
- [ ] User told what they got and reminded to commit `.claude/`

## References

- `references/stack-plugins.md` — stack → installable plugins/marketplaces/LSP catalog
- `references/rule-templates.md` — craft-baseline and stack-specific starter live-rules, lift-ready
- `references/self-improvement.md` — the baked-in self-improvement live rule and how to install it
- `references/structure-notes.md` — the structure-notes template and when it's a real deliverable
- `references/clean-code-principles.md` — optional bundled digest for the guidelines-pointer rule
