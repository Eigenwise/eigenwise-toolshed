---
name: init-workspace
description: >-
  Set up a complete Claude Code workspace for a project, new or existing. Runs a short interview, then
  writes .claude/ end to end: settings.json (enabling the right plugins for the stack), a tailored
  live-rules.md, a codebase map, and structure notes, wired around the plugin-reload boundary and
  verified firing. Use for WHOLE-workspace setup: "set up a Claude workspace", "init/bootstrap this
  project for Claude", "configure Claude Code for this repo", "set up .claude / the toolshed here",
  "get this project ready for Claude Code". Holistic orchestrator: it sequences codebase-mapper,
  live-rules, sidequest, skill-creator, and the built-in /init. Prefer it whenever the user wants the
  whole setup (for only a map use map-codebase; for only one rule use add-rule).
---

# Init Workspace

Set up a project's `.claude/` workspace end to end. You are an **orchestrator**: the pieces already
exist (codebase-mapper's `map-codebase`, live-rules, sidequest, `skill-creator`, the built-in
`/init`). Your job is to interview the user, write the glue that doesn't exist yet, sequence those
tools around the plugin-reload boundary, and verify the result actually works before you call it done.

Keep the whole thing **tech- and purpose-agnostic**: the logic below is generic. The stack-specific
choices come from `references/stack-plugins.md` (which plugins) and `references/rule-templates.md`
(which starter rules), plus whatever you detect in the repo. Never hard-code a stack into the flow.

## The shape of the job

There is one hard constraint that dictates everything: **enabling plugins in `settings.json` only
takes effect after Claude reloads them.** So the flow splits at a reload boundary:

1. **Assess** the project (Phase 0).
2. **Interview** the user (Phase 1).
3. **Pre-reload writes** — everything that needs no plugin loaded: `settings.json`, `live-rules.md`,
   structure notes, optional `CLAUDE.md` (Phase 2).
4. **Reload boundary** — stop, tell the user exactly what to run, wait for them to come back (Phase 3).
5. **Post-reload** — build the map, bring up the board, and **verify each hook actually fires**
   (Phase 4).
6. **Wrap up** — commit reminder and what they got (Phase 5).

Read `references/stack-plugins.md` and `references/rule-templates.md` before Phase 2; read
`references/self-improvement.md` and `references/structure-notes.md` when you reach those steps.

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

## Phase 1 — Interview

Keep it short and propose defaults from what you detected, so the user confirms rather than types
essays. Ask what you genuinely can't infer. A good compact set (adapt, don't recite):

1. **What is this project and who is it for?** One line. (Grounds the map seed and structure notes.
   For a greenfield repo this is the most important answer.)
2. **Stack** — confirm what you detected, and anything not yet visible (intended stack for
   greenfield; test framework; deploy target like Cloudflare/Vercel/AWS).
3. **Codebase or not?** Confirm your Phase 0 read ("this looks like a docs wiki, so I'll skip the
   codebase map, sound right?").
4. **Team or solo, and any existing conventions** worth encoding as rules (commit style, a
   CONTRIBUTING or STYLE doc to point a rule at, house preferences).
5. **Optional plugins** — surface the stack-appropriate extras from `references/stack-plugins.md` (a
   language server, a frontend/Cloudflare/testing plugin, `context7` for live docs) and let them
   pick. Don't enable a pile by default; propose the obviously-useful ones and ask.
6. **CLAUDE.md?** Do they want one seeded (you'll delegate to `/init`), or skip it?

Use the `AskUserQuestion` tool for the choices with clear options (stack extras, codebase-or-not,
CLAUDE.md yes/no); ask the open ones (what is this, conventions) in plain text. If the user said "just
set it up, use good defaults", take the sensible defaults and tell them what you picked.

## Phase 2 — Pre-reload writes

Everything here is plain file writing. No plugin needs to be loaded yet. Merge into existing files
where they exist.

### 2a. `.claude/settings.json`

Build it from `references/stack-plugins.md`. Always include:

- The **core**: `codebase-mapper` and `live-rules` (always), and `sidequest` unless the user opts out.
- The **toolshed marketplace** block under `extraKnownMarketplaces` so it resolves regardless of the
  user's global state.
- The **stack extras** the user chose in Phase 1.

Critical rules for this file:

- **Merge, don't replace.** If `settings.json` exists, add your keys into it; keep everything already
  there. `enabledPlugins` and `extraKnownMarketplaces` are objects, union them.
- **Only emit a marketplace `source` block you can trust.** The toolshed and Cloudflare sources are
  known (see the catalog). For a marketplace whose source you don't have confirmed (some are
  registered at the user's global level), enable the plugin but tell the user to run
  `/plugin marketplace add <...>` themselves rather than writing a guessed `repo`. A wrong source
  block is worse than none.
- **Validate** the JSON after writing (`node -e "JSON.parse(require('fs').readFileSync('.claude/settings.json','utf8'))"`).

### 2b. `.claude/live-rules.md`

Write the starter rules from `references/rule-templates.md`. Structure:

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

Keep bodies tight — they share the budget. Follow the live-rules format exactly (no bare `---` inside
a body; use `***`). If live-rules' `add-rule` skill is available you may use it, but hand-writing the
file is fine and needs no plugin loaded.

### 2c. Structure notes

Write a short `.claude/.codebase-info/structure.md` (or, for a not-a-codebase project, a top-level
note) capturing **how the project is meant to be laid out** — the organizing principle, where things
go, what belongs where. See `references/structure-notes.md`. This matters most for **greenfield**:
it's where intent gets written down before there's code for `map-codebase` to read. For an existing
codebase this is light (the map will cover structure); for greenfield it's a real deliverable.

### 2d. `CLAUDE.md` (optional)

If the user wanted one, **delegate to the built-in `/init`** rather than hand-rolling it. Note the
deliberate exception: every other toolshed plugin says never touch `CLAUDE.md`, because their hooks
handle injection. workspace-init is the one-time static setup, so seeding `CLAUDE.md` here is correct,
and the self-improvement loop is explicitly allowed to update it later. Say this out loud so it
doesn't read as breaking the house rule.

## Phase 3 — Reload boundary

Stop and hand off. Tell the user plainly:

> I've written `.claude/settings.json`, `.claude/live-rules.md`, and the structure notes. To load the
> plugins I just enabled, run **`/reload-plugins`** (or restart Claude Code if reload doesn't pick
> them up), then tell me to continue.

Then **wait for them.** Do not pretend the plugins are loaded and barrel into Phase 4 in the same
turn — the whole point is to verify against really-loaded plugins. When the user comes back, resume at
Phase 4. (If `/reload-plugins` turns out not to surface the newly-enabled plugins in-session, tell
them to do a full restart; treat this as an empirical check, not an assumption.)

## Phase 4 — Post-reload: build and verify

Now the plugins are live. Do the work that needed them, and **verify each piece empirically** — this
is the part that separates "wrote some files" from "set up a working workspace."

1. **Codebase map** (skip for a not-a-codebase project). Invoke `map-codebase`. For a big repo it
   fans out; for greenfield it seeds a lean map from the intent you captured. Confirm
   `.claude/.codebase-info/INDEX.md` exists.
2. **live-rules is injecting.** On this turn, confirm the live-rules content is actually in your
   context (the plugin injects a recognizable rules block on SessionStart and every prompt). If you
   can see your starter rules injected, it's wired. If not, the plugin isn't loaded — send the user
   back to reload/restart.
3. **codebase-mapper is injecting.** Same check: confirm the `INDEX.md` hub is being injected on the
   prompt. Seeing it in context is the proof the hook fired.
4. **sidequest board.** Bring up the board (`sidequest dashboard`, or ask the board skill) and report
   the URL, so the user sees the Kanban is live. Filing a throwaway ticket and deleting it is a fine
   smoke test.
5. **Optional plugins.** Sanity-check any stack extras loaded (a language server responding, `context7`
   resolvable). Don't over-verify; a quick confirmation is enough.

If any check fails, fix it (usually a merge mistake in `settings.json` or a rule scope that matches
nothing) and re-verify. Report what you confirmed, concretely, not "should work."

## Phase 5 — Wrap up

- Tell the user **exactly what they got**: which plugins are enabled, which rules are live (and that
  editing them takes effect next prompt), whether a map was built, and where the board is.
- **Commit reminder.** In a git repo, tell them to commit `.claude/` so the team and every future
  session share the setup. Offer to do it (ship-by-default if that's their preference).
- **Point at the self-improvement loop.** Remind them the workspace now nudges itself to improve after
  work, and that `retro` runs a deeper reflection pass on demand.

## Guidelines

- **Orchestrate, don't reinvent.** Use `map-codebase` for the map, `/init` for `CLAUDE.md`,
  `add-rule` / `skill-creator` where they fit. You write the glue and the sequencing.
- **Generic by construction.** No stack is baked into the flow. Everything stack-specific comes from
  the reference catalog, which you extend when you meet a stack it doesn't cover yet (that extension is
  itself a self-improvement move).
- **Never clobber.** Merge into existing `.claude/` files; a user's rules and config survive.
- **Verify against reality.** The success test is hooks firing in a really-loaded session, not files
  on disk. Watch them fire.
- **Respect the reload boundary.** Don't collapse Phases 2 and 4 into one turn.
- **Don't leak secrets.** Rules and notes say where config lives, never actual credential values.

## Success criteria

- [ ] Phase 0 assessment done (new/existing, codebase/not, existing `.claude/` read and merged)
- [ ] `.claude/settings.json` written/merged, valid JSON, core plugins + toolshed marketplace + chosen extras
- [ ] `.claude/live-rules.md` written with craft baseline + self-improvement rule + stack rules
- [ ] Structure notes written (a real deliverable for greenfield)
- [ ] Codebase map built via `map-codebase` (or deliberately skipped for a not-a-codebase project)
- [ ] Reload boundary respected; user reloaded before Phase 4
- [ ] Each piece verified firing: live-rules injecting, map injecting, board live
- [ ] User told what they got and reminded to commit `.claude/`

## References

- `references/stack-plugins.md` — stack → plugins/marketplaces/LSP catalog, and the source caveat
- `references/rule-templates.md` — craft-baseline and stack-specific starter live-rules, lift-ready
- `references/self-improvement.md` — the baked-in self-improvement live rule and how to install it
- `references/structure-notes.md` — the structure-notes template and when it's a real deliverable
- `references/clean-code-principles.md` — optional bundled digest for the guidelines-pointer rule
