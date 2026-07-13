---
name: map-codebase
description: >-
  Generate a structured, self-maintaining codebase map: a set of atomic Markdown docs in
  .claude/.codebase-info/ that ground every future Claude session in how the project is built.
  Use when the user asks to "map the codebase", "document the codebase", "create codebase
  documentation", "generate architecture docs", "onboard me to this project", "what does this
  codebase do", "bootstrap codebase docs", "set up codebase-mapper", or "analyze the project
  structure". Works for any language/stack and for both existing projects and brand-new or empty
  ones. To refresh an existing map after code changes, use update-codebase-map instead.
---

# Map Codebase

Generate a codebase map as a collection of **atomic documents** in `.claude/.codebase-info/`. Each
document covers one aspect of the project, so the map stays easy to read, update, and navigate. The
map is written for the next Claude session (and the next human): it is grounding context, not
marketing.

Loading is automatic and you don't have to wire anything up: this plugin ships a `SessionStart`
hook that injects the map at the start of each session, so Claude starts oriented and keeps
consulting and updating it as work goes on. **Never edit `CLAUDE.md`.** The hook is the only loading
mechanism; leave `CLAUDE.md` alone. Your job is just to write the docs in `.claude/.codebase-info/`.

## Output

```
.claude/.codebase-info/
├── INDEX.md                # Navigation hub + how-to-use; the hook injects this at session start
├── architecture.md         # System overview, components, boundaries, data flow
├── tech-landscape.md       # Languages, frameworks, runtimes, infra, source-of-truth files
├── directory-structure.md  # Annotated folder tree
├── entry-points.md         # Where execution starts (routes, CLIs, jobs, main files)
├── modules.md              # Key modules/packages: purpose, deps, exports
├── communication.md        # APIs, events, queues, external integrations   (if applicable)
├── database.md             # Schema, relationships, migrations              (if applicable)
├── dependencies.md         # Categorized packages                           (if applicable)
├── patterns.md             # Recurring patterns, error handling, testing, config
├── coding-style.md         # Conventions derived from linters + existing code
├── docker.md               # Containers / local dev environment             (if applicable)
├── onboarding.md           # Quick start + common tasks
└── .map-state.json         # Machine state (last-mapped commit + date) for staleness checks
```

**This list is a menu, not a checklist.** Create only the documents that earn their place in *this*
codebase, and feel free to go beyond the list when a project has a major aspect the standard docs do
not cover. Two directions:

- **Omit what does not apply.** Skip `database.md` if there's no datastore, `docker.md` if there are
  no containers, `dependencies.md` if there's no dependency manifest, and so on. A tiny project might
  only need `INDEX.md`, `architecture.md`, `tech-landscape.md`, and `onboarding.md`.
- **Add what the project actually warrants.** If a major aspect deserves its own doc and none of the
  standard names fit, create one (e.g. `ml-pipeline.md` for a training/inference flow, `cli-reference.md`
  for a tool with many subcommands, `realtime.md` for a websocket/event core, `iac.md` for substantial
  infrastructure-as-code). List any such doc in `INDEX.md` and in the state file the same as the rest.

The test for every doc, standard or not, is the same: would a future session be meaningfully faster
for having it? If yes, write it; if not, leave it out.

## Process

### Step 0 — Assess project state (decide the path)

Get the lay of the land first, then pick a path:

- Count real source files, ignoring noise (`.git/`, `node_modules/`, `vendor/`, `dist/`, `build/`,
  `target/`, `.venv/`, `__pycache__/`, `.next/`, lockfiles, generated code, minified assets).
- Roughly size the project (file count, lines, number of top-level areas).

Then branch:

- **Existing project with real code → full mapping.** Continue with Steps 1–8.
- **Greenfield (empty repo, scaffold only, or just a spec/README) → seed mapping.** Jump to the
  **Greenfield projects** section below, then do Step 8.
- **Large codebase (hundreds+ of source files) → parallelize.** See **Large codebases** below,
  then Steps 7–8.

Also check today's actual date (it's provided in the session context, or run `date`) so the
"Last Updated" stamps are real, not placeholders.

### Step 1 — Identify the stack

Read the project's manifest/config files to determine languages, frameworks, and tooling. See
`references/language-detection.md` for a broad map of signal files across ecosystems
(JS/TS, Python, Go, Rust, Java/Kotlin, .NET, Ruby, PHP, Swift, Elixir, C/C++, Dart/Flutter,
monorepos, and more). Note the framework(s) — they dictate where things live.

### Step 2 — Map the directory structure

List the tree (`git ls-files` in a git repo gives a clean, ignore-aware listing; otherwise `tree`
or a recursive list, skipping the noise dirs above). Identify the organizing principle:
- **Layer-based**: `controllers/`, `services/`, `models/`
- **Feature/domain-based**: `features/auth/`, `domains/billing/`
- **Hexagonal/clean**: `domain/`, `application/`, `infrastructure/`
- **Monorepo**: `packages/*`, `apps/*`, workspaces

### Step 3 — Find the entry points

Where does execution begin? Web routes, API routers, CLI command handlers, background workers/cron,
serverless handlers, library public exports, app `main`/bootstrap files, build/start scripts.

### Step 4 — Trace the key flows

For the 3–5 most important features, trace end to end: entry point → business logic → data layer →
external effects. Example: `POST /api/users` → `UserController.store()` → `UserService.create()` →
`users` table → `WelcomeEmail`. Note shared utilities and cross-cutting concerns (auth, logging,
validation, error handling).

### Step 5 — Catalog dependencies

From the manifest(s), categorize: **Core** (framework/runtime), **Data** (DB/ORM/cache),
**External** (API clients, third-party services), **Dev** (test/lint/build). Capture only what aids
understanding — don't transcribe the entire lockfile.

### Step 6 — Capture patterns & conventions

Recurring design patterns, error-handling approach, configuration/secrets management, logging and
observability, and testing structure. Derive coding style from linter/formatter configs
(`.eslintrc`, `ruff.toml`, `.editorconfig`, `rustfmt.toml`, etc.) **and** from what the code
actually does.

### Step 7 — Write the atomic documents

First decide the doc set: walk the aspects you found in Steps 1–6 and pick the documents this project
warrants (see "This list is a menu, not a checklist" above). Then create each one in
`.claude/.codebase-info/` using the templates in `references/document-templates.md`. For a
non-standard doc with no matching template, follow the same shape (title, `Last Updated` line, concrete
paths, tables/diagrams where they help). For each document:
- Put a real `*Last Updated: YYYY-MM-DD*` line under the title.
- Use concrete file paths (`src/auth/guard.ts`), not vague descriptions.
- Prefer tables for structured data (routes, modules, deps) and ASCII/Mermaid for architecture.
- Keep each doc self-contained but cross-link related docs.
- **Keep `INDEX.md` compact.** The hook injects it into context at the start of each session, so it should
  summarize the project in a few lines and link out to the detailed docs, which Claude reads on
  demand. Include the short "How to use / How to maintain this map" section from the template.

### Step 8 — Record state

Write `.claude/.codebase-info/.map-state.json` so `update-codebase-map` can detect staleness
precisely:

```json
{
  "tool": "codebase-mapper",
  "version": "2.1.0",
  "mappedAt": "YYYY-MM-DD",
  "gitCommit": "<full HEAD SHA, or null if not a git repo>",
  "documents": ["architecture.md", "tech-landscape.md", "..."]
}
```

Get the SHA with `git rev-parse HEAD` (use `null` if the project isn't a git repo). List exactly the
documents you created.

Finally, tell the user the map is ready, remind them to **commit `.claude/.codebase-info/`** so their
team and every future session share it, and note that the plugin's hook will surface it
automatically from now on.

## Greenfield projects

A brand-new or empty project has little to map yet — so seed the map with *intent* and let it grow:

1. Look for any existing intent: `README`, a spec/PRD, design notes, issues, or scaffolding.
2. If intent isn't written down anywhere, ask the user 2–3 brief questions: What are you building?
   What's the intended stack? Any key architectural decisions already made?
3. Create a **lean** map: `INDEX.md`, `architecture.md` (goals + intended design), `tech-landscape.md`
   (chosen/intended stack), `directory-structure.md` (planned layout), and `onboarding.md`. Mark it
   clearly as a greenfield seed that will grow.
4. Do Step 8 (write state). From here, `update-codebase-map` fills in the rest as real code lands.

## Large codebases

For hundreds or thousands of source files, don't try to read everything serially:

- Map the top-level structure first, then **fan out exploration in parallel** using the Task tool —
  e.g., one subagent per major area (`apps/web`, `services/api`, `packages/core`) or per document,
  each returning a concise structured summary. Consolidate their reports into the atomic docs.
- Favor breadth over exhaustive depth: capture each area's purpose, entry points, and key files
  rather than every file. The map is a guide, not a mirror.
- If you must sample rather than cover everything, say so in the relevant doc.

## Guidelines

- **Audience is a future Claude session.** Optimize for fast grounding and navigation.
- **Accuracy over completeness.** Every path and reference you write must exist. Don't invent.
- **Concrete, not abstract.** Real file paths, real command names, real table/route names.
- **Atomic + linked.** One concern per file; cross-reference rather than duplicate.
- **Never touch `CLAUDE.md`.** The plugin's hook handles loading. Do not add, edit, or remove
  anything in `CLAUDE.md` (or `CLAUDE.local.md`).
- **Respect ignore rules.** Never document `node_modules/`, `vendor/`, build output, or secrets.
- **Don't leak secrets.** Note that config exists and where, never actual credential values.

## Success criteria

- [ ] `.claude/.codebase-info/` created with `INDEX.md` + all applicable atomic docs
- [ ] `INDEX.md` is compact, links every created doc, and includes the how-to-use/maintain section
- [ ] Every doc has a real `Last Updated` date and verified file paths
- [ ] `.map-state.json` written with date, HEAD SHA (or null), and the document list
- [ ] `CLAUDE.md` left untouched
- [ ] User reminded to commit `.claude/.codebase-info/`

## References

- `references/document-templates.md` — templates for every document type
- `references/language-detection.md` — signal files for detecting stacks across ecosystems
