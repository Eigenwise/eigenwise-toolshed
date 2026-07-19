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
artifact relies on them, and installed plugins take effect only after Claude reloads them. So the flow
splits at a reload boundary:

1. **Assess** the project (Phase 0).
2. **Interview and select plugins** (Phase 1).
3. **Install selected plugins, then write pre-reload artifacts** (Phase 2).
4. **Reload boundary** — stop, ask the user for one reload, and wait (Phase 3).
5. **Post-reload** — build the map, bring up the board, and verify every selected plugin is loaded and
   usable (Phase 4).
6. **Wrap up** — commit reminder and what they got (Phase 5).

Read `references/stack-plugins.md` and `references/rule-templates.md` before Phase 1; read
`references/self-improvement.md` and `references/structure-notes.md` when you reach those steps. Read
`references/observability.md` when the user chooses local telemetry.

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

## Phase 1 — Interview and selection

Keep it short and propose defaults from what you detected, so the user confirms rather than types
essays. Ask what you genuinely can't infer. A good compact set (adapt, don't recite):

1. **What is this project and who is it for?** One line. (Grounds the map seed and structure notes.
   For a greenfield repo this is the most important answer.)
2. **Stack** — confirm what you detected, and anything not yet visible (intended stack for
   greenfield; test framework; deploy target like Cloudflare/Vercel/AWS).
3. **Codebase or not?** Confirm your Phase 0 read ("this looks like a docs wiki, so I'll skip the
   codebase map, sound right?").
4. **Team or solo, and any existing conventions** worth encoding as rules (commit style, a
   `CONTRIBUTING` or style doc to point a rule at, house preferences).
5. **Plugins** — propose the core set from the catalog, then only the stack extras that fit. Let the
   user accept, drop, or add to that compact list. Explain install scopes only if the user asks; the
   default is project scope, local is only for an explicitly personal-per-repo choice, and user is
   only for an explicitly cross-project choice.
6. **CLAUDE.md?** Do they want one seeded (you'll delegate to `/init`), or skip it?
7. **Local telemetry?** Offer SQLite only, SQLite + optional loopback LGTM Docker viewer, or skip. Read
   `references/observability.md` after they choose; do not ask for telemetry content settings, endpoints, or secrets.

Use the `AskUserQuestion` tool for the choices with clear options (plugins, codebase-or-not,
`CLAUDE.md` yes/no); ask the open ones (what is this, conventions) in plain text. If the user said
"just set it up, use good defaults", select the proposed core and obviously useful stack extras and
tell them what you picked.

Before creating an LSP plugin plan, run its required binary check from the catalog. Report a missing
binary and its exact install hint, but never run a package manager yourself. Let the user either install
it, continue knowing code intelligence stays unavailable until they do, or drop that plugin.

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

### 2b. Optional local telemetry

If the user chose telemetry, follow `references/observability.md` now. Run its setup helper after the plugin
installer succeeds and before any reload request. On a partial telemetry failure, stop and give the exact
rerun command. Do not request reload or claim the workspace setup completed.

### 2c. Atomic live rules

After a successful install, write every starter rule as its own `.claude/live-rules/rules/<stable-name>.md`
file, then atomically write `.claude/live-rules/manifest.json`. Each entry has the relative rule path,
SHA-256 hash, and applicability metadata (`description`, `globs`, `dirs`, `prompt`, `enabled`). Use
the starter rules from `references/rule-templates.md`. Include:

- The **terse header** (naming the ~10k-char injection budget) above the first `---` fence.
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

If the user wanted one, **delegate to the built-in `/init`** rather than hand-rolling it. Note the
deliberate exception: every other toolshed plugin says never touch `CLAUDE.md`, because their hooks
handle injection. `init-workspace` is the one-time static setup, so seeding `CLAUDE.md` here is correct,
and the self-improvement loop is explicitly allowed to update it later. Say this out loud so it
doesn't read as breaking the house rule.

## Phase 3 — Reload boundary

All pre-reload writes and the complete installation must succeed before this boundary. Then request
one reload and wait:

> The selected plugins are installed and the workspace files are ready. Run **`/reload-plugins`**, then
tell me to continue. If Claude Code refuses because the reload changes MCP or LSP servers, run
**`/reload-plugins --force`**. Restart Claude Code only if reload still does not load them.

Do not request an earlier or second reload. Do not pretend the plugins are loaded and barrel into
Phase 4 in the same turn — the whole point is to verify against really-loaded plugins.

## Phase 4 — Post-reload: build and verify

Now the plugins are live. First run `claude plugin list --json` and confirm every selected plugin is
installed, enabled, and at its requested scope. Then do the work that needed them and verify each piece
empirically — this is the part that separates "wrote some files" from "set up a working workspace."

1. **Codebase map** (skip for a not-a-codebase project). Invoke `map-codebase`. For a big repo it
   fans out; for greenfield it seeds a lean map from the intent you captured. Confirm
   `.claude/.codebase-info/INDEX.md` exists.
2. **live-rules is injecting.** On this turn, confirm the live-rules content is actually in your
   context (the plugin injects a recognizable rules block on SessionStart and every prompt). If you
   can see your starter rules injected, it's wired. If not, the plugin isn't loaded — send the user
   back to reload/restart.
3. **codebase-mapper is injecting.** Same check: confirm the `INDEX.md` hub is being injected on the
   prompt. Seeing it in context is the proof the hook fired.
4. **sidequest board.** If selected, bring up the board (`sidequest dashboard`, or ask the board skill)
   and report the URL, so the user sees the Kanban is live. Filing a throwaway ticket and deleting it
   is a fine smoke test.
5. **Optional plugins.** Verify each selected extra is usable: an LSP responds and its binary is on
   `PATH`, a named skill resolves, or its documented integration opens. Keep it quick, but verify every
   selected plugin rather than assuming a loaded entry works.

If any check fails, fix it (usually a settings merge mistake, an unavailable prerequisite, or a rule
scope that matches nothing) and re-verify. Report what you confirmed, concretely, not "should work."

## Phase 5 — Wrap up

- Tell the user **exactly what they got**: which plugins are enabled, which rules are live (and that
  editing them takes effect next prompt), whether a map was built, and where the board is.
- **Commit reminder.** In a git repo, tell them to commit `.claude/` so the team and every future
  session share the setup. Offer to do it (ship-by-default if that's their preference).
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
- [ ] Phase 0 assessment done (new/existing, codebase/not, existing `.claude/` read and merged)
- [ ] Stack and compact selected-plugin interview complete; LSP binary prerequisites checked
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
