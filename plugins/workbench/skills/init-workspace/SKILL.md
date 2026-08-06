---
name: init-workspace
description: >-
  Set up a complete Claude Code workspace for a new or existing project. Use for workspace setup,
  .claude configuration, project bootstrap, or Toolshed installation.
---

# Init Workspace

Set up a project's `.claude/` workspace end to end. You are an **orchestrator**: the pieces already
exist (codebase-mapper's `map-codebase`, live-rules, sidequest, `skill-creator`, the built-in
`/init`, and Workbench's bootstrap installer). Your job is to interview the user, make the installer
plan, sequence workspace artifacts around the plugin-reload boundary, and verify the result actually
works before you call it done.

The only prerequisite is **Workbench installed at user scope**. If it is not installed, stop and give
the user the Install commands from the Workbench README. If Workbench is installed only at project scope,
say that `init-workspace` requires the user-scope install and tell them to reinstall it at user scope before
rerunning this skill. Do not install Workbench as part of generated project settings.

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
steps. The Observability plugin's `enable-project-telemetry` skill owns telemetry mechanics, setup, and
verification, including its own reference doc and command paths. This skill never runs observability
commands directly, because they live under a different plugin root.

## Before Phase 0 — Toolshed setup

### Orientation

Before the telemetry question, open with a short plain-language orientation in the user's terms. Cover the
substance without reciting a fixed script: you will ask a few setup questions, show the proposed install and
stop for approval, install the chosen plugins, request one reload, then build and verify the workspace. Say it
usually takes about 10–20 minutes, with large existing codebases taking longer to map. Explain that setup
merges into the project's `.claude/` directory and never overwrites existing Claude config; name
`~/.claude/settings.json` as the one possible global write when the compaction window is configured. Promise
to name the concrete files before each write and to stop for confirmation before installing anything.

Every user-facing question below must include one short sentence saying why the answer matters. Keep that
reason in the question itself, not in follow-up prose, and adapt the wording to the project rather than turning
the flow into a script.

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
prompt or response text, code or file contents, tool inputs or results, credentials, or environment values. This
helps you inspect local usage and cost without exposing project content."**

- **Yes:** install the Observability plugin at user scope if it is not already installed
  (`/plugin install observability@eigenwise-toolshed --scope user`, then one reload), and hand off to
  `/observability:enable-project-telemetry`; it owns consent confirmation, setup, and verification. After it
  finishes, stop. Tell the user to restart Claude Code because its OTEL settings only apply to a new session,
  and to come back with `claude --continue` (or `claude --resume` and pick this session) rather than a fresh
  `/workbench:init-workspace`. Resuming carries this conversation's answers across the restart; a fresh run
  starts the skill over and has to recover them from the bootstrap plan. Do not assess the project or ask the
  plugin question first.
- **No:** continue immediately to the project-intent question. Do not ask again during this run.

A telemetry restart also satisfies a pending plugin reload boundary. Re-entry normally arrives as a resumed
session that still holds the earlier answers; when it arrives as a fresh run instead, read the bootstrap plan
before asking anything. Either way, detect the completed telemetry setup and continue with the project-intent
question, picker, or later phase without repeating answered setup questions.

### Project intent

Ask this plain-text question before listing any plugin options: **"What is this project for, and who is
it for? One or two lines is plenty. This lets me recommend only the setup that fits your project."** For a
non-empty repo, first inspect only enough of the visible
project signals to pair the question with a useful inference, such as "I see a Rust audio-plugin project;
what does it make and who uses it?" Keep that inference tentative and let the user correct it.

Keep the answer in the session/bootstrap plan. On re-entry, use a previously captured answer rather than
asking again. A telemetry restart does not create an answer because this question happens after the restart.

### Plugin picker

Ask this third, before Phase 0. Read the current Toolshed marketplace manifest and
`references/stack-plugins.md`, then offer the available plugins with a one-line plain-language description
and a recommendation grounded in the stated project purpose and any visible stack signals. In the picker
question, say that this choice decides which workspace tools will be installed and verified. Say why when
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

### Recurring work and capabilities

When Sidequest is selected, build the routing input before proposing any category. Inspect what is actually
visible: existing skills, the folder taxonomy, file types, maintenance scripts, and the stated project purpose.
Turn those signals into a short list in this form: **"This project repeatedly needs X, which takes capability
Y."** Ask the user to confirm or correct the list, and say in the question that the accepted capabilities
will determine which Sidequest categories the project gets. Record the accepted list in the session/bootstrap
plan. Derive project-profile categories from this list, never from the starter's existing category set.

### Routing profile

When Sidequest is selected, make one routing choice immediately after the capability step and before the Phase 1
interview. Infer a starter from plain repo signals: code and build files → `coding`; docs, posts, or
content → `writing`; source corpora, datasets, or citation-heavy material → `research`; audio, scores,
or music-production files → `creative-music`. If signals conflict, choose the closest fit and say why.

Use one `AskUserQuestion` that proposes the inferred starter and offers: **Use this profile**, **Choose
another starter**, or **Make a project profile**. In the question, say that the profile controls which models
and effort levels future Sidequest work uses. Keep it conversational: do not turn category routing into
a form or walk through every category. If the user chooses another starter, show the available profiles from
`sidequest profile list` and let them name one in plain text. Record the accepted profile choice in the
session/bootstrap plan; if Sidequest was not selected, skip this step.

For **Make a project profile**, derive the final category set from the accepted recurring-work and capability
list plus the stated project purpose. Consult the closest starter as a reference for category shape and useful
precedent, never as the category baseline. Removing an inherited category is as normal as adding one. For every
category in the proposed final set, state why this project needs it and why its model and effort fit that work.
Remove anything you cannot justify; **"it came with the starter" is not a justification.** Give every derived
category a non-empty `contract` with standing instructions for its executor, and set its complete policy:
route, `contract`, `readonly`, and `artifactRoots`. A route without a contract is half-configured. Let the user
confirm or tweak the complete set in plain language; in that question, say the accepted set becomes this
project's Sidequest routing policy.

Create `<project>-routing` by cloning the closest starter for the profile plumbing, then reconcile the clone to
the confirmed final set and select it for the board:

```sh
sidequest profile create <project>-routing --from <starter> --description "<confirmed purpose>"
sidequest profile use <project>-routing --project <board>
```

Apply every profile-category add, edit, or removal with `--profile <project>-routing`, never `--profile
<starter>`. A starter is shared policy and setup must never mutate it. Do not create a project profile when the
user accepts or picks a starter. Keep the selected profile and confirmed final category set in the plan; Phase 4
applies the profile after Sidequest creates or opens the board.

### Executor worktree isolation

When Sidequest is selected, after recording the routing choice and before the Phase 1 interview, ask this
plain-text question: **"Should dispatched executors use isolated git worktrees here? I recommend keeping
them on. Choose the shared checkout when the project's outputs need to appear in this working tree, or when
parallel worktrees have caused problems here."** Keep it conversational rather than turning it into a menu.

Record the accepted choice in the session/bootstrap plan alongside the routing choice. Default to isolated
worktrees when the user accepts the recommendation or asks for good defaults. Use the shared checkout only
when they explicitly choose it. If Sidequest was not selected, skip this question.

## Phase 1 — Interview and selection

Model Gateway is a user-scope plugin and its wiring is global-only, so there is no per-project gateway
choice to make. Say this plainly before wiring it. If the gateway is unwired, invoke
`/model-gateway:model-gateway` and use its `env --write-user` command, then record the wiring result in the
session/bootstrap plan. Do not invoke a bare `codex-gateway` shell command, since the installed plugin command
is not on PATH. If the user enables Remote Control compatibility, explain first that the Codex/Grok rows
disappear from `/model`; explicit ids such as `/model claude-gpt-5.6-terra` still work and persist as the
default, and disabling compatibility restores the rows.

### Compaction configuration

Ask one `AskUserQuestion` that explicitly records both settings before any write. In the question, say that
the compaction window writes to the global `~/.claude/settings.json` and affects every project, while the
Sidequest policy writes to this project's `.claude/settings.local.json`; these choices decide when long
sessions compact and how Sidequest protects board state. On re-entry, read
`~/.claude/settings.json` and the project's `.claude/settings.local.json` first. Show the global
`autoCompactWindow` and the project's `SIDEQUEST_COMPACTION_POLICY` values. An absent window means
**leave default**. If the project file has a leftover `autoCompactWindow`, explain that it overrides the
global preference and offer to remove it. An unset policy has the same behavior as **pin**, but still ask
the user to choose and write the selected value. Never silently apply either recommendation.

- **Auto-compact window:** **recommended 350000 (trigger ~317k)**, **aggressive 250000 (trigger
  ~217k)**, **leave default (on 1M-pinned models auto-compact effectively never fires: trigger = window
  - 33k)**, or **custom 100000-1000000**. Custom values are numbers; normalize them through the helper,
  which clamps them to that inclusive range. Choosing leave default removes `autoCompactWindow` from
  `~/.claude/settings.json`.
- **Sidequest compaction policy:** **pin** (board-state pinning in compaction summaries, safe default),
  **veto** (pinning plus block mid-wave compaction), or **off**. Warn before accepting **veto** that it is
  experimental until the US-40 spike verdict confirms hook blocks do not trip Claude Code's auto-compact
  failure breaker. Keep this in the project `env` block: project environment settings mask global env, so
  global env is not a reliable carrier.

Store the explicit choices, including whether to remove a leftover project window, in the session/bootstrap
plan. This stays one compact configuration step, not a wizard.

Keep it short and propose defaults from what you detected, so the user confirms rather than types
essays. The project-intent answer was collected before the picker; use it to seed the map and structure
notes, and do not ask it again. Ask what you genuinely can't infer. A good compact set (adapt, don't
recite):

1. **Stack** — confirm what you detected, and anything not yet visible (intended stack for
   greenfield; test framework; deploy target like Cloudflare/Vercel/AWS). Say in the question that this
   determines the relevant plugin prerequisites, starter rules, and verification commands.
2. **Codebase or not?** Confirm your Phase 0 read ("this looks like a docs wiki, so I'll skip the
   codebase map, sound right?"). Say that the answer decides whether setup builds and maintains a codebase map.
3. **Team or solo, and any existing conventions** worth encoding as rules (commit style, a
   `CONTRIBUTING` or style doc to point a rule at, house preferences). Say that this keeps future sessions
   and collaborators following the same project conventions.
4. **Stack extras** — recommend only missing catalog plugins that fit the confirmed project. Keep the
   picker selection unless the user changes it; do not repeat the broad Toolshed plugin question. Say that
   only confirmed extras will be added to the install plan.
5. **CLAUDE.md?** Recommend a lightweight static one seeded through `/init`; they can skip it for now if they
   prefer. Either answer keeps the live-rules plan. Say that this choice decides whether setup creates
   always-loaded project context; live rules still handle conditional behavioral enforcement.

Use the `AskUserQuestion` tool for the choices with clear options (stack extras, codebase-or-not,
`CLAUDE.md` yes/no); ask the open ones (what is this, conventions) in plain text. If the user said
"just set it up, use good defaults", keep their picker selection and add only obviously useful missing
stack extras.

Before creating an LSP plugin plan, run its required binary check from the catalog. Report a missing
binary and its exact install hint, but never run a package manager yourself. Let the user either install
it, continue knowing code intelligence stays unavailable until they do, or drop that plugin. In the question,
say that this choice decides whether setup can verify that plugin's code intelligence now.

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
  Enable agent teams in the project's `.claude/settings.local.json` with the merge-safe helper:

  ```sh
  node -e "const { enableAgentTeams } = require(process.env.CLAUDE_PLUGIN_ROOT + '/lib/project-settings.js'); enableAgentTeams(process.cwd());"
  ```

  This adds `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1"` without replacing existing `env` keys. Never
  write it to shared `.claude/settings.json`.

Run the helper's read-only pass first, then show the user the install delta and a concrete write preview before
touching project or global configuration. Name every planned path from the bootstrap plan, including the
project's `.claude/` files, optional root `CLAUDE.md` or `.gitignore`, and the global
`~/.claude/settings.json` compaction exception when selected; also say which existing files will be merged and
left intact. Ask for approval before installation, with one sentence that the answer matters because the next
step installs the selected plugins and writes exactly this listed configuration. The LSP checks already run
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
a reload, or claim the workspace setup completed after a partial install. After a successful result, merge the plan's non-plugin settings without replacing existing values, then
apply the recorded compaction choices with Workbench's merge-safe helper:

```sh
node -e "const { configureSidequestCompaction } = require(process.env.CLAUDE_PLUGIN_ROOT + '/lib/project-settings.js'); configureSidequestCompaction(process.cwd(), { autoCompactWindow: <recorded window or null>, policy: '<recorded policy>', removeProjectAutoCompactWindow: <recorded true or false> });"
```

Run it only against the target project directory. It writes the selected window to
`~/.claude/settings.json`, preserving its existing keys including `env`, `enabledPlugins`, and
`marketplaces`; this is the one approved global-settings exception. It writes only
`SIDEQUEST_COMPACTION_POLICY` to the project's `.claude/settings.local.json` `env` block, preserving
unknown top-level keys and every existing `env` entry. If accepted, it also removes that project's leftover
`autoCompactWindow` override. Both files stay unchanged on an idempotent re-run. Continue with the other
pre-reload artifacts.

### 2b. Telemetry and reload handling

Telemetry is never enabled in this phase. When the user enabled it before Phase 0, the required session
restart happens before this phase and satisfies this reload boundary too. Otherwise, request the single
plugin reload in Phase 3.

### 2c. Atomic live rules

After a successful install, pin the hashed workspace artifacts to LF in the project-root `.gitattributes`. Create it when absent; otherwise preserve its content and add only missing entries:

```gitattributes
.claude/live-rules/rules/*.md text eol=lf
.claude/live-rules/rules/**/*.md text eol=lf
.claude/.codebase-info/*.md text eol=lf
.claude/.codebase-info/**/*.md text eol=lf
```

Then write the rules this project needs, using `references/rule-templates.md` as
reference material rather than a catalog to copy from. Create a new workspace's `.claude/live-rules/`
directory directly. Write every accepted project rule as one
`.claude/live-rules/rules/<stable-name>.md` file, then atomically write
`.claude/live-rules/manifest.json`. Follow the exact individual-rule and manifest format in the reference:
every manifest entry needs its relative rule path, the SHA-256 hash of the UTF-8 rule file with `\r` bytes
removed, and applicability metadata (`description`, `globs`, `dirs`, `prompt`, `priority`, `enabled`,
`include`) derived for this project. Generate and validate those hashes mechanically, never by hand. A fresh workspace never creates
`.claude/live-rules.md`.

- Write the **craft baseline** (global, `priority` 90–100): atomic commits / two hats, simple design,
  surgical/Karpathy directive, verify-before-done, no-inline-comments/naming. Ship these on every
  workspace.
- Write the **self-improvement rule** from `references/self-improvement.md`, the baked-in loop. Ship it on
  every workspace.
- Write any other rule only when a visible project signal justifies it, such as an existing file, a confirmed
  stack choice, a maintenance script, or a stated convention. Scope it with the appropriate `globs`, `dirs`,
  or `prompt`; do not ship a catalog rule because it might become useful later.
- Optionally write the **guidelines-pointer** rule and copy `clean-code-principles.md` if the user wants the
  deeper digest available (copy `references/clean-code-principles.md` into `.claude/`).

Derive every generated rule's wording for this project and make it conform to the project's own voice and
style rules. Compare generated text with the relevant template blocks: byte-identical output means the rule
was copied instead of derived, so rewrite it for this project or drop it.

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
**`/reload-plugins --force`**. Restart Claude Code only if reload still does not load them, and come back
with `claude --continue` so this run keeps its answers instead of starting over.

Do not request an earlier or second reload. Do not pretend the plugins are loaded and barrel into
Phase 4 in the same turn — the whole point is to verify against really-loaded plugins.

## Phase 4 — Post-reload: build and verify

Now the plugins are live. First run `claude plugin list --json` and confirm every selected plugin is
installed, enabled, and at its requested scope. Then do the work that needed them and verify each piece
empirically — this is the part that separates "wrote some files" from "set up a working workspace."

1. **Telemetry.** When the project opted in, invoke `/observability:enable-project-telemetry` and let it
   re-verify. It owns the verification command, which lives under its own plugin root.
   `found` verifies telemetry. With a healthy observer, `not-found` means **configured, pending first export**.
   Report it as unverified and give the user that skill to run later. Do not schedule another re-check.
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
   it. Then call `board_config` for this board with `worktreeIsolation: true` for isolated worktrees or
   `worktreeIsolation: false` for the shared checkout, using the choice recorded in the plan. Confirm the
   returned setting. Report the URL, selected profile, and executor checkout choice, so the user sees the
   Kanban and its routing policy are live.
6. **Optional plugins.** Verify each selected extra is usable: an LSP responds and its binary is on
   `PATH`, a named skill resolves, or its documented integration opens. Keep it quick, but verify every
   selected plugin rather than assuming a loaded entry works.

If any check fails, fix it (usually a settings merge mistake, an unavailable prerequisite, or a rule
scope that matches nothing) and re-verify. Report what you confirmed, concretely, not "should work."

## Phase 5 — Wrap up

- Tell the user **exactly what they got**: which plugins are enabled, which rules are live (and that
  editing them takes effect next prompt), whether a map was built, where the board is, and Model Gateway
  wiring as `wired` or `not wired` with its mode. For `not wired`, include the model-gateway skill's exact
  `env --write-user` recovery command for global mode.
- Give a practical handover using only the tools that were selected and verified. Tell them they can say
  "build/add/implement ..." or run `/sidequest:user-story` for feature work when Sidequest is enabled; run
  `/codebase-mapper:update-codebase-map` after structural code changes when a map exists; ask to "add a live
  rule for ..." or run `/live-rules:add-rule` for a new project rule; and run `/playbook:retro` for a deeper
  workspace reflection. Also name `/workbench:workbench-doctor` for health checks and
  `/workbench:update-toolshed` for updates. Keep this as a short next-actions list, not another inventory.
- **Commit reminder.** If the project is a git repo, tell them to commit `.claude/` so the team and
  every future session share the setup. Offer to do it (ship-by-default if that's their preference). If
  they declined Git setup, say once that the workspace is uncommitted and that they can run `git init`,
  add a stack-appropriate `.gitignore`, then commit `.claude/` when they want to back it up.
- **Send them to the docs, and say why it matters.** Most people skip the docs for a plugin, and these
  plugins punish that: they route work to other models, write config into the project, and inject context
  on every prompt. Point at https://eigenwise.github.io/eigenwise-toolshed/getting-started/ and name the
  specific page for each plugin you just installed, so the link is one click from something they now have.
  Say plainly that this handover is the short version and the guides cover the behavior they'll actually
  hit. Do not bury this in a list of other links.

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
- [ ] The user received the short orientation before the first question, including order, timing, merge-only
      behavior, install approval, reload, and verification
- [ ] Every user-facing question included one sentence explaining why the answer matters
- [ ] Before each write, the user was told the concrete paths; the compaction question and write preview named
      `~/.claude/settings.json` as the one global-settings exception
- [ ] Telemetry consent was the first question; a yes completed the telemetry flow and restarted Claude Code
      before resuming
- [ ] Project intent was asked before the picker; current marketplace catalog plugin picker came third with
      intent-grounded recommendations, before Phase 0
- [ ] Phase 0 assessment done (new/existing, codebase/not, existing `.claude/` read and merged)
- [ ] When Sidequest is selected, recurring jobs and required capabilities were confirmed before routing; routing
      profile and executor checkout choice were recorded in the bootstrap plan
- [ ] Every derived category is justified by this project's recurring work and by its selected model and effort;
      every one has a non-empty `contract` and complete `readonly` and `artifactRoots` policy
- [ ] Stack and compact project-detail interview complete; LSP binary prerequisites checked
- [ ] Bootstrap plan created in the session scratchpad; helper check and install both succeeded
- [ ] CLI-owned `enabledPlugins` left to `claude plugin install`; only non-plugin settings and portable
      marketplace declarations merged
- [ ] Live rules and structure notes written after the successful install; every rule beyond the craft baseline
      and self-improvement rule is justified by an observed project need, and every generated rule follows the
      project's voice and style and is not byte-identical to a template block
- [ ] Codebase map built via `map-codebase` (or deliberately skipped for a not-a-codebase project)
- [ ] One reload requested after all pre-reload work; user reloaded before Phase 4
- [ ] Every selected plugin verified installed, enabled, requested-scope, and usable; relevant hooks fire
- [ ] User told what they got and reminded to commit `.claude/`

## References

- `references/stack-plugins.md` — stack → installable plugins/marketplaces/LSP catalog
- `references/rule-templates.md` — craft-baseline and stack-specific live-rule reference material
- `references/self-improvement.md` — the baked-in self-improvement live rule and how to install it
- `references/structure-notes.md` — the structure-notes template and when it's a real deliverable
- `references/clean-code-principles.md` — optional bundled digest for the guidelines-pointer rule
